/**
 * P0-3: dispatch-time write-domain admission.
 *
 * `create_task` already rejects an overlapping writer pair, but graphs written
 * before that check, or whose contracts were amended later, can still hold two
 * open writers on one path. The scheduler must therefore refuse to start a
 * write task while an already started write task holds an overlapping
 * `inScope`: the deferred task keeps `pending`, gains no attempt, and is
 * picked up again once the blocking writer settles.
 *
 * These tests drive the installed scheduler (`installTeamScheduler`) against a
 * temporary team directory and a fake harness context, so they exercise the
 * real dispatch path rather than a distilled helper. They import the built
 * output (`../lib/*.js`) like the other regression scripts; run `pnpm build`
 * before running them directly.
 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { installTeamScheduler } from '../lib/scheduler.js'
import { createTeamDir, readTeam, writeTeam } from '../lib/state.js'
import { removeTestTree } from './test-cleanup.mjs'

function fakeAgent(id, cwd) {
  return {
    id, status: 'idle', session: { seq: 2, header: { cwd }, snapshotEvents: () => [] },
    steer() {}, followup() {}, cancel() {}, whenIdle() { return Promise.resolve() },
  }
}

async function waitFor(check) {
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('condition not reached')
}

const writeTask = (id, overrides) => ({
  id, subject: `write ${id}`, kind: 'implementation', status: 'pending',
  objective: 'change one file', acceptance: ['file changed'], verify: ['tsc'],
  dependencies: [], attempt: 0, createdAt: 1, updatedAt: 1,
  ...overrides,
})

async function fixture(tasks) {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-p03-'))
  const stateRoot = join(workspace, '.agent-teams')
  const captain = fakeAgent('captain', workspace)
  const live = new Map([['captain', captain]])
  const listeners = new Map()
  const dispatched = []
  const logs = []
  const ctx = {
    agents: { get: id => live.get(id), list: () => [...live.values()] },
    subagents: {
      startActivation: async () => ({
        result: Promise.resolve({ stopReason: 'completed', output: [] }),
        dispose: async () => {},
      }),
    },
    // Every existing fixture logger exposes warn; the deferral reason must be
    // observable there, not only on a logger channel fixtures do not model.
    logger: { warn(message) { logs.push(String(message)) }, debug() {} },
    on(name, fn) {
      const rows = listeners.get(name) ?? []
      rows.push(fn)
      listeners.set(name, rows)
      return () => {}
    },
    emit(name, payload) { for (const fn of listeners.get(name) ?? []) fn(payload) },
  }
  const now = Date.now()
  await createTeamDir(stateRoot, {
    id: 'w1', name: 'W1', captainSessionId: 'captain', createdAt: now,
    members: [
      { id: 'm-writer', name: 'writer', joinedAt: now, status: 'working', generation: 1 },
      { id: 'm-late', name: 'late', joinedAt: now, status: 'idle', generation: 1 },
    ],
    tasks,
    taskSeq: 10,
  })
  const scheduler = installTeamScheduler(ctx, {
    stateDir: '.agent-teams',
    async dispatch(_captain, _teamId, name, _text, _signal, _mode, request) {
      dispatched.push({ name, attemptId: request.attemptId })
      const child = fakeAgent(request.reservedChildId, workspace)
      live.set(child.id, child)
      ctx.emit('subagent/start', { id: child.id, runId: `run-${dispatched.length}`, provider: 'fake', local: true })
      return { accepted: true }
    },
  })
  return {
    workspace, stateRoot, captain, scheduler, dispatched, logs,
    cleanup: () => removeTestTree(workspace),
  }
}

test('P0-3 overlapping write scope is not dispatched', async () => {
  const now = Date.now()
  const f = await fixture([
    writeTask('t1', { status: 'in_progress', assignee: 'writer', attempt: 1, attemptId: 'a1', inScope: ['src/a.ts'], updatedAt: now }),
    writeTask('t2', { inScope: ['src/a.ts', 'src/b.ts'], updatedAt: now }),
  ])
  try {
    await f.scheduler.kickMember(f.workspace, 'w1', 'late', f.captain)
    const team = await readTeam(f.stateRoot, 'w1')
    const deferred = team.tasks.find(task => task.id === 't2')
    assert.equal(f.dispatched.length, 0, 'overlapping write task must not be dispatched')
    assert.equal(deferred.status, 'pending')
    assert.equal(deferred.attemptId, undefined, 'a deferred task must not gain an attempt')
    assert.equal(deferred.attempt, 0)
    assert.equal(team.members.find(member => member.name === 'late').status, 'idle')
    assert.match(f.logs.join('\n'), /deferring w1\/t2 .*t1/, 'the deferral reason must be logged')
  } finally { await f.cleanup() }
})

test('P0-3 non-overlapping write scope is dispatched normally', async () => {
  const now = Date.now()
  const f = await fixture([
    writeTask('t1', { status: 'in_progress', assignee: 'writer', attempt: 1, attemptId: 'a1', inScope: ['src/a.ts'], updatedAt: now }),
    writeTask('t2', { inScope: ['src/c.ts'], updatedAt: now }),
  ])
  try {
    await f.scheduler.kickMember(f.workspace, 'w1', 'late', f.captain)
    await waitFor(async () => (await readTeam(f.stateRoot, 'w1')).tasks.find(task => task.id === 't2').status !== 'pending')
    const team = await readTeam(f.stateRoot, 'w1')
    const started = team.tasks.find(task => task.id === 't2')
    assert.equal(f.dispatched.length, 1)
    assert.equal(f.dispatched[0].name, 'late')
    assert.equal(started.status, 'claimed')
    assert.equal(typeof started.attemptId, 'string')
    assert.doesNotMatch(f.logs.join('\n'), /deferring/)
  } finally { await f.cleanup() }
})

test('P0-3 a started directory pattern blocks nested paths', async () => {
  const now = Date.now()
  const f = await fixture([
    writeTask('t1', { status: 'claimed', assignee: 'writer', attempt: 1, attemptId: 'a1', inScope: ['src/'], updatedAt: now }),
    writeTask('t2', { inScope: ['src/deep/file.ts'], updatedAt: now }),
  ])
  try {
    await f.scheduler.kickMember(f.workspace, 'w1', 'late', f.captain)
    const team = await readTeam(f.stateRoot, 'w1')
    assert.equal(f.dispatched.length, 0)
    assert.equal(team.tasks.find(task => task.id === 't2').status, 'pending')
    assert.equal(team.tasks.find(task => task.id === 't2').attemptId, undefined)
  } finally { await f.cleanup() }
})

test('P0-3 two pending writers do not deadlock each other', async () => {
  const now = Date.now()
  const f = await fixture([
    writeTask('t1', { assignee: 'writer', inScope: ['src/a.ts'], updatedAt: now }),
    writeTask('t2', { inScope: ['src/a.ts'], updatedAt: now }),
  ])
  try {
    await f.scheduler.kickMember(f.workspace, 'w1', 'late', f.captain)
    await waitFor(async () => (await readTeam(f.stateRoot, 'w1')).tasks.some(task => task.status !== 'pending'))
    const team = await readTeam(f.stateRoot, 'w1')
    assert.equal(f.dispatched.length, 1, 'exactly one of the pending pair starts')
    assert.equal(team.tasks.filter(task => task.status !== 'pending').length, 1)
  } finally { await f.cleanup() }
})

test('P0-3 a deferred writer starts once the blocking writer completes', async () => {
  const now = Date.now()
  const f = await fixture([
    writeTask('t1', { status: 'in_progress', assignee: 'writer', attempt: 1, attemptId: 'a1', inScope: ['src/a.ts'], updatedAt: now }),
    writeTask('t2', { inScope: ['src/a.ts'], updatedAt: now }),
  ])
  try {
    await f.scheduler.kickMember(f.workspace, 'w1', 'late', f.captain)
    assert.equal(f.dispatched.length, 0)
    const settled = await readTeam(f.stateRoot, 'w1')
    const blocker = settled.tasks.find(task => task.id === 't1')
    blocker.status = 'completed'
    blocker.verdict = 'pass'
    blocker.attemptId = undefined
    blocker.updatedAt = Date.now()
    await writeTeam(f.stateRoot, settled)
    await f.scheduler.kickTeam(f.workspace, 'w1', f.captain)
    await waitFor(async () => (await readTeam(f.stateRoot, 'w1')).tasks.find(task => task.id === 't2').status !== 'pending')
    assert.equal(f.dispatched.length, 1, 'the deferred writer starts after the blocker settles')
    assert.equal((await readTeam(f.stateRoot, 'w1')).tasks.find(task => task.id === 't2').status, 'claimed')
  } finally { await f.cleanup() }
})
