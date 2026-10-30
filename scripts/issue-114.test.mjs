import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { appendMailbox, createMessage, createTeamDir, readTeam } from '../lib/state.js'
import { assignmentPrompt, installTeamScheduler } from '../lib/scheduler.js'

const tick = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms))

function fakeAgent(id, cwd) {
  return {
    id,
    status: 'idle',
    session: { seq: 0, header: { cwd }, snapshotEvents: () => [] },
    followup() {}, steer() {}, cancel() {},
  }
}

function lease(now) {
  return {
    activationId: 'act-1', dispatchToken: 'dispatch-1', teamId: 'context', memberId: 'child',
    memberGeneration: 1, activationEpoch: 1, purpose: 'task', taskId: 't1', attempt: 1, attemptId: 'attempt-1',
    preDispatchSessionSeq: 0, startObserved: true, endObserved: false, settlementApplied: false,
    state: 'started', permitHeld: true, createdAt: now,
  }
}

async function fixture({ composition = 'standard', active = true } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-w3-context-'))
  const stateRoot = join(workspace, '.agent-teams')
  const now = Date.now()
  const captain = fakeAgent('captain', workspace)
  const child = fakeAgent('child', workspace)
  const listeners = new Map()
  const dispatched = []
  const compaction = composition === 'minimal' ? undefined : { version: 'fake-rc' }
  const ctx = {
    agents: { get: id => id === 'captain' ? captain : id === 'child' ? child : undefined, list: () => [captain, child] },
    subagents: { startActivation: async spec => ({ childId: spec.childId, messageId: 'm1', result: new Promise(() => {}), dispose: async () => {} }) },
    logger: { warn() {}, debug() {} },
    get(name) {
      if (name === 'sessionQuery') return { observeSession: async () => ({ events: [] }) }
      if (name === 'compaction') return compaction
      return undefined
    },
    on(name, fn) { const list = listeners.get(name) ?? []; list.push(fn); listeners.set(name, list); return () => {} },
    emit(name, ...args) { for (const fn of listeners.get(name) ?? []) fn(...args) },
  }
  const team = {
    id: 'context', name: 'Context', captainSessionId: 'captain', createdAt: now,
    members: [{ id: 'child', name: 'worker', joinedAt: now, status: 'working', generation: 1, currentActivationId: 'act-1', lastActivationEpoch: 1 }],
    tasks: active ? [{
      id: 't1', subject: 'Long task', status: 'in_progress', assignee: 'worker', dependencies: [], attempt: 1,
      attemptId: 'attempt-1', attemptMemberId: 'child', attemptGeneration: 1,
      attemptActivationId: 'act-1', attemptActivationEpoch: 1, createdAt: now, updatedAt: now,
    }] : [{
      id: 't1', subject: 'Fresh task', status: 'pending', assignee: 'worker', dependencies: [], attempt: 0,
      createdAt: now, updatedAt: now,
    }],
    taskSeq: 1,
    activationSeq: 1,
    activations: active ? [lease(now)] : [],
  }
  await createTeamDir(stateRoot, team)
  await appendMailbox(stateRoot, team.id, 'worker', createMessage('captain', 'worker', 'keep this mailbox state'))
  const scheduler = installTeamScheduler(ctx, {
    stateDir: '.agent-teams',
    maxConcurrentWorkers: 2,
    dispatch: async (_captain, _teamId, memberName, _text, _signal, _mode, request) => {
      dispatched.push({ memberName, request })
      if (request?.newChild) ctx.emit('subagent/start', { id: request.reservedChildId, runId: `run-${request.activationId}`, provider: 'fake', local: true })
      return { accepted: true }
    },
  })
  return { workspace, stateRoot, ctx, child, scheduler, captain, dispatched, cleanup: () => rm(workspace, { recursive: true, force: true }) }
}

test('standard composition is unproven before an actual compaction signal', async () => {
  const f = await fixture({ active: false })
  try {
    await f.scheduler.kickMember(f.workspace, 'context', 'worker', f.captain)
    await tick()
    const team = await readTeam(f.stateRoot, 'context')
    assert.equal(team.members[0].contextLifecycle.state, 'unproven')
    assert.equal(team.members[0].contextLifecycle.composition, 'standard')
    assert.equal(team.members[0].contextLifecycle.observedEvent, undefined)
  } finally { await f.cleanup() }
})

