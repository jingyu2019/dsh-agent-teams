import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { appendMailbox, createMessage, createTeamDir, readMailbox, readTeam, writeTeam } from '../lib/state.js'
import { installTeamScheduler } from '../lib/scheduler.js'

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

async function fixture(stopReason = 'completed') {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-w1c-'))
  const stateRoot = join(workspace, '.agent-teams')
  const captain = fakeAgent('captain', workspace)
  const live = new Map([['captain', captain]])
  const listeners = new Map()
  const ctx = {
    agents: { get: id => live.get(id), list: () => [...live.values()] },
    subagents: { startActivation: async () => ({ result: Promise.resolve({ stopReason, output: [] }), dispose: async () => {} }) },
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
      const child = fakeAgent(request.reservedChildId, workspace)
      live.set(child.id, child)
      ctx.emit('subagent/start', { id: child.id, runId: 'run-1', provider: 'fake', local: true })
      ctx.emit('subagent/end', { id: child.id, runId: 'run-1', provider: 'fake', local: true, stopReason, lastAssistantMessage: [] })
      return { accepted: true }
    },
  })
  return { workspace, stateRoot, captain, live, ctx, scheduler, cleanup: () => rm(workspace, { recursive: true, force: true }) }
}

test('completed activation creates exact task parking and one due notice', async () => {
  const f = await fixture()
  try {
    await f.scheduler.kickMember(f.workspace, 'w1', 'worker', f.captain)
    await waitFor(async () => {
      const current = await readTeam(f.stateRoot, 'w1')
      return (await readMailbox(f.stateRoot, 'w1', 'captain')).length === 1
        && current?.notifications?.[0]?.state === 'delivered'
    })
    const team = await readTeam(f.stateRoot, 'w1')
    assert.equal(team.tasks[0].status, 'claimed')
    assert.equal(team.tasks[0].parking.activationId, team.activations[0].activationId)
    assert.equal(typeof team.tasks[0].parking.noticeDueAt, 'number')
    assert.equal(team.notifications.length, 1)
    assert.equal(team.notifications[0].id, team.tasks[0].parking.noticeKey)
    assert.equal(team.notifications[0].state, 'delivered')
  } finally { await f.cleanup() }
})

test('mailbox append before notice-state crash is adopted without a duplicate', async () => {
  const f = await fixture()
  try {
    await f.scheduler.kickMember(f.workspace, 'w1', 'worker', f.captain)
    await waitFor(async () => {
      const current = await readTeam(f.stateRoot, 'w1')
      return (await readMailbox(f.stateRoot, 'w1', 'captain')).length === 1
        && current?.notifications?.[0]?.state === 'delivered'
    })
    const team = await readTeam(f.stateRoot, 'w1')
    team.notifications[0].state = 'pending'
    delete team.notifications[0].appendedAt
    delete team.notifications[0].deliveredAt
    await writeTeam(f.stateRoot, team)
    await f.scheduler.kickTeam(f.workspace, 'w1', f.captain)
    assert.equal((await readMailbox(f.stateRoot, 'w1', 'captain')).length, 1)
    const recovered = await readTeam(f.stateRoot, 'w1')
    assert.equal(recovered.notifications[0].state, 'delivered')
  } finally { await f.cleanup() }
})

test('team ledger before mailbox append is recovered exactly once across restarts', async () => {
  const f = await fixture('max-tokens')
  try {
    await f.scheduler.kickMember(f.workspace, 'w1', 'worker', f.captain)
    await waitFor(async () => {
      const current = await readTeam(f.stateRoot, 'w1')
      return (await readMailbox(f.stateRoot, 'w1', 'captain')).length === 1
        && current?.notifications?.[0]?.state === 'delivered'
    })
    const team = await readTeam(f.stateRoot, 'w1')
    // Simulate a crash after the durable team write but before mailbox append.
    team.notifications[0].state = 'pending'
    delete team.notifications[0].appendedAt
    delete team.notifications[0].deliveredAt
    await writeTeam(f.stateRoot, team)
    await rm(join(f.stateRoot, 'w1', 'inbox', 'captain.jsonl'), { force: true })
    await f.scheduler.kickTeam(f.workspace, 'w1', f.captain)
    await f.scheduler.kickTeam(f.workspace, 'w1', f.captain)
    assert.equal((await readMailbox(f.stateRoot, 'w1', 'captain')).length, 1)
  } finally { await f.cleanup() }
})

