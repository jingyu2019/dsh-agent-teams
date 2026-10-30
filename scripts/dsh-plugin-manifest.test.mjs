import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assertManifestMatchesPackage, validateManifest } from './dsh-plugin-manifest.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(new URL('../dsh-plugin.json', import.meta.url), 'utf8'))
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('manifest is a valid v0.15 declaration with release-derived identity', () => {
  assert.deepEqual(validateManifest(manifest), [])
  assert.equal(manifest.$schema, 'https://dsh.dev/schemas/dsh-plugin-0.15.schema.json')
  assert.equal(manifest.manifestVersion, '0.15')
  assert.equal(manifest.id, 'com.nanmicoder.agent-teams')
  assert.deepEqual(assertManifestMatchesPackage(manifest, pkg), [])
})

test('manifest name, version, license, entry and source cannot drift from package.json', () => {
  const mutations = [
    ['name', 'name'],
    ['version', 'version'],
    ['license', 'license'],
    ['source', 'source'],
    ['facets', 'entry'],
  ]
  for (const [field, label] of mutations) {
    const changed = structuredClone(manifest)
    if (field === 'facets') changed.facets.host.entry = 'lib/other.js'
    else if (field === 'source') changed.source = 'npm:@nanmicoder/dsh-agent-teams@0.0.0'
    else changed[field] = `changed-${field}`
    assert.match(assertManifestMatchesPackage(changed, pkg).join('\n'), new RegExp(label, 'i'))
  }
})

test('packed package includes the root manifest', () => {
  const packed = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(packed.status, 0, packed.stderr)
  const inventory = JSON.parse(packed.stdout)
  const files = inventory.flatMap(entry => entry.files ?? []).map(entry => entry.path)
  assert.ok(files.includes('dsh-plugin.json'), 'npm package must include dsh-plugin.json')
})

test('manifest rejects unsupported v0.15 fields and malformed declarations', () => {
  const unsupported = structuredClone(manifest)
  unsupported.provides = { tools: [] }
  assert.match(validateManifest(unsupported).join('\n'), /unsupported key provides/i)

  const malformed = structuredClone(manifest)
  malformed.permissions = [{ name: '', scope: 'workspace', reason: 'x' }]
  malformed.requires = { contracts: [{ apiVersion: 'tool.dsh/v1' }] }
  const errors = validateManifest(malformed).join('\n')
  assert.match(errors, /permissions\[0\]\.name/)
  assert.match(errors, /requires\.contracts\[0\]\.kind/)
})
