import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SNAPSHOT_TIMELINE_LIMIT, assembleTeamSnapshot } from '../lib/snapshot.js'
import { appendTimeline, createTeamDir } from '../lib/state.js'

const ctx = { logger: { warn() {} }, agents: { list: () => [], get: () => undefined } }

async function fixture(t, phase = 'running') {
  const root = await mkdtemp(join(tmpdir(), 'snapshot-payload-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const member = {
    name: 'worker', id: 'worker-1', status: 'idle', joinedAt: 1,
    executionPrompt: 'X'.repeat(20_000),
  }
  const team = {
    id: 'payload-team', name: 'Payload', captainSessionId: 'captain', createdAt: 1, taskSeq: 50,
    phase,
    members: [member],
    tasks: Array.from({ length: 50 }, (_, index) => ({
      id: `t${index}`, subject: `Task ${index}`, description: 'D'.repeat(4_000),
      status: 'pending', assignee: 'worker', dependencies: [], createdAt: 1, updatedAt: 2,
    })),
  }
  await createTeamDir(root, team)
  for (let index = 0; index < 120; index++) {
    appendTimeline(team, { action: 'task.claimed', actor: 'worker', taskId: 't0' })
  }
  return { root, team }
}

test('running snapshots omit editor-only prompts and task descriptions', async t => {
  const { root, team } = await fixture(t, 'running')
  const snapshot = await assembleTeamSnapshot(ctx, root, 'ws', team)
  assert.equal(snapshot.members[0].executionPrompt, '')
  assert.equal(snapshot.tasks.every(task => task.description === undefined), true)
  const bytes = Buffer.byteLength(JSON.stringify(snapshot))
  assert.ok(bytes < 200_000, `running snapshot stayed small: ${bytes} bytes`)
})

test('staged snapshots keep the plan editor payload', async t => {
  const { root, team } = await fixture(t, 'staged')
  const snapshot = await assembleTeamSnapshot(ctx, root, 'ws', team)
  assert.equal(snapshot.members[0].executionPrompt.length, 20_000)
  assert.equal(snapshot.tasks[0].description.length, 4_000)
})

test('snapshot timeline is capped to the newest entries without losing the newest one', async t => {
  const { root, team } = await fixture(t, 'running')
  const snapshot = await assembleTeamSnapshot(ctx, root, 'ws', team)
  assert.equal(snapshot.timeline.length, SNAPSHOT_TIMELINE_LIMIT)
  assert.equal(snapshot.timeline.at(-1).id, team.timeline.at(-1).id)
  assert.equal(snapshot.timeline[0].id, team.timeline.at(-SNAPSHOT_TIMELINE_LIMIT).id)
})

test('archived and historic snapshots pay the same bounded budget', async t => {
  const { root, team } = await fixture(t, 'running')
  const archived = await assembleTeamSnapshot(ctx, join(root, 'archive'), 'ws', team, { historic: true, includeRemoved: true })
  assert.equal(archived.members[0].executionPrompt, '')
  assert.equal(archived.tasks[0].description, undefined)
  assert.equal(archived.timeline.length, SNAPSHOT_TIMELINE_LIMIT)
})
