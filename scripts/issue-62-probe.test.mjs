import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { cancelUnfinishedTask, createTeamDir, readTeam } from '../lib/state.js'
import { installTeamScheduler } from '../lib/scheduler.js'
import { schedulerRuntimeConfig } from '../lib/tools.js'

const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms))

class FakeClock {
  constructor(start = 1_000_000) { this.value = start; this.nextId = 1; this.timers = [] }
  now() { return this.value }
  setTimeout(fn, delay) {
    const timer = { id: this.nextId++, at: this.value + Math.max(0, delay), fn, cleared: false }
    this.timers.push(timer)
    return timer.id
  }
  clearTimeout(id) { const timer = this.timers.find(item => item.id === id); if (timer !== undefined) timer.cleared = true }
  async advance(ms) {
    this.value += ms
    const due = this.timers.filter(timer => !timer.cleared && timer.at <= this.value).sort((a, b) => a.at - b.at)
    for (const timer of due) {
      timer.cleared = true
      timer.fn()
      await tick(20)
    }
    this.timers = this.timers.filter(timer => !timer.cleared)
  }
}

function fakeAgent(id, cwd) {
  return { id, status: 'idle', session: { seq: 0, header: { cwd }, snapshotEvents: () => [] }, followup() {}, steer() {}, cancel() {} }
}

function activation(now, { released = false } = {}) {
  return {
    activationId: 'act-1', dispatchToken: 'dispatch-1', teamId: 'probe', memberId: 'child',
    memberGeneration: 1, activationEpoch: 1, purpose: 'task', taskId: 't1', attempt: 1, attemptId: 'attempt-1',
    preDispatchSessionSeq: 0, startObserved: true, endObserved: released, settlementApplied: released,
    state: released ? 'released' : 'started', permitHeld: !released, createdAt: now,
  }
}

async function fixture({ probeIntervalMs = 0, probe, released = false, parked = false, maxConcurrentWorkers = 2 } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-w3-probe-'))
  const stateRoot = join(workspace, '.agent-teams')
  const clock = new FakeClock()
  const now = clock.now()
  const captain = fakeAgent('captain', workspace)
  const child = fakeAgent('child', workspace)
  const dispatched = []
  const ctx = {
    agents: { get: id => id === 'captain' ? captain : id === 'child' ? child : undefined, list: () => [captain, child] },
    subagents: {},
    logger: { warn() {}, debug() {} },
    get(name) { return name === 'sessionQuery' ? { observeSession: async () => ({ events: [] }) } : undefined },
    on() { return () => {} },
  }
  const task = {
    id: 't1', subject: 'Long work', status: released ? 'in_progress' : 'in_progress', assignee: 'worker', dependencies: [],
    attempt: 1, attemptId: 'attempt-1', attemptMemberId: 'child', attemptGeneration: 1,
    attemptActivationId: 'act-1', attemptActivationEpoch: 1,
    ...probe === undefined ? {} : { probe },
    ...parked ? { parking: {
      memberId: 'child', memberGeneration: 1, activationId: 'act-1', activationEpoch: 1,
      attemptId: 'attempt-1', noticeDueAt: now, noticeKey: 'act-1:parked',
    } } : {},
    createdAt: now, updatedAt: now,
  }
  const team = {
    id: 'probe', name: 'Probe', captainSessionId: 'captain', createdAt: now,
    members: [{ id: 'child', name: 'worker', joinedAt: now, status: 'idle', generation: 1, currentActivationId: 'act-1', lastActivationEpoch: 1 }],
    tasks: probe === undefined ? [{ ...task, status: 'pending', attempt: 0, attemptId: undefined, attemptActivationId: undefined, attemptMemberId: undefined, attemptGeneration: undefined, attemptActivationEpoch: undefined }] : [task],
    taskSeq: 1, activationSeq: 1, activations: probe === undefined ? [] : [activation(now, { released })],
  }
  await createTeamDir(stateRoot, team)
  const scheduler = installTeamScheduler(ctx, {
    stateDir: '.agent-teams', maxConcurrentWorkers, probeIntervalMs,
    now: () => clock.now(), setTimeout: (fn, delay) => clock.setTimeout(fn, delay),
    clearTimeout: id => clock.clearTimeout(id),
    dispatch: async (_captain, _teamId, memberName, _text, _signal, _mode, request) => {
      dispatched.push({ memberName, request })
      // A legacy host starts the accepted turn immediately; exact recovery
      // must observe that running boundary rather than rediscovering it as a
      // lost delivery when the probe fires.
      child.status = 'running'
      return { accepted: true }
    },
  })
  return { workspace, stateRoot, clock, scheduler, captain, dispatched, cleanup: () => rm(workspace, { recursive: true, force: true }) }
}

