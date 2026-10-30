#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const TOP_LEVEL_KEYS = new Set([
  '$schema', 'manifestVersion', 'id', 'name', 'version', 'license', 'source',
  'facets', 'requires', 'permissions', 'contributes', 'subscriptions',
])
const ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/u
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonempty(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function onlyKeys(value, allowed, path, errors) {
  if (!isRecord(value)) return false
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${path} has unsupported key ${key}`)
  }
  return true
}

/** Validate the structural subset used by dsh-std / Community Admission v0.15. */
export function validateManifest(manifest) {
  const errors = []
  if (!onlyKeys(manifest, TOP_LEVEL_KEYS, 'manifest', errors)) return ['manifest must be an object']
  for (const key of ['$schema', 'manifestVersion', 'id', 'name', 'version', 'license', 'source', 'facets', 'requires', 'permissions', 'subscriptions']) {
    if (!Object.hasOwn(manifest, key)) errors.push(`manifest.${key} is required`)
  }
  if (manifest.$schema !== 'https://dsh.dev/schemas/dsh-plugin-0.15.schema.json') {
    errors.push('manifest.$schema must identify dsh-plugin-0.15.schema.json')
  }
  if (manifest.manifestVersion !== '0.15') errors.push('manifest.manifestVersion must be 0.15')
  if (!nonempty(manifest.id) || !ID_RE.test(manifest.id)) errors.push('manifest.id must be a namespaced lowercase identifier')
  if (!nonempty(manifest.name)) errors.push('manifest.name must be non-empty')
  if (!nonempty(manifest.version) || !VERSION_RE.test(manifest.version)) errors.push('manifest.version must be an exact semver')
  if (!nonempty(manifest.license)) errors.push('manifest.license must be non-empty')
  if (!nonempty(manifest.source) || !/^(?:npm:|git\+[a-z]+:\/\/|https?:\/\/)/u.test(manifest.source)) {
    errors.push('manifest.source must be an npm, git, or https source')
  }

  if (onlyKeys(manifest.facets, new Set(['host']), 'manifest.facets', errors)) {
    if (!Object.hasOwn(manifest.facets, 'host')) errors.push('manifest.facets.host is required')
    if (onlyKeys(manifest.facets.host, new Set(['entry', 'apiVersion']), 'manifest.facets.host', errors)) {
      if (!nonempty(manifest.facets.host.entry)) errors.push('manifest.facets.host.entry must be non-empty')
      if (manifest.facets.host.apiVersion !== 'v1alpha1') errors.push('manifest.facets.host.apiVersion must be v1alpha1')
    }
  }

  if (onlyKeys(manifest.requires, new Set(['contracts']), 'manifest.requires', errors)) {
    const contracts = manifest.requires.contracts
    if (!Array.isArray(contracts) || contracts.length === 0) errors.push('manifest.requires.contracts must be a non-empty array')
    else contracts.forEach((contract, index) => {
      const path = `manifest.requires.contracts[${index}]`
      if (!onlyKeys(contract, new Set(['apiVersion', 'kind']), path, errors)) return
      if (!nonempty(contract.apiVersion)) errors.push(`${path}.apiVersion must be non-empty`)
      if (!nonempty(contract.kind)) errors.push(`${path}.kind must be non-empty`)
    })
  }

  if (!Array.isArray(manifest.permissions)) errors.push('manifest.permissions must be an array')
  else manifest.permissions.forEach((permission, index) => {
    const path = `manifest.permissions[${index}]`
    if (!onlyKeys(permission, new Set(['name', 'scope', 'reason']), path, errors)) return
    if (!nonempty(permission.name)) errors.push(`${path}.name must be non-empty`)
    if (!nonempty(permission.scope)) errors.push(`${path}.scope must be non-empty`)
    if (!nonempty(permission.reason)) errors.push(`${path}.reason must be non-empty`)
  })

  if (manifest.contributes !== undefined) {
    if (onlyKeys(manifest.contributes, new Set(['commands']), 'manifest.contributes', errors)
      && manifest.contributes.commands !== undefined) {
      if (!Array.isArray(manifest.contributes.commands)) errors.push('manifest.contributes.commands must be an array')
      else manifest.contributes.commands.forEach((command, index) => {
        const path = `manifest.contributes.commands[${index}]`
        if (!onlyKeys(command, new Set(['id', 'title', 'description']), path, errors)) return
        for (const key of ['id', 'title', 'description']) {
          if (!nonempty(command[key])) errors.push(`${path}.${key} must be non-empty`)
        }
      })
    }
  }

  if (!Array.isArray(manifest.subscriptions) || manifest.subscriptions.length !== 0) {
    errors.push('manifest.subscriptions must be an empty array')
  }
  return errors
}

/** Return identity drift between the static manifest and the release package. */
export function assertManifestMatchesPackage(manifest, pkg) {
  const errors = []
  const expected = {
    name: pkg?.name,
    version: pkg?.version,
    license: pkg?.license,
    entry: pkg?.main,
    source: pkg?.repository?.url,
  }
  for (const [field, value] of Object.entries(expected)) {
    const actual = field === 'entry' ? manifest?.facets?.host?.entry : manifest?.[field]
    if (actual !== value) errors.push(`${field} must match package.json (${String(actual)} != ${String(value)})`)
  }
  return errors
}

export async function verifyManifestFiles(manifestPath, packagePath) {
  const [manifest, pkg] = await Promise.all([
    readFile(manifestPath, 'utf8').then(JSON.parse),
    readFile(packagePath, 'utf8').then(JSON.parse),
  ])
  const errors = [...validateManifest(manifest), ...assertManifestMatchesPackage(manifest, pkg)]
  if (!Array.isArray(pkg.files) || !pkg.files.includes('dsh-plugin.json')) {
    errors.push('package.json files must include dsh-plugin.json')
  }
  return errors
}

async function main() {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const errors = await verifyManifestFiles(`${root}/dsh-plugin.json`, `${root}/package.json`)
  if (errors.length > 0) {
    console.error('dsh-plugin manifest verification failed:')
    for (const error of errors) console.error(`- ${error}`)
    process.exitCode = 1
    return
  }
  console.log('dsh-plugin manifest matches package.json and the v0.15 admission shape')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
