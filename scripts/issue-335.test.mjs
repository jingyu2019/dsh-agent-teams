/**
 * Issue #335: a Windows/desktop host reported that the installed package was
 * rejected with `invalid plugin, ... received object` even though the ESM build
 * exports `apply` by name. The root cause is export-shape dependent: a loader
 * unwraps ES modules as `exports.default ?? exports`, and a namespace object
 * without a callable `apply` is not a plugin.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const entry = await import('../lib/index.js')

test('#335 the package exposes an applicable default plugin object', () => {
  assert.equal(typeof entry.default, 'object')
  assert.equal(typeof entry.default.apply, 'function')
  assert.equal(entry.default.apply, entry.apply)
  assert.equal(entry.default.name, 'agent-teams')
  assert.deepEqual(entry.default.inject, entry.inject)
})

test('#335 both loader unwrapping shapes resolve to a callable plugin', () => {
  const namespace = entry
  const unwrap = exports => {
    if (exports === null || exports === undefined) return exports
    const first = exports.default ?? exports
    return first.__esModule ? first.default ?? first : first
  }
  assert.equal(typeof unwrap(namespace).apply, 'function')
  assert.equal(typeof unwrap(entry.default).apply, 'function')
  assert.equal(typeof unwrap({ default: entry }).apply, 'function')
})

test('#335 the published manifest entry resolves to the same module', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const manifest = JSON.parse(await readFile(new URL('../dsh-plugin.json', import.meta.url), 'utf8'))
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(manifest.facets.host.entry, pkg.main)
  assert.equal(pkg.exports['.'].default, './lib/index.js')
})
