import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { appendMailbox, createMessage, createTeamDir, readTeam, writeTeam } from '../lib/state.js'
import { installTeamScheduler, mailboxActivationDecision } from '../lib/scheduler.js'
import { startMember } from '../lib/harness-compat.js'

function fakeAgent(id, cwd) {
  return {
    id,
    status: 'idle',
    session: { seq: 7, header: { cwd }, snapshotEvents: () => [] },
    followup() {}, steer() {}, whenIdle() { return Promise.resolve() }, cancel() {},
  }
}

async function waitFor(check, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('condition not reached')
}

async function fixture(dispatch) {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-w1a-'))
  const stateRoot = join(workspace, '.agent-teams')
  const captain = fakeAgent('captain', workspace)
  const listeners = new Map()
  const ctx = {
    agents: { get: id => id === 'captain' ? captain : undefined, list: () => [captain] },
    subagents: { startActivation: async spec => ({ childId: spec.childId, messageId: 'm1', result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => {} }) },
    logger: { warn() {}, debug() {} },
    get(name) { return name === 'sessionQuery' ? ctx.sessionQuery : undefined },
    sessionQuery: undefined,
    on(name, fn) { const list = listeners.get(name) ?? []; list.push(fn); listeners.set(name, list); return () => {} },
    emit(name, info) { for (const fn of listeners.get(name) ?? []) fn(info) },
  }
  const now = Date.now()
  const team = {
    id: 'w1', name: 'W1', captainSessionId: 'captain', createdAt: now,
    members: [{ id: '', name: 'worker', role: 'impl', joinedAt: now, status: 'idle', generation: 1 }],
    tasks: [{ id: 't1', subject: 'Work', status: 'pending', assignee: 'worker', dependencies: [], attempt: 0, createdAt: now, updatedAt: now }],
    taskSeq: 1,
  }
  await createTeamDir(stateRoot, team)
  const scheduler = installTeamScheduler(ctx, { stateDir: '.agent-teams', dispatch })
  return { workspace, stateRoot, ctx, team, scheduler, captain, cleanup: () => rm(workspace, { recursive: true, force: true }) }
}

