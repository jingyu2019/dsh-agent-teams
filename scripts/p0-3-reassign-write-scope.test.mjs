/**
 * P0-3 收尾：改派准入 + 防饥饿 + member_lane 放行。
 *
 * Dispatch admission alone was not enough: `agent_teams_reassign_task` moved a
 * writer to another member without asking the domain, so the next dispatch
 * could put two members on one file. Reassignment now runs the same gate before
 * any durable write, and the gate gained the two escapes PRD P0-3 asked for:
 * writers on different worktree lanes never collide, and a holder whose
 * write-scope lease expired stops blocking (logged, never preempted).
 *
 * These tests import the TypeScript sources directly (like
 * `p0-4-task-revision.test.mjs`), so they run without a build: pure rules,
 * the real `reassign_task` tool path, and the real scheduler dispatch path.
 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  DEFAULT_WRITE_SCOPE_LEASE_MS,
  reassignWriteScopeFailure,
  writeScopeConflict,
  writeScopeLeaseMs,
} from '../src/quality-gates.ts'
import { installTeamScheduler } from '../src/scheduler.ts'
import { createTeamDir, readTeam, writeTeam } from '../src/state.ts'
import { registerAgentTeamsTools } from '../src/tools.ts'
import { removeTestTree } from './test-cleanup.mjs'

const MINUTE = 60 * 1000

function writeTask(id, overrides = {}) {
  return {
    id, subject: `write ${id}`, kind: 'implementation', status: 'pending',
    objective: 'change one file', acceptance: ['file changed'], verify: ['tsc'],
    dependencies: [], attempt: 0, createdAt: 1, updatedAt: Date.now(),
    ...overrides,
  }
}

function fakeAgent(id, cwd) {
  return {
    id, status: 'idle', options: { provider: 'p', model: 'm' },
    session: {
      id, seq: 0, header: { cwd, seedLength: 0 }, events: [], append() {},
      snapshotEvents: () => [], requestHeader: () => ({ config: { provider: 'p', model: 'm', reasoningEffort: 'high' } }),
    },
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

// ---------------------------------------------------------------- pure rules

test('P0-3 a live overlapping writer blocks the reassignment with an actionable message', () => {
  const now = Date.now()
  const tasks = [
    writeTask('t1', { inScope: ['src/a.ts', 'src/b.ts'] }),
    writeTask('t2', { status: 'in_progress', assignee: 'worker', attempt: 1, inScope: ['src/a.ts'], updatedAt: now }),
  ]
  const conflict = writeScopeConflict(tasks, tasks[0], { now, leaseMs: DEFAULT_WRITE_SCOPE_LEASE_MS })
  assert.ok(conflict !== undefined, 'an overlapping live writer must be refused')
  assert.equal(conflict.taskId, 't2')
  assert.deepEqual(conflict.paths, ['src/a.ts'])
  assert.notEqual(conflict.stale, true, 'a live holder is never marked stale')

  const message = reassignWriteScopeFailure(conflict)
  assert.match(message, /t2/, 'the refusal names the task holding the domain')
  assert.match(message, /src\/a\.ts/, 'the refusal names the overlapping paths')
  assert.match(message, /change its inScope/u, 'the refusal says how to unblock it')
  assert.match(message, /then retry the reassignment/u, 'the refusal says the caller may retry')
})

test('P0-3 disjoint write scopes do not conflict', () => {
  const now = Date.now()
  const tasks = [
    writeTask('t1', { inScope: ['src/a.ts'] }),
    writeTask('t2', { status: 'in_progress', assignee: 'worker', attempt: 1, inScope: ['src/z.ts'], updatedAt: now }),
  ]
  assert.equal(writeScopeConflict(tasks, tasks[0], { now }), undefined)
})

test('P0-3 two writers on the same worktree lane still conflict', () => {
  const now = Date.now()
  const tasks = [
    writeTask('t1', { inScope: ['src/a.ts'], worktreeLaneId: 'lane-a' }),
    writeTask('t2', { status: 'in_progress', assignee: 'worker', attempt: 1, inScope: ['src/a.ts'], worktreeLaneId: 'lane-a', updatedAt: now }),
  ]
  const conflict = writeScopeConflict(tasks, tasks[0], { now, laneOf: task => task.worktreeLaneId })
  assert.equal(conflict?.taskId, 't2', 'one worktree cannot take two writers on one file')
})

test('P0-3 writers on different worktree lanes never collide', () => {
  const now = Date.now()
  const tasks = [
    writeTask('t1', { inScope: ['src/a.ts'], worktreeLaneId: 'lane-b' }),
    writeTask('t2', { status: 'in_progress', assignee: 'worker', attempt: 1, inScope: ['src/a.ts'], worktreeLaneId: 'lane-a', updatedAt: now }),
  ]
  assert.equal(
    writeScopeConflict(tasks, tasks[0], { now, laneOf: task => task.worktreeLaneId }),
    undefined,
    'separate worktrees edit separate checkouts; integration reconciles them',
  )
  // Without lane information the gate stays strict, so a caller that cannot
  // resolve lanes never silently loses the admission rule.
  assert.equal(writeScopeConflict(tasks, tasks[0], { now })?.taskId, 't2')
})

test('P0-3 an expired write-scope lease stops blocking but is marked stale', () => {
  const now = Date.now()
  const live = [
    writeTask('t1', { inScope: ['src/a.ts'] }),
    writeTask('t2', { status: 'in_progress', assignee: 'worker', attempt: 1, inScope: ['src/a.ts'], updatedAt: now - MINUTE }),
  ]
  const blocked = writeScopeConflict(live, live[0], { now, leaseMs: 45 * MINUTE })
  assert.equal(blocked?.taskId, 't2', 'a live lease still blocks')
  assert.notEqual(blocked?.stale, true)

  const hung = [
    writeTask('t1', { inScope: ['src/a.ts'] }),
    writeTask('t2', { status: 'in_progress', assignee: 'worker', attempt: 1, inScope: ['src/a.ts'], updatedAt: now - 60 * MINUTE }),
  ]
  const conflict = writeScopeConflict(hung, hung[0], { now, leaseMs: 45 * MINUTE })
  assert.equal(conflict?.taskId, 't2', 'the expired holder is reported so the caller can log it')
  assert.equal(conflict.stale, true, 'an expired holder must not block dispatch')

  // A fresh overlap wins over an older stale one: the gate never lets a stale
  // holder mask a live conflict behind it.
  const mixed = [
    writeTask('t1', { inScope: ['src/a.ts', 'src/b.ts'] }),
    writeTask('t2', { status: 'in_progress', assignee: 'worker', attempt: 1, inScope: ['src/a.ts'], updatedAt: now - 60 * MINUTE }),
    writeTask('t3', { status: 'claimed', assignee: 'other', attempt: 1, inScope: ['src/b.ts'], updatedAt: now }),
  ]
  const fresh = writeScopeConflict(mixed, mixed[0], { now, leaseMs: 45 * MINUTE })
  assert.equal(fresh?.taskId, 't3')
  assert.notEqual(fresh?.stale, true)
})

test('P0-3 the write-scope lease honours AGENT_TEAMS_WRITE_SCOPE_LEASE_MS', () => {
  assert.equal(writeScopeLeaseMs(undefined), DEFAULT_WRITE_SCOPE_LEASE_MS)
  assert.equal(DEFAULT_WRITE_SCOPE_LEASE_MS, 45 * MINUTE)
  assert.equal(writeScopeLeaseMs('60000'), MINUTE)
  assert.equal(writeScopeLeaseMs('0'), DEFAULT_WRITE_SCOPE_LEASE_MS, 'a zero lease is a typo, not an unlimited gate')
  assert.equal(writeScopeLeaseMs('nonsense'), DEFAULT_WRITE_SCOPE_LEASE_MS)
})

// ------------------------------------------------- reassignment tool path

async function teamFixture(t, tasks, members = []) {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-p03-reassign-'))
  t.after(() => removeTestTree(workspace))
  const stateRoot = join(workspace, '.agent-teams')
  const now = Date.now()
  const captain = fakeAgent('captain', workspace)
  const worker = fakeAgent('child-worker', workspace)
  const late = fakeAgent('child-late', workspace)
  await createTeamDir(stateRoot, {
    id: 'scope-team', name: 'Scope Team', captainSessionId: 'captain', createdAt: now, phase: 'running',
    taskSeq: tasks.length,
    // A caller-supplied member overrides the default entry of the same name, so
    // a lane test can rebind `late` instead of competing with the base fixture.
    members: [
      { id: 'child-worker', name: 'worker', joinedAt: now, status: 'working', generation: 1 },
      { id: 'child-late', name: 'late', joinedAt: now, status: 'idle', generation: 1 },
    ].map(base => members.find(override => override.name === base.name) ?? base)
      .concat(members.filter(override => !['worker', 'late'].includes(override.name))),
    tasks,
  })
  const definitions = new Map()
  const noop = () => {}
  const logs = []
  const ctx = {
    effect(setup) { return setup(); }, on() { return noop; },
    tools: { register(definition) { definitions.set(definition.name, definition) } },
    agents: { list: () => [captain, worker, late], get: id => ([captain, worker, late].find(agent => agent.id === id)) },
    llm: { async listModels(provider) { return [{ provider, id: 'm', name: 'm' }] }, async resolveCallConfig(config) { return config } },
    subagents: {
      getProvider(name) { return name === 'spawn' ? { prepareContinuable() {}, capabilities: { persona: true, toolFilter: true } } : undefined },
      list() { return ['spawn'] }, registerContinuableSetup() { return noop },
      async followup() { return 'queued' }, async sendMessage() { return 'sent' }, interrupt() {},
      async listChildren() { return [] }, async listDescendants() { return [] }, async drainContinuableChildren() {},
    },
    logger: { warn(message) { logs.push(String(message)) }, debug: noop },
  }
  registerAgentTeamsTools(ctx, { stateDir: '.agent-teams', memberProvider: 'spawn', memberMaxDepth: 0, maxMembers: 8, profiles: {}, toolPolicies: {}, skills: {} })
  const call = (name, args) => definitions.get(name).execute(args, { agent: captain, callId: `${name}-test`, signal: new AbortController().signal })
  const task = async id => (await readTeam(stateRoot, 'scope-team')).tasks.find(item => item.id === id)
  return { stateRoot, call, task, logs }
}

test('reassign_task refuses a live overlapping domain and changes nothing', async t => {
  const now = Date.now()
  const f = await teamFixture(t, [
    writeTask('t1', { inScope: ['src/a.ts'], revision: 1 }),
    writeTask('t2', { status: 'in_progress', assignee: 'worker', attempt: 1, attemptId: 'a1', inScope: ['src/a.ts'], updatedAt: now, revision: 2 }),
  ])
  await assert.rejects(
    () => f.call('agent_teams_reassign_task', { task_id: 't1', assignee: 'late' }),
    error => {
      assert.match(error.message, /t2 is still writing src\/a\.ts/u)
      assert.match(error.message, /change its inScope, then retry the reassignment/u)
      return true
    },
  )
  const refused = await f.task('t1')
  assert.equal(refused.assignee, undefined, 'a refused reassignment must not move the task')
  assert.equal(refused.status, 'pending')
  assert.equal(refused.attempt, 0)
  assert.equal(refused.revision, 1, 'a refused reassignment must not bump the revision')
})

test('reassign_task allows a disjoint write scope', async t => {
  const f = await teamFixture(t, [
    writeTask('t1', { inScope: ['src/c.ts'] }),
    writeTask('t2', { status: 'in_progress', assignee: 'worker', attempt: 1, attemptId: 'a1', inScope: ['src/a.ts'], updatedAt: Date.now() }),
  ])
  await f.call('agent_teams_reassign_task', { task_id: 't1', assignee: 'late' })
  assert.equal((await f.task('t1')).assignee, 'late')
})

test('reassign_task exempts an overlap that lands in a different worktree lane', async t => {
  const f = await teamFixture(t, [
    writeTask('t1', { inScope: ['src/a.ts'] }),
    writeTask('t2', { status: 'in_progress', assignee: 'worker', attempt: 1, attemptId: 'a1', inScope: ['src/a.ts'], worktreeLaneId: 'lane-a', updatedAt: Date.now() }),
  ], [{ id: 'child-late', name: 'late', joinedAt: Date.now(), status: 'idle', generation: 1, worktreeLaneId: 'lane-b' }])
  await f.call('agent_teams_reassign_task', { task_id: 't1', assignee: 'late' })
  const assigned = await f.task('t1')
  assert.equal(assigned.assignee, 'late')
  assert.equal(assigned.worktreeLaneId, undefined, 'the lane binding is re-derived for the new owner')
})

test('reassign_task proceeds past an expired lease and logs it', async t => {
  const f = await teamFixture(t, [
    writeTask('t1', { inScope: ['src/a.ts'] }),
    writeTask('t2', { status: 'in_progress', assignee: 'worker', attempt: 1, attemptId: 'a1', inScope: ['src/a.ts'], updatedAt: Date.now() - 60 * MINUTE }),
  ])
  await f.call('agent_teams_reassign_task', { task_id: 't1', assignee: 'late' })
  assert.equal((await f.task('t1')).assignee, 'late', 'a hung holder must not starve the reassignment forever')
  assert.match(f.logs.join('\n'), /write scope lease expired for t2/u)
})

// ---------------------------------------------------- scheduler dispatch path

async function schedulerFixture(tasks) {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-p03-lease-'))
  const stateRoot = join(workspace, '.agent-teams')
  const captain = fakeAgent('captain', workspace)
  const live = new Map([['captain', captain]])
  const listeners = new Map()
  const dispatched = []
  const logs = []
  const ctx = {
    agents: { get: id => live.get(id), list: () => [...live.values()] },
    subagents: {
      startActivation: async () => ({ result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => {} }),
    },
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
    tasks, taskSeq: 10,
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

test('P0-3 dispatch proceeds past an expired lease and logs the holder', async () => {
  const now = Date.now()
  const f = await schedulerFixture([
    writeTask('t1', { status: 'in_progress', assignee: 'writer', attempt: 1, attemptId: 'a1', inScope: ['src/a.ts'], updatedAt: now - 60 * MINUTE }),
    writeTask('t2', { inScope: ['src/a.ts'], updatedAt: now }),
  ])
  try {
    await f.scheduler.kickMember(f.workspace, 'w1', 'late', f.captain)
    await waitFor(async () => (await readTeam(f.stateRoot, 'w1')).tasks.find(task => task.id === 't2').status !== 'pending')
    const team = await readTeam(f.stateRoot, 'w1')
    const started = team.tasks.find(task => task.id === 't2')
    assert.equal(f.dispatched.length, 1, 'an expired lease must not defer the writer forever')
    assert.equal(started.status, 'claimed')
    assert.match(f.logs.join('\n'), /write scope lease expired for t1/u, 'the starved dispatch stays observable')
    const holder = team.tasks.find(task => task.id === 't1')
    assert.equal(holder.status, 'in_progress', 'the stuck owner is never preempted')
    assert.equal(holder.attemptId, 'a1')
  } finally { await f.cleanup() }
})

test('P0-3 a fresh holder still defers the writer (the lease does not weaken the gate)', async () => {
  const now = Date.now()
  const f = await schedulerFixture([
    writeTask('t1', { status: 'in_progress', assignee: 'writer', attempt: 1, attemptId: 'a1', inScope: ['src/a.ts'], updatedAt: now }),
    writeTask('t2', { inScope: ['src/a.ts'], updatedAt: now }),
  ])
  try {
    await f.scheduler.kickMember(f.workspace, 'w1', 'late', f.captain)
    const team = await readTeam(f.stateRoot, 'w1')
    assert.equal(f.dispatched.length, 0, 'a live lease keeps the domain reserved')
    assert.equal(team.tasks.find(task => task.id === 't2').status, 'pending')
    assert.equal(team.tasks.find(task => task.id === 't2').attemptId, undefined)
    assert.match(f.logs.join('\n'), /deferring w1\/t2 .*t1/u)
    assert.doesNotMatch(f.logs.join('\n'), /lease expired/u)
  } finally { await f.cleanup() }
})