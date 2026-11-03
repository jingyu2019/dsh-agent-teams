import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendMailbox,
  appendMailboxOnce,
  compactMailboxText,
  createMessage,
  createTeamDir,
  readMailbox,
  renameMailboxOwner,
} from '../lib/state.js'

const message = (id, extra = {}) => ({ id, from: 'captain', to: 'worker', content: `body ${id}`, ts: 1, ...extra })
const lines = messages => messages.map(item => JSON.stringify(item)).join('\n') + '\n'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mailbox-compaction-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await createTeamDir(root, {
    id: 'compact-team', name: 'Compact', captainSessionId: 'captain', createdAt: 1, taskSeq: 0, phase: 'running',
    members: [{ name: 'worker', id: 'worker', status: 'idle', joinedAt: 1 }], tasks: [],
  })
  return root
}

test('compaction keeps unread, malformed and final records and archives only old acknowledged mail', () => {
  const records = []
  for (let index = 0; index < 5; index++) records.push(message(`ack-${index}`, { readAt: 2 }))
  records.push(message('unread-1'))
  records.push(message('final-1', { readAt: 2, reportKind: 'final' }))
  const raw = `${lines(records)}not-json\n`
  const { active, archived } = compactMailboxText(raw, 2)
  const activeLines = active.trim().split('\n')
  assert.deepEqual(activeLines.filter(line => line !== 'not-json').map(line => JSON.parse(line).id), [
    'ack-3', 'ack-4', 'unread-1', 'final-1',
  ])
  assert.match(active, /not-json/)
  assert.deepEqual(archived.trim().split('\n').map(line => JSON.parse(line).id), ['ack-0', 'ack-1', 'ack-2'])
})

test('compaction under byte pressure drops every archivable acknowledged record but keeps unread and final', () => {
  const raw = lines([
    message('old-1', { readAt: 2, content: 'x'.repeat(2048) }),
    message('old-2', { readAt: 2, content: 'x'.repeat(2048) }),
    message('unread', { content: 'x'.repeat(2048) }),
    message('final', { readAt: 2, reportKind: 'final', content: 'x'.repeat(2048) }),
  ])
  const { active, archived } = compactMailboxText(raw, 200, 4096)
  assert.deepEqual(active.trim().split('\n').map(line => JSON.parse(line).id), ['unread', 'final'])
  assert.deepEqual(archived.trim().split('\n').map(line => JSON.parse(line).id), ['old-1', 'old-2'])
})

test('appendMailbox bounds acknowledged history while preserving unread messages', async t => {
  const root = await fixture(t)
  for (let index = 0; index < 260; index++) {
    await appendMailbox(root, 'compact-team', 'worker', message(`m-${index}`, { readAt: 2, deliveredAt: 2 }))
  }
  await appendMailbox(root, 'compact-team', 'worker', message('unread-last'))
  const active = await readMailbox(root, 'compact-team', 'worker')
  assert.equal(active.length, 201)
  assert.equal(active.at(-1).id, 'unread-last')
  assert.equal(active[0].id, 'm-60')
  const archived = await readFile(join(root, 'compact-team', 'inbox', 'archive', 'worker.jsonl'), 'utf8')
  const archivedIds = archived.trim().split('\n').map(line => JSON.parse(line).id)
  assert.deepEqual(archivedIds, Array.from({ length: 60 }, (_, index) => `m-${index}`))
})

test('appendMailboxOnce still rejects ids that were archived', async t => {
  const root = await fixture(t)
  for (let index = 0; index < 210; index++) {
    await appendMailbox(root, 'compact-team', 'worker', message(`m-${index}`, { readAt: 2 }))
  }
  assert.equal(await appendMailboxOnce(root, 'compact-team', 'worker', message('m-0', { readAt: 2 })), false)
  assert.equal(await appendMailboxOnce(root, 'compact-team', 'worker', message('fresh')), true)
})

test('renaming a mailbox moves its archive and rewrites both address fields', async t => {
  const root = await fixture(t)
  for (let index = 0; index < 210; index++) {
    await appendMailbox(root, 'compact-team', 'worker', message(`m-${index}`, { readAt: 2 }))
  }
  await renameMailboxOwner(root, 'compact-team', 'worker', 'builder')
  const archived = await readFile(join(root, 'compact-team', 'inbox', 'archive', 'builder.jsonl'), 'utf8')
  assert.ok(archived.trim().length > 0)
  for (const line of archived.trim().split('\n')) {
    const value = JSON.parse(line)
    assert.equal(value.to, 'builder')
    assert.equal(value.from, 'captain')
  }
  await assert.rejects(readFile(join(root, 'compact-team', 'inbox', 'archive', 'worker.jsonl'), 'utf8'), /ENOENT/)
})

test('message ids stay stable across compaction and rename', async t => {
  const root = await fixture(t)
  const first = createMessage('captain', 'worker', 'hello')
  await appendMailbox(root, 'compact-team', 'worker', { ...first, readAt: 2 })
  const active = await readMailbox(root, 'compact-team', 'worker')
  assert.equal(active[0].id, first.id)
})
