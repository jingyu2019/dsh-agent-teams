import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { inspectInstallPreflight, versionSatisfies } from './install-preflight.mjs'

const PLUGIN = '@nanmicoder/dsh-agent-teams'
const HOST = '@deepseek-ai/dsh'

async function fixture(t, { spec, pluginVersion = '0.1.29', hostVersion = '0.2.1-rc.5', withArtifact = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'install-preflight-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const hostRoot = join(root, 'host')
  const profileRoot = join(root, 'profile')
  await mkdir(join(hostRoot, 'node_modules', HOST, 'node_modules', '@deepseek-ai', 'dsh-agent', 'node_modules', '@deepseek-ai', 'dsh-llm'), { recursive: true })
  await writeFile(join(hostRoot, 'node_modules', HOST, 'package.json'), JSON.stringify({
    name: HOST, version: hostVersion, dependencies: { '@deepseek-ai/dsh-agent': '*' },
  }))
  await writeFile(join(hostRoot, 'node_modules', HOST, 'node_modules', '@deepseek-ai', 'dsh-agent', 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-agent', version: hostVersion, dependencies: { '@deepseek-ai/dsh-llm': '*' },
  }))
  await writeFile(join(hostRoot, 'node_modules', HOST, 'node_modules', '@deepseek-ai', 'dsh-agent', 'node_modules', '@deepseek-ai', 'dsh-llm', 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-llm', version: hostVersion,
  }))
  await mkdir(join(profileRoot, 'node_modules', PLUGIN), { recursive: true })
  await writeFile(join(profileRoot, 'node_modules', PLUGIN, 'package.json'), JSON.stringify({ name: PLUGIN, version: pluginVersion }))
  let artifact
  if (withArtifact) {
    artifact = join(root, 'candidate.tgz')
    await writeFile(artifact, 'package-bytes')
    spec ??= `file:${artifact}`
  }
  await writeFile(join(profileRoot, 'package.json'), JSON.stringify({
    name: 'profile', dependencies: { [PLUGIN]: spec ?? '0.1.29' },
  }))
  return { root, profileRoot, hostRoot, artifact }
}

test('versionSatisfies handles exact, caret, tilde and unknown specs', () => {
  assert.equal(versionSatisfies('0.1.29', '0.1.29'), true)
  assert.equal(versionSatisfies('0.1.30', '0.1.29'), false)
  assert.equal(versionSatisfies('0.1.29', '^0.1.20'), true)
  assert.equal(versionSatisfies('0.2.0', '^0.1.20'), false)
  assert.equal(versionSatisfies('1.2.9', '^1.2.0'), true)
  assert.equal(versionSatisfies('1.3.0', '~1.2.9'), false)
  assert.equal(versionSatisfies('0.1.29', 'file:./x.tgz'), undefined)
})

test('local artifact preflight reports the exact digest and a matching install', async t => {
  const f = await fixture(t)
  const result = inspectInstallPreflight({ profileRoot: f.profileRoot, hostRoot: f.hostRoot })
  assert.equal(result.ok, true)
  assert.equal(result.action, 'none')
  assert.equal(result.plugin.installedVersion, '0.1.29')
  assert.equal(result.artifact.sha256, createHash('sha256').update('package-bytes').digest('hex'))
  assert.deepEqual(result.cohort, { hostVersion: '0.2.1-rc.5', packages: 3, exact: true, mixed: [] })
})

test('a missing local artifact becomes an install action, not a silent pass', async t => {
  const f = await fixture(t, { spec: 'file:/nonexistent/candidate.tgz', withArtifact: false })
  const result = inspectInstallPreflight({ profileRoot: f.profileRoot, hostRoot: f.hostRoot })
  assert.equal(result.ok, false)
  assert.equal(result.action, 'install-local-artifact')
  assert.match(result.problems.join('\n'), /local artifact is missing/)
})

test('registry specs report that a fetch is required when the install does not match', async t => {
  const f = await fixture(t, { spec: '0.1.30', withArtifact: false })
  const result = inspectInstallPreflight({ profileRoot: f.profileRoot, hostRoot: f.hostRoot })
  assert.equal(result.ok, false)
  assert.equal(result.action, 'registry-fetch-required')
  assert.match(result.problems.join('\n'), /does not satisfy/)
})

test('a mixed host cohort is reported instead of claimed exact', async t => {
  const f = await fixture(t)
  await writeFile(join(f.hostRoot, 'node_modules', HOST, 'node_modules', '@deepseek-ai', 'dsh-agent', 'node_modules', '@deepseek-ai', 'dsh-llm', 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-llm', version: '0.2.1-rc.4',
  }))
  const result = inspectInstallPreflight({ profileRoot: f.profileRoot, hostRoot: f.hostRoot })
  assert.equal(result.cohort.exact, false)
  assert.equal(result.cohort.mixed.length, 1)
  assert.match(result.problems.join('\n'), /differ from host/)
})

test('a profile without the plugin declaration fails loudly', async t => {
  const f = await fixture(t)
  await writeFile(join(f.profileRoot, 'package.json'), JSON.stringify({ name: 'profile', dependencies: {} }))
  assert.throws(() => inspectInstallPreflight({ profileRoot: f.profileRoot }), /does not declare/)
})