test('a terminal task supersedes a not-yet-appended parking notice', async () => {
  const f = await fixture('completed')
  try {
    // Seed the exact pending obligation without running the end handler.
    const now = Date.now()
    const team = await readTeam(f.stateRoot, 'w1')
    team.members[0].id = 'child-1'
    team.activations = [{
      activationId: 'a1', dispatchToken: 'd1', teamId: 'w1', memberId: 'child-1', memberGeneration: 1,
      activationEpoch: 1, purpose: 'task', taskId: 't1', attempt: 1, attemptId: 'attempt-1',
      preDispatchSessionSeq: 0, startObserved: true, endObserved: true, stopReason: 'completed',
      state: 'released', permitHeld: false, createdAt: now, endedAt: now, releasedAt: now,
    }]
    team.tasks[0].status = 'completed'
    team.tasks[0].attempt = 1
    team.tasks[0].attemptId = 'attempt-1'
    team.tasks[0].attemptActivationId = 'a1'
    team.tasks[0].parking = {
      memberId: 'child-1', memberGeneration: 1, activationId: 'a1', activationEpoch: 1,
      attemptId: 'attempt-1', noticeDueAt: now, noticeKey: 'a1:parked',
    }
    team.notifications = [{ id: 'a1:parked', messageId: 'notice:a1:parked', teamId: 'w1', memberId: 'child-1',
      memberGeneration: 1, activationId: 'a1', taskId: 't1', attemptId: 'attempt-1', kind: 'parked',
      content: 'parked', state: 'pending', noticeDueAt: now, createdAt: now }]
    team.tasks[0].parking = undefined
    await writeTeam(f.stateRoot, team)
    await f.scheduler.kickTeam(f.workspace, 'w1', f.captain)
    const recovered = await readTeam(f.stateRoot, 'w1')
    assert.equal(recovered.notifications[0].state, 'superseded')
    assert.equal((await readMailbox(f.stateRoot, 'w1', 'captain')).length, 0)
  } finally { await f.cleanup() }
})


test('durable task parking survives restart and blocks automatic re-dispatch', async () => {
  const f = await fixture('completed')
  try {
    const now = Date.now()
    const team = await readTeam(f.stateRoot, 'w1')
    team.members[0].id = 'child-parked'
    team.members[0].currentActivationId = 'a-parked'
    team.tasks[0].status = 'claimed'
    team.tasks[0].attempt = 2
    team.tasks[0].attemptId = 'attempt-parked'
    team.tasks[0].attemptMemberId = 'child-parked'
    team.tasks[0].attemptGeneration = 1
    team.tasks[0].attemptActivationId = 'a-parked'
    team.tasks[0].attemptActivationEpoch = 2
    team.tasks[0].parking = {
      memberId: 'child-parked', memberGeneration: 1, activationId: 'a-parked', activationEpoch: 2,
      attemptId: 'attempt-parked', noticeDueAt: now, noticeKey: 'a-parked:parked',
    }
    team.activations = [{
      activationId: 'a-parked', dispatchToken: 'd-parked', teamId: 'w1', memberId: 'child-parked',
      memberGeneration: 1, activationEpoch: 2, purpose: 'task', taskId: 't1', attempt: 2,
      attemptId: 'attempt-parked', preDispatchSessionSeq: 0, startObserved: true, endObserved: true,
      settlementApplied: true, state: 'released', permitHeld: false, stopReason: 'completed',
      createdAt: now, endedAt: now, releasedAt: now,
    }]
    await writeTeam(f.stateRoot, team)
    await f.scheduler.kickMember(f.workspace, 'w1', 'worker', f.captain)
    const after = await readTeam(f.stateRoot, 'w1')
    assert.equal(after.tasks[0].attemptId, 'attempt-parked')
    assert.equal(after.tasks[0].attempt, 2)
    assert.equal(after.activations.length, 1)
    assert.equal(after.tasks[0].parking.activationId, 'a-parked')
  } finally { await f.cleanup() }
})
