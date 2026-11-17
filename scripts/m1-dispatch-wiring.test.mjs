/**
 * M1 (commit 4dbadab) regression: failure recovery and dispatch diagnostics.
 *
 * Covers the four behaviours M1 added to `src/tools.ts`:
 *  - R5 circuit breaker: consecutive member-start failures are counted on the
 *    member, and once the member reaches the limit the dispatcher refuses to
 *    spawn/deliver again until the captain reassigns or resets it. A successful
 *    start clears the counter.
 *  - R2 failure classification: a retired member and a member with no resumable
 *    session must produce two different reasons, not one shared NOT_RESUMABLE
 *    message.
 *  - P0-1: `plan.members[]` declares `executionPrompt` (it would otherwise be
 *    dropped by `additionalProperties: false`) and the value reaches the member.
 *  - P0-2: a running team's staging errors name the operation that needed a
 *    staged team, and a halted team's error tells the captain to resume.
 *
 * `m1-dispatch-diagnostics.test.mjs` covers the same rules as pure functions.
 * This file covers the wiring those functions sit in: the dispatch path is
 * internal to `registerAgentTeamsTools`, so each case drives it the way the
 * product does — a tool call wakes the scheduler, the scheduler claims a task
 * and calls the real `dispatchMember`. That layer is where a helper can stay
 * correct while the caller stops using it. Importing the built output
 * (`../lib/*.js`) matches the other regression scripts; run `pnpm build` first
 * when running these directly.
 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createTeamDir, readTeam, recordRetiredMemberIds } from '../lib/state.js'
import { registerAgentTeamsTools } from '../lib/tools.js'
import { removeTestTree } from './test-cleanup.mjs'

function fakeAgent(id, cwd, status = 'idle') {
  return {
    id, status, options: { provider: 'p', model: 'm' },
    session: {
      id, seq: 0, header: { cwd, seedLength: 0 }, events: [], append() {},
      snapshotEvents: () => [],
      requestHeader: () => ({ config: { provider: 'p', model: 'm', reasoningEffort: 'high' } }),
    },
    followup() {}, steer() {}, cancel() {}, inject() {}, whenIdle() { return Promise.resolve() },
  }
}

const noop = () => {}

/**
 * Build a workspace with one running team ("run-team") whose single member
 * "worker" owns a pending task, then register the real tool surface so the
 * scheduler's dispatch path is exercised through a normal tool call.
 */
async function fixture({
  member = {},
  tasks = [pendingTask('t1')],
  startActivation,
  liveChildren = [],
  teams = [],
  seedRunningTeam = true,
} = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-m1-'))
  const stateRoot = join(workspace, '.agent-teams')
  const captain = fakeAgent('captain', workspace)
  const starts = []
  const deliveries = []
  const warnings = []
  const defaults = new Map(liveChildren.map(id => [id, fakeAgent(id, workspace)]))
  if (seedRunningTeam) await createTeamDir(stateRoot, {
    id: 'run-team', name: 'Run Team', captainSessionId: captain.id, createdAt: 1,
    phase: 'running', taskSeq: tasks.length,
    members: [{
      id: '', name: 'worker', role: 'impl', provider: 'p', model: 'm',
      joinedAt: 1, status: 'idle', generation: 1, ...member,
    }],
    tasks,
  })
  for (const team of teams) await createTeamDir(stateRoot, team)
  const definitions = new Map()
  const listeners = new Map()
  const ctx = {
    effect(setup) { return setup() },
    on(name, listener) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => listeners.set(name, list.filter(item => item !== listener))
    },
    tools: { register(definition) { definitions.set(definition.name, definition) } },
    agents: { list: () => [captain, ...defaults.values()], get: id => id === captain.id ? captain : defaults.get(id) },
    llm: {
      async listModels(provider) { return [{ provider, id: 'm', name: 'm' }] },
      async resolveCallConfig(config) { return config },
    },
    subagents: {
      getProvider(name) {
        return name === 'spawn' ? { prepareContinuable() {}, capabilities: { persona: true, toolFilter: true } } : undefined
      },
      list() { return ['spawn'] },
      registerContinuableSetup() { return noop },
      // A queue/deliver attempt on a session the fake host does not know throws,
      // which is exactly the "no resumable session" shape dispatchMember must
      // classify instead of reporting a failed start.
      async followup(_captain, id) {
        deliveries.push(id)
        throw new Error('NOT_RESUMABLE: session is gone')
      },
      async sendMessage(_captain, id) {
        deliveries.push(id)
        throw new Error('NOT_RESUMABLE: session is gone')
      },
      interrupt() {},
      async listChildren() { return [] },
      async listDescendants() { return [] },
      async drainContinuableChildren() {},
      async drainChildren() {},
      async startActivation(spec) {
        starts.push(spec)
        if (startActivation !== undefined) return startActivation(spec)
        // The scheduler reserves the member's child id before dispatch and
        // spawnMember rejects an activation whose child id disagrees with it.
        const current = await readTeam(stateRoot, 'run-team')
        return { childId: current.members[0].id, result: new Promise(() => {}), dispose: async () => {} }
      },
    },
    logger: { warn(message) { warnings.push(String(message)) }, debug() {} },
  }
  const runtime = registerAgentTeamsTools(ctx, {
    stateDir: '.agent-teams', memberProvider: 'spawn', memberMaxDepth: 0, maxMembers: 8,
    maxConcurrentWorkers: 2, profiles: {}, toolPolicies: {}, skills: {},
  })
  const call = (name, args) => {
    const tool = definitions.get(name)
    if (tool === undefined) throw new Error(`missing tool ${name}`)
    return tool.execute(args, { agent: captain, callId: `${name}-test`, signal: new AbortController().signal })
  }
  return { workspace, stateRoot, captain, call, runtime, starts, deliveries, warnings, definitions, cleanup: () => removeTestTree(workspace) }
}