async function runEnd(stopReason) {
  let request
  const f = await fixture(async (_captain, _teamId, _memberName, _text, _signal, _mode, value) => {
    request = value
    f.ctx.emit('subagent/start', { id: value.reservedChildId, runId: 'run-1', provider: 'fake', local: true })
    f.ctx.emit('subagent/end', { id: value.reservedChildId, runId: 'run-1', provider: 'fake', local: true, stopReason, lastAssistantMessage: [] })
    return { accepted: true }
  })
  try {
    await f.scheduler.kickMember(f.workspace, 'w1', 'worker', f.captain)
    await waitFor(async () => {
      const current = await readTeam(f.stateRoot, 'w1')
      return current?.activations?.[0]?.state === 'released'
        && (current.notifications === undefined || current.notifications.every(notice => notice.state === 'delivered' || notice.state === 'superseded'))
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    const team = await readTeam(f.stateRoot, 'w1')
    return { team, request }
  } finally { await f.cleanup() }
}

test('W1.1 reserves and persists a durable child id before first start', async () => {
  const { team, request } = await runEnd('max-tokens')
  assert.equal(request.newChild, true)
  assert.ok(request.reservedChildId)
  assert.equal(request.reservedChildId, team.members[0].id)
  assert.equal(team.tasks[0].attemptMemberId, request.reservedChildId)
  assert.equal(team.activations[0].preDispatchSessionSeq, 0)
})

test('W1.1 subagent/start binds the exact runId and end settles by that runId', async () => {
  const { team } = await runEnd('max-tokens')
  assert.equal(team.activations[0].hostRunId, 'run-1')
  assert.equal(team.activations[0].startObserved, true)
  assert.equal(team.activations[0].endObserved, true)
  assert.equal(team.activations[0].permitHeld, false)
  assert.equal(team.tasks[0].status, 'failed')
})

test('W1.1 completed without diagnostic is success authority and leaves the open task parked', async () => {
  const { team } = await runEnd('completed')
  assert.equal(team.activations[0].stopReason, 'completed')
  assert.equal(team.tasks[0].status, 'claimed')
})

test('W1.1 missing or unknown stopReason fails closed', async () => {
  const { team } = await runEnd(undefined)
  assert.equal(team.activations[0].stopReason, 'unknown')
  assert.equal(team.tasks[0].status, 'failed')
  assert.match(team.tasks[0].output, /settlement_unknown/)
})

test('W1.1 managed start requires and forwards the reserved child id', async () => {
  let seen
  const runtime = {
    startActivation: async spec => {
      seen = spec
      return { childId: spec.childId, messageId: 'm1', result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => {} }
    },
  }
  const childId = 'reserved-child'
  const started = await startMember(runtime, {
    childId,
    provider: 'fake', label: 'agent-teams:w1:worker', signal: new AbortController().signal,
    request: { parent: fakeAgent('captain', '/tmp'), prompt: [{ type: 'text', text: 'work' }] },
  })
  assert.equal(seen.childId, childId)
  assert.equal(started.childId, childId)
  assert.equal(started.managed, true)
  assert.equal(started.messageId, 'm1')
})


test('restart with no pre-dispatch evidence rolls back and releases the exact lease', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-w1-boundary-'))
  const stateRoot = join(workspace, '.agent-teams')
  const captain = fakeAgent('captain', workspace)
  const listeners = new Map()
  const ctx = {
    agents: { get: id => id === 'captain' ? captain : undefined, list: () => [captain] },
    subagents: { startActivation: async () => ({ result: Promise.resolve({ stopReason: 'completed' }), dispose: async () => {} }) },
    sessionQuery: { observeSession: async () => ({ events: [] }) },
    logger: { warn() {} }, get(name) { return name === 'sessionQuery' ? this.sessionQuery : undefined },
    on(name, fn) { listeners.set(name, fn); return () => {} },
  }
  const now = Date.now()
  await createTeamDir(stateRoot, {
    id: 'restart', name: 'Restart', captainSessionId: 'captain', createdAt: now, halted: true,
    members: [{ id: 'child-1', name: 'worker', joinedAt: now, status: 'idle', generation: 1, currentActivationId: 'a1' }],
    tasks: [{ id: 't1', subject: 'Work', status: 'claimed', assignee: 'worker', dependencies: [], attempt: 1,
      attemptId: 'attempt-1', attemptMemberId: 'child-1', attemptActivationId: 'a1', attemptGeneration: 1,
      attemptActivationEpoch: 1, createdAt: now, updatedAt: now }],
    taskSeq: 1, activationSeq: 1,
    activations: [{ activationId: 'a1', dispatchToken: 'd1', teamId: 'restart', memberId: 'child-1',
      memberGeneration: 1, activationEpoch: 1, purpose: 'task', taskId: 't1', attempt: 1, attemptId: 'attempt-1',
      preDispatchSessionSeq: 0, startObserved: false, endObserved: false, settlementApplied: false,
      state: 'pending', permitHeld: true, createdAt: now }],
  })
  const scheduler = installTeamScheduler(ctx, { stateDir: '.agent-teams', dispatch: async () => ({ accepted: true }) })
  try {
    await scheduler.kickMember(workspace, 'restart', 'worker', captain)
    const team = await readTeam(stateRoot, 'restart')
    assert.equal(team.activations[0].state, 'rejected')
    assert.equal(team.activations[0].permitHeld, false)
    assert.equal(team.tasks[0].status, 'pending')
    assert.equal(team.tasks[0].attemptId, undefined)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('restart scans the pre-dispatch boundary inclusively and synthesizes one turn end', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-w1-boundary-'))
  const stateRoot = join(workspace, '.agent-teams')
  const captain = fakeAgent('captain', workspace)
  const listeners = new Map()
  const ctx = {
    agents: { get: id => id === 'captain' ? captain : undefined, list: () => [captain] },
    subagents: { startActivation: async () => ({ result: Promise.resolve({ stopReason: 'completed' }), dispose: async () => {} }) },
    sessionQuery: { observeSession: async () => ({ events: [
      { type: 'system/message', data: { message: 'seed' } },
      { type: 'user/message', data: { content: [{ type: 'text', text: 'dispatch d1' }] } },
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: 'max-tokens' } },
    ] }) },
    logger: { warn() {} }, get(name) { return name === 'sessionQuery' ? this.sessionQuery : undefined },
    on(name, fn) { listeners.set(name, fn); return () => {} },
  }
  const now = Date.now()
  await createTeamDir(stateRoot, {
    id: 'restart', name: 'Restart', captainSessionId: 'captain', createdAt: now, halted: true,
    members: [{ id: 'child-1', name: 'worker', joinedAt: now, status: 'idle', generation: 1, currentActivationId: 'a2' }],
    tasks: [{ id: 't1', subject: 'Work', status: 'claimed', assignee: 'worker', dependencies: [], attempt: 1,
      attemptId: 'attempt-2', attemptMemberId: 'child-1', attemptActivationId: 'a2', attemptGeneration: 1,
      attemptActivationEpoch: 2, createdAt: now, updatedAt: now }],
    taskSeq: 1, activationSeq: 2,
    activations: [{ activationId: 'a2', dispatchToken: 'd1', teamId: 'restart', memberId: 'child-1',
      memberGeneration: 1, activationEpoch: 2, purpose: 'task', taskId: 't1', attempt: 1, attemptId: 'attempt-2',
      preDispatchSessionSeq: 1, startObserved: false, endObserved: false, settlementApplied: false,
      state: 'pending', permitHeld: true, createdAt: now }],
  })
  const scheduler = installTeamScheduler(ctx, { stateDir: '.agent-teams', dispatch: async () => ({ accepted: true }) })
  try {
    await scheduler.kickMember(workspace, 'restart', 'worker', captain)
    await waitFor(async () => (await readTeam(stateRoot, 'restart'))?.activations?.[0]?.state === 'released')
    const team = await readTeam(stateRoot, 'restart')
    assert.equal(team.activations[0].stopReason, 'max-tokens')
    assert.equal(team.tasks[0].status, 'failed')
    assert.equal(team.notifications.length, 1)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})


test('idle mailbox wake uses sendMessage path with an inclusive persisted boundary', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-w1-mailbox-'))
  const stateRoot = join(workspace, '.agent-teams')
  const captain = fakeAgent('captain', workspace)
  const listeners = new Map()
  let request
  const ctx = {
    agents: { get: id => id === 'captain' ? captain : undefined, list: () => [captain] },
    subagents: { startActivation: async () => ({ result: Promise.resolve({ stopReason: 'completed' }), dispose: async () => {} }) },
    sessionQuery: { observeSession: async () => ({ events: [{}, {}, {}, {}, {}, {}, {}] }) },
    logger: { warn() {} }, get(name) { return name === 'sessionQuery' ? this.sessionQuery : undefined },
    on(name, fn) { const rows = listeners.get(name) ?? []; rows.push(fn); listeners.set(name, rows); return () => {} },
    emit(name, payload) { for (const fn of listeners.get(name) ?? []) fn(payload) },
  }
  const now = Date.now()
  await createTeamDir(stateRoot, {
    id: 'mailbox', name: 'Mailbox', captainSessionId: 'captain', createdAt: now,
    members: [{ id: 'child-existing', name: 'worker', joinedAt: now, status: 'idle', generation: 1 }],
    tasks: [], taskSeq: 0,
  })
  await appendMailbox(stateRoot, 'mailbox', 'worker', createMessage('captain', 'worker', 'turn now'))
  const scheduler = installTeamScheduler(ctx, {
    stateDir: '.agent-teams',
    async dispatch(_captain, _teamId, _name, _text, _signal, _mode, value) {
      request = value
      ctx.emit('subagent/start', { id: value.reservedChildId, runId: 'mailbox-run', provider: 'fake', local: true })
      ctx.emit('subagent/end', { id: value.reservedChildId, runId: 'mailbox-run', provider: 'fake', local: true, stopReason: 'completed', lastAssistantMessage: [] })
      return { accepted: true }
    },
  })
  try {
    await scheduler.kickMember(workspace, 'mailbox', 'worker', captain)
    await waitFor(async () => (await readTeam(stateRoot, 'mailbox'))?.activations?.[0]?.state === 'released')
    const team = await readTeam(stateRoot, 'mailbox')
    assert.equal(request.newChild, false)
    assert.equal(request.reservedChildId, 'child-existing')
    assert.equal(team.activations[0].purpose, 'mailbox')
    assert.equal(team.activations[0].preDispatchSessionSeq, 7)
    assert.equal(team.activations[0].hostRunId, 'mailbox-run')
  } finally { await rm(workspace, { recursive: true, force: true }) }
})


test('accepted sendMessage receipt is not a terminal settlement', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-w1-send-'))
  const stateRoot = join(workspace, '.agent-teams')
  const captain = fakeAgent('captain', workspace)
  const listeners = new Map()
  const ctx = {
    agents: { get: id => id === 'captain' ? captain : undefined, list: () => [captain] },
    subagents: { startActivation: async () => ({ result: Promise.resolve({ stopReason: 'completed' }), dispose: async () => {} }) },
    sessionQuery: { observeSession: async () => ({ events: [] }) },
    logger: { warn() {} }, get(name) { return name === 'sessionQuery' ? this.sessionQuery : undefined },
    on(name, fn) { const rows = listeners.get(name) ?? []; rows.push(fn); listeners.set(name, rows); return () => {} },
    emit(name, payload) { for (const fn of listeners.get(name) ?? []) fn(payload) },
  }
  const now = Date.now()
  await createTeamDir(stateRoot, {
    id: 'send', name: 'Send', captainSessionId: 'captain', createdAt: now,
    members: [{ id: 'child-existing', name: 'worker', joinedAt: now, status: 'idle', generation: 1 }],
    tasks: [], taskSeq: 0,
  })
  await appendMailbox(stateRoot, 'send', 'worker', createMessage('captain', 'worker', 'keep running'))
  const scheduler = installTeamScheduler(ctx, {
    stateDir: '.agent-teams',
    async dispatch(_captain, _teamId, _name, _text, _signal, _mode, value) {
      ctx.emit('subagent/start', { id: value.reservedChildId, runId: 'send-run', provider: 'fake', local: true })
      return { accepted: true }
    },
  })
  try {
    await scheduler.kickMember(workspace, 'send', 'worker', captain)
    await waitFor(async () => (await readTeam(stateRoot, 'send'))?.activations?.[0]?.state === 'started')
    const team = await readTeam(stateRoot, 'send')
    assert.equal(team.activations[0].permitHeld, true)
    assert.equal(team.activations[0].endObserved, false)
  } finally {
    await new Promise(resolve => setTimeout(resolve, 10))
    await rm(workspace, { recursive: true, force: true })
  }
})


