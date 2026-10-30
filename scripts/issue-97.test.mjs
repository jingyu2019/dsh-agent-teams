import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { appendMailbox, createMessage, createTeamDir, readTeam } from '../lib/state.js'
import { installTeamScheduler, activePermitCount, canAcquireActivationPermit } from '../lib/scheduler.js'

function fakeAgent(id, cwd) {
  return {
    id,
    status: 'idle',
    session: { seq: 0, header: { cwd }, snapshotEvents: () => [] },
    followup() {}, steer() {}, whenIdle() { return Promise.resolve() }, cancel() {},
  }
}

function lease(id, memberId = id, state = 'started', permitHeld = true) {
  return {
    activationId: id, dispatchToken: `d-${id}`, teamId: 'cap', memberId,
    memberGeneration: 1, activationEpoch: 1, purpose: 'task', preDispatchSessionSeq: 0,
    startObserved: state === 'started', endObserved: false, settlementApplied: false,
    state, permitHeld, createdAt: 1,
  }
}

function teamWith(memberCount, taskCount, maxConcurrentWorkers) {
  const now = Date.now()
  return {
    id: 'cap', name: 'Cap', captainSessionId: 'captain', createdAt: now,
    members: Array.from({ length: memberCount }, (_, index) => ({
      id: `c${index + 1}`, name: `w${index + 1}`, joinedAt: now, status: 'idle', generation: 1,
    })),
    tasks: Array.from({ length: taskCount }, (_, index) => ({
      id: `t${index + 1}`, subject: `Task ${index + 1}`, status: 'pending', assignee: `w${(index % memberCount) + 1}`,
      dependencies: [], attempt: 0, createdAt: now, updatedAt: now,
    })),
    taskSeq: taskCount,
    maxConcurrentWorkers,
  }
}

async function fixture(team, maxConcurrentWorkers = 2, liveStatuses = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-w2-97-'))
  const stateRoot = join(workspace, '.agent-teams')
  const captain = fakeAgent('captain', workspace)
  const listeners = new Map()
  const dispatched = []
  const liveMembers = new Map(team.members.filter(member => member.id !== '').map(member => [member.id, fakeAgent(member.id, workspace)]))
  const ctx = {
    agents: { get: id => id === 'captain' ? captain : (() => {
      const agent = liveMembers.get(id)
      if (agent !== undefined && liveStatuses[id] !== undefined) agent.status = liveStatuses[id]
      return agent
    })(), list: () => [captain, ...liveMembers.values()] },
    subagents: { startActivation: async spec => ({ childId: spec.childId, messageId: 'm1', result: new Promise(() => {}), dispose: async () => {} }) },
    logger: { warn() {}, debug() {} },
    get(name) { return name === 'sessionQuery' ? ctx.sessionQuery : undefined },
    sessionQuery: { observeSession: async () => ({ events: [] }) },
    on(name, fn) { const list = listeners.get(name) ?? []; list.push(fn); listeners.set(name, list); return () => {} },
    emit(name, info) { for (const fn of listeners.get(name) ?? []) void fn(info) },
  }
  await createTeamDir(stateRoot, team)
  const scheduler = installTeamScheduler(ctx, {
    stateDir: '.agent-teams',
    maxConcurrentWorkers,
    async dispatch(_captain, _teamId, memberName, _text, _signal, _mode, request) {
      dispatched.push({ memberName, request })
      if (request?.newChild) ctx.emit('subagent/start', { id: request.reservedChildId, runId: `run-${request.activationId}`, provider: 'fake', local: true })
      return { accepted: true }
    },
  })
  return { workspace, stateRoot, scheduler, captain, dispatched, ctx, cleanup: () => rm(workspace, { recursive: true, force: true }) }
}

test('permit accounting counts only active held leases', () => {
  assert.equal(activePermitCount([lease('a'), lease('b'), lease('c', 'c', 'released', false)]), 2)
  assert.equal(canAcquireActivationPermit([lease('a'), lease('b')], 2), false)
  assert.equal(canAcquireActivationPermit([lease('a')], 2), true)
})

test('7 ready tasks with cap 2 never dispatch a third activation', async () => {
  const f = await fixture(teamWith(7, 7), 2)
  try {
    await f.scheduler.kickTeam(f.workspace, 'cap', f.captain)
    const team = await readTeam(f.stateRoot, 'cap')
    assert.equal(f.dispatched.length, 2)
    assert.equal(team.activations.filter(item => item.permitHeld).length, 2)
    assert.equal(team.tasks.filter(item => item.status !== 'pending').length, 2)
  } finally { await f.cleanup() }
})

test('mailbox wake cannot bypass the global permit cap', async () => {
  const team = teamWith(2, 0)
  team.members[0].id = 'c1'
  team.members[1].id = 'c2'
  team.activations = [lease('b', 'c2')]
  team.activationSeq = 2
  const f = await fixture(team, 1, { c2: 'running' })
  try {
    await appendMailbox(f.stateRoot, 'cap', 'w1', createMessage('captain', 'w1', 'wake'))
    await f.scheduler.kickMember(f.workspace, 'cap', 'w1', f.captain)
    assert.equal(f.dispatched.length, 0)
    assert.equal((await readTeam(f.stateRoot, 'cap')).activations.length, 1)
  } finally { await f.cleanup() }
})

test('release after exact end opens the next permit once and one new task starts', async () => {
  const f = await fixture(teamWith(3, 7), 2)
  try {
    await f.scheduler.kickTeam(f.workspace, 'cap', f.captain)
    const first = (await readTeam(f.stateRoot, 'cap')).activations.find(item => item.permitHeld)
    assert.ok(first)
    f.ctx.emit('subagent/end', { id: first.memberId, runId: first.hostRunId ?? `run-${first.activationId}`, provider: 'fake', local: true, stopReason: 'aborted', lastAssistantMessage: [] })
    await new Promise(resolve => setTimeout(resolve, 25))
    const after = await readTeam(f.stateRoot, 'cap')
    assert.equal(after.activations.find(item => item.activationId === first.activationId).permitHeld, false)
    assert.equal(after.activations.filter(item => item.permitHeld).length, 2)
    await f.scheduler.kickTeam(f.workspace, 'cap', f.captain)
    assert.equal(f.dispatched.length, 3)
  } finally { await f.cleanup() }
})