function pendingTask(id, overrides = {}) {
  return { id, subject: `subject ${id}`, status: 'pending', assignee: 'worker', dependencies: [], attempt: 0, createdAt: 1, updatedAt: 1, ...overrides }
}

/** Wake the scheduler for the worker: reassigning one ready task kicks that member. */
async function kickWorker(f) {
  return f.call('agent_teams_reassign_task', { task_id: 't1', assignee: 'worker' })
}

test('R5 a capped member is refused before the provider is touched', async () => {
  const failing = async () => { throw new Error('simulated spawn failure: provider exploded') }
  const f = await fixture({ member: { spawnFailures: 3, spawnError: 'earlier boom' }, startActivation: failing })
  try {
    await kickWorker(f)
    const team = await readTeam(f.stateRoot, 'run-team')
    assert.equal(f.starts.length, 0, 'a capped member must not reach the provider')
    assert.match(f.warnings.join('\n'), /dispatch is paused/u, 'the pause must be logged')
    assert.equal(team.members[0].spawnFailures, 3, 'a refused dispatch must not grow the failure counter')
    assert.equal(team.members[0].spawnError, 'earlier boom', 'a refused dispatch must not rewrite the recorded cause')
    assert.equal(team.tasks[0].status, 'pending', 'the refused task returns to the pool')
    assert.equal(team.tasks[0].attemptId, undefined, 'a refused dispatch leaves no live attempt')
  } finally { await f.cleanup() }
})

test('R5 the failure limit is configurable through the environment', async () => {
  const previous = process.env['AGENT_TEAMS_MEMBER_SPAWN_FAILURE_LIMIT']
  const failing = async () => { throw new Error('simulated spawn failure: provider exploded') }
  try {
    // A lower limit refuses a member the default limit would still allow.
    process.env['AGENT_TEAMS_MEMBER_SPAWN_FAILURE_LIMIT'] = '1'
    const capped = await fixture({ member: { spawnFailures: 1 }, startActivation: failing })
    try {
      await kickWorker(capped)
      assert.equal(capped.starts.length, 0, 'limit=1 must refuse a member with one failure')
      assert.match(capped.warnings.join('\n'), /dispatch is paused/u)
    } finally { await capped.cleanup() }

    // A raised limit lets the same member try again.
    process.env['AGENT_TEAMS_MEMBER_SPAWN_FAILURE_LIMIT'] = '5'
    const allowed = await fixture({ member: { spawnFailures: 3 }, startActivation: failing })
    try {
      await kickWorker(allowed)
      assert.equal(allowed.starts.length, 1, 'limit=5 must still attempt the start')
      assert.doesNotMatch(allowed.warnings.join('\n'), /dispatch is paused/u)
    } finally { await allowed.cleanup() }
  } finally {
    if (previous === undefined) delete process.env['AGENT_TEAMS_MEMBER_SPAWN_FAILURE_LIMIT']
    else process.env['AGENT_TEAMS_MEMBER_SPAWN_FAILURE_LIMIT'] = previous
  }
})

