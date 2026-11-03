import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REMOVE_TEST_TREE_CODES, removeTestTree } from './test-cleanup.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'test-cleanup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('removeTestTree deletes a populated fixture tree', async t => {
  const root = await fixture(t)
  const nested = join(root, 'a', 'b')
  await mkdir(nested, { recursive: true })
  await writeFile(join(nested, 'file.txt'), 'x')
  await removeTestTree(root)
  await assert.rejects(() => import('node:fs/promises').then(fs => fs.access(join(root, 'a'))), error => error?.code === 'ENOENT')
})

test('removeTestTree tolerates a missing tree', async t => {
  const root = await fixture(t)
  await removeTestTree(join(root, 'absent', 'deeper'))
})

test('removeTestTree retries a transient race and then succeeds', async t => {
  const root = await fixture(t)
  await mkdir(join(root, 'x'), { recursive: true })
  let calls = 0
  const injected = {
    rm: async (path, options) => {
      calls += 1
      if (calls < 3) throw Object.assign(new Error('busy'), { code: 'ENOTEMPTY' })
      return rm(path, options)
    },
  }
  await removeTestTree(root, { attempts: 5, delayMs: 1, primitives: injected })
  assert.equal(calls, 3)
  await assert.rejects(() => import('node:fs/promises').then(fs => fs.access(join(root, 'x'))), error => error?.code === 'ENOENT')
})

test('removeTestTree does not hide non-cleanup errors', async t => {
  const root = await fixture(t)
  await assert.rejects(
    () => removeTestTree(root, { primitives: { rm: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES-PERMANENT' }) } } }),
    /denied/,
  )
})

test('removeTestTree gives up after the bounded attempt count', async t => {
  const root = await fixture(t)
  let calls = 0
  await assert.rejects(
    () => removeTestTree(root, { attempts: 3, delayMs: 1, primitives: { rm: async () => { calls += 1; throw Object.assign(new Error('busy'), { code: 'EBUSY' }) } } }),
    /busy/,
  )
  assert.equal(calls, 3)
})