test('minimal composition reports unavailable instead of claiming compaction', async () => {
  const f = await fixture({ composition: 'minimal', active: false })
  try {
    await f.scheduler.kickMember(f.workspace, 'context', 'worker', f.captain)
    await tick()
    const team = await readTeam(f.stateRoot, 'context')
    assert.equal(team.members[0].contextLifecycle.state, 'unavailable')
    assert.equal(team.members[0].contextLifecycle.composition, 'minimal')
    assert.match(team.members[0].contextLifecycle.notes, /not mounted/i)
  } finally { await f.cleanup() }
})

test('successful host compaction is observed on the exact child and preserves execution identity', async () => {
  const f = await fixture()
  try {
    const beforeMailbox = await readFile(join(f.stateRoot, 'context', 'inbox', 'worker.jsonl'), 'utf8')
    f.ctx.emit('session/event', { id: 'child', header: { cwd: f.workspace } }, { type: 'compaction/start', seq: 10, time: 111, data: {} })
    f.ctx.emit('session/event', { id: 'child', header: { cwd: f.workspace } }, { type: 'compaction/end', seq: 11, time: 222, data: {} })
    await tick()
    const team = await readTeam(f.stateRoot, 'context')
    const member = team.members[0]
    const task = team.tasks[0]
    assert.equal(member.contextLifecycle.state, 'observed')
    assert.equal(member.contextLifecycle.observedEvent, 'compaction/end')
    assert.equal(member.contextLifecycle.observedAt, 222)
    assert.equal(member.id, 'child')
    assert.equal(task.attemptId, 'attempt-1')
    assert.equal(task.attemptActivationId, 'act-1')
    assert.equal(await readFile(join(f.stateRoot, 'context', 'inbox', 'worker.jsonl'), 'utf8'), beforeMailbox)

    const cold = installTeamScheduler(f.ctx, { stateDir: '.agent-teams', maxConcurrentWorkers: 2 })
    assert.ok(cold)
    const restored = await readTeam(f.stateRoot, 'context')
    assert.equal(restored.members[0].contextLifecycle.state, 'observed')
    assert.equal(restored.members[0].id, 'child')
    assert.equal(restored.tasks[0].attemptId, 'attempt-1')
  } finally { await f.cleanup() }
})

test('compaction/end.error is unavailable and records a bounded diagnostic', async () => {
  const f = await fixture()
  try {
    f.ctx.emit('session/event', { id: 'child', header: { cwd: f.workspace } }, { type: 'compaction/start', seq: 20, time: 300, data: {} })
    f.ctx.emit('session/event', { id: 'child', header: { cwd: f.workspace } }, { type: 'compaction/end.error', seq: 21, time: 301, data: { error: 'summarizer failed '.repeat(300) } })
    await tick()
    const member = (await readTeam(f.stateRoot, 'context')).members[0]
    assert.equal(member.contextLifecycle.state, 'unavailable')
    assert.match(member.contextLifecycle.lastCompactionError, /summarizer failed/)
    assert.ok(member.contextLifecycle.lastCompactionError.length <= 2001)
  } finally { await f.cleanup() }
})

test('compaction/prune is observed without being promoted to successful compaction', async () => {
  const f = await fixture({ active: false })
  try {
    await f.scheduler.kickMember(f.workspace, 'context', 'worker', f.captain)
    await tick()
    f.ctx.emit('session/event', { id: 'child', header: { cwd: f.workspace } }, { type: 'compaction/prune', seq: 30, time: 400, data: {} })
    await tick()
    const member = (await readTeam(f.stateRoot, 'context')).members[0]
    assert.equal(member.contextLifecycle.pruneObservedAt, 400)
    assert.notEqual(member.contextLifecycle.state, 'observed')
  } finally { await f.cleanup() }
})

test('assignment guidance exposes unavailable compaction honestly', () => {
  const prompt = assignmentPrompt({
    taskId: 't1', memberName: 'worker', memberId: 'child', attempt: 1, attemptId: 'a1', activationId: 'act-1',
    dispatchToken: 'd1', newChild: false, preDispatchSessionSeq: 0, recoveredOwned: false, routeRetry: false,
    subject: 'Work', dependencyOutputs: [],
    contextLifecycle: { state: 'unavailable', composition: 'minimal', source: 'none', notes: 'compaction service is not mounted' },
  }, '.agent-teams', 'context')
  assert.match(prompt, /Host context compaction: unavailable/i)
  assert.match(prompt, /do not claim compaction passed/i)
})