test('R5 one successful start clears the failure counter and the recorded cause', async () => {
  const f = await fixture({ member: { spawnFailures: 2, spawnError: 'earlier boom' } })
  try {
    await kickWorker(f)
    assert.equal(f.starts.length, 1)
    const team = await readTeam(f.stateRoot, 'run-team')
    assert.equal(team.members[0].spawnFailures, undefined, 'a successful start clears spawnFailures')
    assert.equal(team.members[0].spawnError, undefined, 'a successful start clears spawnError')
    assert.equal(typeof team.members[0].id, 'string')
  } finally { await f.cleanup() }
})

test('R2 a retired member reports retirement, not a missing session', async () => {
  const f = await fixture({ member: { id: 'child-worker' } })
  try {
    await recordRetiredMemberIds(f.stateRoot, ['child-worker'])
    await kickWorker(f)
    const team = await readTeam(f.stateRoot, 'run-team')
    assert.match(team.members[0].spawnError, /was retired/u)
    assert.doesNotMatch(team.members[0].spawnError, /has no resumable session/u, 'the two causes must not share one message')
    assert.deepEqual(f.deliveries, [], 'a retired member must not be delivered to')
    assert.equal(f.starts.length, 0, 'a retired member must not be respawned')
  } finally { await f.cleanup() }
})

test('R2 a live member without a resumable session reports the delivery failure', async () => {
  const f = await fixture({ member: { id: 'child-worker', spawnError: 'previous start error' } })
  try {
    await kickWorker(f)
    const team = await readTeam(f.stateRoot, 'run-team')
    assert.match(team.members[0].spawnError, /has no resumable session/u)
    assert.match(team.members[0].spawnError, /start error: previous start error/u, 'the recorded start error must be carried forward')
    assert.doesNotMatch(team.members[0].spawnError, /was retired/u)
    assert.deepEqual(f.deliveries, ['child-worker'], 'the delivery must have been attempted once')
  } finally { await f.cleanup() }
})

test('P0-1 plan.members[] declares executionPrompt and passes it to the member', async () => {
  const f = await fixture({ tasks: [], seedRunningTeam: false })
  try {
    const memberSchema = f.definitions.get('agent_teams_create')
      .parameters.properties.plan.properties.members.items
    assert.ok(
      memberSchema.properties.executionPrompt !== undefined,
      'plan.members[] must declare executionPrompt or additionalProperties:false drops it',
    )
    await f.call('agent_teams_create', {
      name: 'prompt-team',
      approval: 'required',
      plan: {
        members: [{ name: 'worker', provider: 'p', model: 'm', executionPrompt: 'CUSTOM MEMBER PROMPT' }],
        tasks: [{ id: 'x', subject: 'first task', assignee: 'worker' }],
      },
    })
    const team = await readTeam(f.stateRoot, 'prompt-team')
    assert.equal(team.members[0].executionPrompt, 'CUSTOM MEMBER PROMPT')
  } finally { await f.cleanup() }
})

test('P0-2 staging errors name the operation that needed a staged team', async () => {
  const f = await fixture({ teams: [{ id: 'halt-team', name: 'Halt Team', captainSessionId: 'captain', createdAt: 1, phase: 'staged', halted: true, taskSeq: 0, members: [{ id: '', name: 'worker', provider: 'p', model: 'm', joinedAt: 1, status: 'idle', generation: 1 }], tasks: [] }] })
  try {
    const captain = f.captain
    await assert.rejects(
      () => f.runtime.updateStagedPlan(captain, 'run-team', { action: 'add_task', subject: 'late', dependencies: [] }),
      /editing this plan/u,
    )
    await assert.rejects(() => f.runtime.approveStagedTeam(captain, 'run-team'), /approving a plan/u)
    await assert.rejects(() => f.runtime.discardStagedTeam(captain, 'run-team'), /discarding a plan/u)
    // Halted and staged: the error must point the captain at resume.
    await assert.rejects(
      () => f.runtime.approveStagedTeam(captain, 'halt-team'),
      /is halted, not awaiting plan approval; resume it before approving a plan/u,
    )
  } finally { await f.cleanup() }
})
