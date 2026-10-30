import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createTeamDir, readTeam } from '../lib/state.js'
import { installTeamScheduler } from '../lib/scheduler.js'
import { bindAgentRun, recordBoundAgentDiagnostic } from '../lib/harness-compat.js'

function fakeAgent(id, cwd) {
  return {
    id, status: 'idle', session: { seq: 3, header: { cwd }, snapshotEvents: () => [] },
    followup() {}, steer() {}, cancel() {}, whenIdle() { return Promise.resolve() },
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

test('idle -> running interleaving cannot rotate the exact attempt', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-w1b-'))
  const stateRoot = join(workspace, '.agent-teams')
  const captain = fakeAgent('captain', workspace)
  const live = new Map(captain ? [['captain', captain]] : [])
  const listeners = new Map()
  let dispatchCount = 0
  const ctx = {
    agents: { get: id => live.get(id), list: () => [...live.values()] },
    subagents: { startActivation: async () => ({ result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => {} }) },
    logger: { warn() {}, debug() {} },
    on(name, fn) { const rows = listeners.get(name) ?? []; rows.push(fn); listeners.set(name, rows); return () => {} },
    emit(name, payload) { for (const fn of listeners.get(name) ?? []) fn(payload) },
  }
  const now = Date.now()
  await createTeamDir(stateRoot, {
    id: 'w1', name: 'W1', captainSessionId: 'captain', createdAt: now,
    members: [{ id: '', name: 'worker', joinedAt: now, status: 'idle', generation: 1 }],
    tasks: [{ id: 't1', subject: 'Work', status: 'pending', assignee: 'worker', dependencies: [], attempt: 0, createdAt: now, updatedAt: now }],
    taskSeq: 1,
  })
  const scheduler = installTeamScheduler(ctx, {
    stateDir: '.agent-teams',
    async dispatch(_captain, _teamId, _name, _text, _signal, _mode, request) {
      dispatchCount++
      const child = fakeAgent(request.reservedChildId, workspace)
      live.set(child.id, child)
      ctx.emit('subagent/start', { id: child.id, runId: 'run-current', provider: 'fake', local: true })
      return { accepted: true }
    },
  })
  try {
    await scheduler.kickMember(workspace, 'w1', 'worker', captain)
    await waitFor(async () => (await readTeam(stateRoot, 'w1'))?.activations?.[0]?.state === 'started')
    const before = await readTeam(stateRoot, 'w1')
    const attemptId = before.tasks[0].attemptId
    const child = live.get(before.members[0].id)
    ctx.emit('agent/status', { agent: child, status: 'idle' })
    child.status = 'running'
    ctx.emit('agent/status', { agent: child, status: 'running' })
    await waitFor(async () => (await readTeam(stateRoot, 'w1'))?.members[0].status === 'working')
    await scheduler.kickMember(workspace, 'w1', 'worker', captain)
    const after = await readTeam(stateRoot, 'w1')
    assert.equal(after.tasks[0].attemptId, attemptId)
    assert.equal(after.tasks[0].attemptActivationId, before.tasks[0].attemptActivationId)
    assert.equal(dispatchCount, 1)
    assert.equal(after.activations[0].permitHeld, true)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('an old Agent object cannot mutate current display or parking state', async () => {
  const old = { id: 'same-child' }
  const current = { id: 'same-child' }
  let seen = ''
  bindAgentRun(current, {
    teamId: 'w1', activationId: 'a1', hostRunId: 'r1', memberId: 'same-child',
    memberGeneration: 1, activationEpoch: 1, recordDiagnostic: value => { seen = value },
  })
  assert.equal(recordBoundAgentDiagnostic(old, 'old failure'), false)
  assert.equal(seen, '')
  assert.equal(recordBoundAgentDiagnostic(current, '429: rate limited'), true)
  assert.equal(seen, '429: rate limited')
})

test('request-error identity is Agent-object scoped, never inferred by member name', () => {
  const a = { id: 'member-name' }
  const b = { id: 'member-name' }
  const diagnostics = []
  bindAgentRun(a, {
    teamId: 'w1', activationId: 'a1', hostRunId: 'r1', memberId: 'member-name',
    memberGeneration: 1, activationEpoch: 1, recordDiagnostic: value => diagnostics.push(value),
  })
  assert.equal(recordBoundAgentDiagnostic(b, 'must not bind by id'), false)
  assert.equal(recordBoundAgentDiagnostic(a, 'bound'), true)
  assert.deepEqual(diagnostics, ['bound'])
})
