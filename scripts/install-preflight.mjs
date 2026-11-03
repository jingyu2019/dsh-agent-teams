#!/usr/bin/env node
/**
 * Read-only install preflight for one DSH profile.
 *
 * Answers two questions before an upgrade runs:
 *   1. Is the requested plugin already installed at an acceptable version?
 *   2. Is the exact DSH host cohort already present, or would this need the
 *      registry?
 *
 * Local file artifacts also report their SHA-256 so an operator can compare a
 * downloaded tarball against the release digest. Nothing here writes to the
 * profile, runs a package manager, or reads credentials.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function locatePackage(name, from) {
  let directory = resolve(from)
  for (;;) {
    const candidate = join(directory, 'node_modules', name, 'package.json')
    if (existsSync(candidate)) return realpathSync(candidate)
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

/** Compare an installed version against an exact spec or a simple range. */
export function versionSatisfies(version, spec) {
  if (spec.startsWith('file:') || spec.startsWith('link:')) return undefined
  const exact = /^(\d+)\.(\d+)\.(\d+)(?:-[\w.]+)?$/.exec(spec)
  if (exact !== null) return version === spec
  // Bounded comparison: rc.4 < rc.5, and 0.1.30 > 0.1.29.
  const compare = (a, b) => {
    const left = a.split(/[.-]/).map(part => /^\d+$/.test(part) ? Number(part) : part)
    const right = b.split(/[.-]/).map(part => /^\d+$/.test(part) ? Number(part) : part)
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
      const x = left[index]; const y = right[index]
      if (x === y) continue
      if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1
      if (x === undefined) return -1
      if (y === undefined) return 1
      return String(x) < String(y) ? -1 : 1
    }
    return 0
  }
  const range = /^>=?\s*(\S+)$/.exec(spec) ?? /^(\S+)$/.exec(spec)
  if (range !== null && !/^[0-9]/.test(range[1])) {
    if (spec === 'latest' || spec === '*' || spec === '') return version !== undefined
  }
  if (spec === 'latest' || spec === '*' || spec === '') return version !== undefined
  const greater = /^>=\s*(\S+)$/.exec(spec)
  if (greater !== null) return compare(version, greater[1]) >= 0
  const caret = /^\^(\d+)\.(\d+)\.(\d+)/.exec(spec)
  if (caret !== null) {
    const [major, minor, patch] = caret.slice(1).map(Number)
    const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
    if (parts === null) return false
    const [major2, minor2, patch2] = parts.slice(1).map(Number)
    if (major2 !== major) return false
    // ^0.1.20 means >=0.1.20 <0.2.0; only a zero major is constrained by minor.
    return major2 > 0 ? true : minor2 === minor && patch2 >= patch
  }
  const tilde = /^~(\d+\.\d+\.\d+)/.exec(spec)
  if (tilde !== null) {
    const base = tilde[1]
    return version === base || version.startsWith(`${base.split('.').slice(0, 2).join('.')}.`)
  }
  return undefined
}

/**
 * Inspect one profile without modifying it.
 * @param {{ profileRoot: string, hostRoot?: string, pluginName?: string, hostName?: string }} input
 */