test('restart turn/end without exact prompt or start is parked, never rolled back', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-w1-turn-only-'))
  const stateRoot = join(workspace, '.agent-teams')
  const captain = fakeAgent('captain', workspace)
  const listeners = new Map()
  const ctx = {
    agents: { get: id => id === 'captain' ? captain : undefined, list: () => [captain] },
    subagents: { startActivation: async () => ({ result: Promise.resolve({ stopReason: 'completed' }), dispose: async () => {} }) },
    sessionQuery: { observeSession: async () => ({ events: [{}, { type: 'turn/end', data: { turn: 1, reason: 'completed' } }] }) },
    logger: { warn() {} }, get(name) { return name === 'sessionQuery' ? this.sessionQuery : undefined },
    on(name, fn) { listeners.set(name, fn); return () => {} },
  }
  const now = Date.now()
  await createTeamDir(stateRoot, {
    id: 'restart', name: 'Restart', captainSessionId: 'captain', createdAt: now, halted: true,
    members: [{ id: 'child-1', name: 'worker', joinedAt: now, status: 'idle', generation: 1, currentActivationId: 'a3' }],
    tasks: [{ id: 't1', subject: 'Work', status: 'claimed', assignee: 'worker', dependencies: [], attempt: 1,
      attemptId: 'attempt-3', attemptMemberId: 'child-1', attemptActivationId: 'a3', attemptGeneration: 1,
      attemptActivationEpoch: 3, createdAt: now, updatedAt: now }],
    taskSeq: 1, activationSeq: 3,
    activations: [{ activationId: 'a3', dispatchToken: 'd3', teamId: 'restart', memberId: 'child-1',
      memberGeneration: 1, activationEpoch: 3, purpose: 'task', taskId: 't1', attempt: 1, attemptId: 'attempt-3',
      preDispatchSessionSeq: 1, startObserved: false, endObserved: false, settlementApplied: false,
      state: 'pending', permitHeld: true, createdAt: now }],
  })
  const scheduler = installTeamScheduler(ctx, { stateDir: '.agent-teams', dispatch: async () => ({ accepted: true }) })
  try {
    await scheduler.kickMember(workspace, 'restart', 'worker', captain)
    await waitFor(async () => (await readTeam(stateRoot, 'restart'))?.activations?.[0]?.state === 'orphaned')
    const team = await readTeam(stateRoot, 'restart')
    assert.equal(team.activations[0].recoveryDecision, 'orphaned_parked')
    assert.equal(team.tasks[0].status, 'claimed')
    assert.equal(team.tasks[0].parking.activationId, 'a3')
    assert.equal(team.notifications.length, 1)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('mailbox wake does not allocate a second activation while one is pending', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-w1-pending-mail-'))
  const stateRoot = join(workspace, '.agent-teams')
  const captain = fakeAgent('captain', workspace)
  const listeners = new Map()
  let dispatchCount = 0
  const ctx = {
    agents: { get: id => id === 'captain' ? captain : undefined, list: () => [captain] },
    subagents: { startActivation: async () => ({ result: Promise.resolve({ stopReason: 'completed' }), dispose: async () => {} }) },
    sessionQuery: { observeSession: async () => ({ events: [] }) },
    logger: { warn() {} }, get(name) { return name === 'sessionQuery' ? this.sessionQuery : undefined },
    on(name, fn) { listeners.set(name, fn); return () => {} },
  }
  const now = Date.now()
  await createTeamDir(stateRoot, {
    id: 'mailbox', name: 'Mailbox', captainSessionId: 'captain', createdAt: now,
    members: [{ id: 'child-1', name: 'worker', joinedAt: now, status: 'idle', generation: 1, currentActivationId: 'a1' }],
    tasks: [], taskSeq: 0, activationSeq: 1,
    activations: [{ activationId: 'a1', dispatchToken: 'd1', teamId: 'mailbox', memberId: 'child-1',
      memberGeneration: 1, activationEpoch: 1, purpose: 'task', preDispatchSessionSeq: 0,
      startObserved: true, endObserved: true, settlementApplied: true, state: 'started', permitHeld: true, createdAt: now }],
  })
  await appendMailbox(stateRoot, 'mailbox', 'worker', createMessage('captain', 'worker', 'wake'))
  const scheduler = installTeamScheduler(ctx, {
    stateDir: '.agent-teams',
    async dispatch() { dispatchCount++; return { accepted: true } },
  })
  try {
    await scheduler.kickMember(workspace, 'mailbox', 'worker', captain)
    const team = await readTeam(stateRoot, 'mailbox')
    assert.equal(dispatchCount, 0)
    assert.equal(team.activations.length, 1)
    assert.equal(team.activations[0].activationId, 'a1')
    assert.equal(team.activations[0].permitHeld, true)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})


test('mailbox activation decision waits for pending, recovering, and non-running started leases', () => {
  const base = { activationId: 'a', dispatchToken: 'd', teamId: 't', memberId: 'child', memberGeneration: 1,
    activationEpoch: 1, purpose: 'task', preDispatchSessionSeq: 0, startObserved: false, endObserved: false,
    permitHeld: true, createdAt: 1 }
  assert.equal(mailboxActivationDecision([], 'child', false), 'allocate')
  assert.equal(mailboxActivationDecision([{ ...base, state: 'pending' }], 'child', true), 'wait')
  assert.equal(mailboxActivationDecision([{ ...base, state: 'recovering' }], 'child', true), 'wait')
  assert.equal(mailboxActivationDecision([{ ...base, state: 'started' }], 'child', false), 'wait')
  assert.equal(mailboxActivationDecision([{ ...base, state: 'started' }], 'child', true), 'reuse')
})