test('probe interval is disabled by default and scheduler config propagates an explicit value', () => {
  const base = { stateDir: '.agent-teams', memberProvider: 'spawn', memberMaxDepth: 0, maxMembers: 8, profiles: {}, toolPolicies: {} }
  assert.equal(schedulerRuntimeConfig(base, undefined).probeIntervalMs, 0)
  assert.equal(schedulerRuntimeConfig({ ...base, probeIntervalMs: 900000 }, undefined).probeIntervalMs, 900000)
})

test('disabled probe arms no nextProbeAt and schedules no timer', async () => {
  const f = await fixture({ probeIntervalMs: 0 })
  try {
    await f.scheduler.kickMember(f.workspace, 'probe', 'worker', f.captain)
    const task = (await readTeam(f.stateRoot, 'probe')).tasks[0]
    assert.equal(task.probe, undefined)
    assert.equal(f.clock.timers.length, 0)
  } finally { await f.cleanup() }
})

test('one due probe performs one silent kick and deterministically re-arms', async () => {
  const f = await fixture({ probeIntervalMs: 5000 })
  try {
    await f.scheduler.kickMember(f.workspace, 'probe', 'worker', f.captain)
    let task = (await readTeam(f.stateRoot, 'probe')).tasks[0]
    assert.equal(task.probe.nextProbeAt, f.clock.now() + 5000)
    assert.equal(f.clock.timers.length, 1)
    const firstNext = task.probe.nextProbeAt
    await f.clock.advance(4999)
    assert.equal(f.dispatched.length, 1)
    await f.clock.advance(1)
    task = (await readTeam(f.stateRoot, 'probe')).tasks[0]
    assert.equal(f.dispatched.length, 1, 'an active activation must not be duplicated')
    assert.equal(task.probe.probeCount, 1)
    assert.equal(task.probe.nextProbeAt, firstNext + 5000)
    assert.equal(f.clock.timers.length, 1)
  } finally { await f.cleanup() }
})

test('restart uses the durable due time instead of restarting the interval', async () => {
  const f = await fixture({
    probeIntervalMs: 5000,
    probe: { activationId: 'act-1', memberGeneration: 1, activationEpoch: 1, attemptId: 'attempt-1', nextProbeAt: 1_001_200, probeCount: 2, armedAt: 1_000_000 },
  })
  try {
    await f.scheduler.kickMember(f.workspace, 'probe', 'worker', f.captain)
    assert.equal(f.clock.timers.length, 1)
    await f.clock.advance(1199)
    assert.equal((await readTeam(f.stateRoot, 'probe')).tasks[0].probe.probeCount, 2)
    await f.clock.advance(1)
    assert.equal((await readTeam(f.stateRoot, 'probe')).tasks[0].probe.probeCount, 3)
  } finally { await f.cleanup() }
})

test('a due probe never rotates a permit with no positive running boundary', async () => {
  const f = await fixture({
    probeIntervalMs: 5000,
    probe: { activationId: 'act-1', memberGeneration: 1, activationEpoch: 1, attemptId: 'attempt-1', nextProbeAt: 1_000_001, probeCount: 0, armedAt: 1_000_000 },
  })
  try {
    await f.scheduler.kickMember(f.workspace, 'probe', 'worker', f.captain)
    await f.clock.advance(1)
    const task = (await readTeam(f.stateRoot, 'probe')).tasks[0]
    assert.equal(f.dispatched.length, 0)
    assert.equal(task.attemptId, 'attempt-1')
    assert.equal(task.attemptActivationId, 'act-1')
    assert.equal(task.probe.probeCount, 1)
  } finally { await f.cleanup() }
})

test('a parked exact attempt is never rotated or woken by a due probe', async () => {
  const f = await fixture({
    probeIntervalMs: 5000,
    released: true,
    parked: true,
    probe: { activationId: 'act-1', memberGeneration: 1, activationEpoch: 1, attemptId: 'attempt-1', nextProbeAt: 1_000_001, probeCount: 0, armedAt: 1_000_000 },
  })
  try {
    await f.scheduler.kickMember(f.workspace, 'probe', 'worker', f.captain)
    await f.clock.advance(1)
    const task = (await readTeam(f.stateRoot, 'probe')).tasks[0]
    assert.equal(f.dispatched.length, 0)
    assert.equal(task.attemptId, 'attempt-1')
    assert.equal(task.parking.attemptId, 'attempt-1')
    assert.equal(task.probe.probeCount, 1)
    assert.equal(task.probe.nextProbeAt, 1_005_001)
  } finally { await f.cleanup() }
})

test('terminal task transitions clear the durable probe', () => {
  const task = {
    id: 't1', subject: 'Work', status: 'in_progress', assignee: 'worker', dependencies: [], attempt: 1, attemptId: 'attempt-1',
    probe: { activationId: 'act-1', memberGeneration: 1, activationEpoch: 1, attemptId: 'attempt-1', nextProbeAt: 2_000, probeCount: 1, armedAt: 1_000 },
    createdAt: 1, updatedAt: 1,
  }
  cancelUnfinishedTask(task)
  assert.equal(task.probe, undefined)
})