export function inspectInstallPreflight(input) {
  const profileRoot = resolve(input.profileRoot)
  const pluginName = input.pluginName ?? '@nanmicoder/dsh-agent-teams'
  const hostName = input.hostName ?? '@deepseek-ai/dsh'
  const manifestPath = join(profileRoot, 'package.json')
  if (!existsSync(manifestPath)) throw new Error(`profile manifest not found: ${manifestPath}`)
  const manifest = readJson(manifestPath)
  const spec = manifest.dependencies?.[pluginName] ?? manifest.devDependencies?.[pluginName]
  if (typeof spec !== 'string') throw new Error(`profile does not declare ${pluginName}`)

  const installedPath = locatePackage(pluginName, profileRoot)
  const installed = installedPath === undefined ? undefined : readJson(installedPath)
  const problems = []
  const notes = []

  let artifact
  if (spec.startsWith('file:')) {
    const path = resolve(profileRoot, spec.slice('file:'.length))
    if (!existsSync(path)) problems.push(`local artifact is missing: ${path}`)
    else {
      const info = statSync(path)
      artifact = { path, bytes: info.size, sha256: sha256File(path) }
      notes.push('Local artifact digest is computed from the exact file the profile will install.')
    }
  } else if (spec.startsWith('link:')) {
    const path = resolve(profileRoot, spec.slice('link:'.length))
    if (!existsSync(path)) problems.push(`linked package is missing: ${path}`)
    else artifact = { path, link: true }
  } else {
    artifact = { registrySpec: spec }
  }

  const satisfied = installed === undefined ? false : versionSatisfies(installed.version, spec) ?? true
  if (installed === undefined) {
    problems.push(`${pluginName} is not installed in this profile`)
  } else if (!satisfied) {
    problems.push(`installed ${pluginName}@${installed.version} does not satisfy ${spec}`)
  }

  const hostPath = input.hostRoot === undefined
    ? locatePackage(hostName, profileRoot)
    : locatePackage(hostName, resolve(input.hostRoot))
  let cohort
  if (hostPath === undefined) {
    cohort = { exact: false, reason: 'host package not found in the profile resolution path' }
    notes.push('Cohort availability is unknown without the host package.')
  } else {
    const host = readJson(hostPath)
    const dshPackages = []
    const visit = (path, seen) => {
      const real = realpathSync(path)
      if (seen.has(real)) return
      seen.add(real)
      const pkg = readJson(real)
      if (pkg.name === hostName || pkg.name?.startsWith('@deepseek-ai/dsh-')) {
        dshPackages.push({ name: pkg.name, version: pkg.version })
      }
      for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })) {
        const dependency = locatePackage(name, dirname(real))
        if (dependency !== undefined) visit(dependency, seen)
      }
    }
    const seen = new Set()
    try {
      visit(hostPath, seen)
      const mixed = dshPackages.filter(pkg => pkg.version !== host.version)
      cohort = { hostVersion: host.version, packages: dshPackages.length, exact: mixed.length === 0, mixed }
      if (mixed.length > 0) problems.push(`${mixed.length} resolved DSH packages differ from host ${host.version}`)
    } catch (error) {
      cohort = { exact: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  const action = problems.length === 0
    ? 'none'
    : artifact?.registrySpec === undefined ? 'install-local-artifact' : 'registry-fetch-required'
  return {
    ok: problems.length === 0,
    profileRoot,
    plugin: {
      name: pluginName,
      spec,
      ...(installed === undefined ? {} : { installedVersion: installed.version, installedPath: dirname(installedPath) }),
    },
    ...(artifact === undefined ? {} : { artifact }),
    cohort,
    action,
    problems,
    notes: [
      ...notes,
      'This preflight never runs a package manager or writes to the profile.',
      'A registry tag such as latest still depends on the registry release-age policy; re-resolve after publication.',
    ],
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    let profileRoot = process.cwd()
    let hostRoot
    let json = false
    for (let index = 2; index < process.argv.length; index++) {
      const arg = process.argv[index]
      if (arg === '--json') json = true
      else if (arg === '--profile-root' || arg === '--host-root') {
        const value = process.argv[++index]
        if (!value || value.startsWith('--')) throw new Error(`${arg} requires a directory`)
        if (arg === '--profile-root') profileRoot = value
        else hostRoot = value
      } else throw new Error('Usage: dsh-agent-teams-install-preflight [--profile-root dir] [--host-root dir] [--json]')
    }
    const result = inspectInstallPreflight({ profileRoot, hostRoot })
    console.log(json ? JSON.stringify(result, null, 2) : [
      `Profile: ${result.profileRoot}`,
      `Plugin: ${result.plugin.name}@${result.plugin.installedVersion ?? '(not installed)'} (${result.plugin.spec})`,
      ...(result.artifact?.sha256 === undefined ? [] : [`Artifact SHA-256: ${result.artifact.sha256}`]),
      `Exact host cohort: ${result.cohort.exact === true ? 'present' : 'incomplete'}`,
      `Action: ${result.action}`,
      ...result.problems.map(problem => `FAIL: ${problem}`),
      ...result.notes,
    ].join('\n'))
    if (!result.ok) process.exitCode = 1
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
