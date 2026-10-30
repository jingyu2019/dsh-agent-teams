import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyRouteFailure,
  createRouteCursor,
  normalizeRouteChain,
  recordPersistedRouteFailure,
  recordRouteFailure,
  routeCursorReady,
} from '../lib/members.js'
import { resolveTeamProfile } from '../lib/profiles.js'
import { beginTaskAttempt, createTeamDir, readTeam, writeTeam } from '../lib/state.js'
import { installTeamScheduler } from '../lib/scheduler.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const primary = { provider: 'p', model: 'primary' }
const second = { provider: 'p', model: 'second' }
const third = { provider: 'q', model: 'third' }

function fail(cursor, code, routeCount, activationId = 'a1', at = 0) {
  return recordRouteFailure(cursor, code, routeCount, { activationId, hostRunId: `r-${activationId}`, at })
}

test('legacy fallback and ordered routes normalize deterministically', () => {
  assert.deepEqual(normalizeRouteChain(second, [second, third]), [second, third])
  assert.deepEqual(normalizeRouteChain(undefined, [second, third]), [second, third])
  assert.deepEqual(normalizeRouteChain(second, undefined), [second])
})

test('429 uses 1s/2s/4s same-route backoff then advances once', () => {
  let cursor = createRouteCursor(3)
  cursor = fail(cursor, 'RATE_LIMIT', 3, 'a1', 1000)
  assert.equal(cursor.state, 'waiting')
  assert.equal(cursor.nextActionAt, 2000)
  cursor = fail(cursor, 'RATE_LIMIT', 3, 'a2', 2000)
  assert.equal(cursor.nextActionAt, 4000)
  cursor = fail(cursor, 'RATE_LIMIT', 3, 'a3', 4000)
  assert.equal(cursor.currentRouteIndex, 1)
  assert.equal(cursor.routeGeneration, 2)
  assert.equal(cursor.state, 'waiting')
  assert.equal(cursor.nextActionAt, 5000)
  assert.equal(cursor.routeAttempts[1], 0)
})

test('AUTH advances immediately while quota at the last route is terminal', () => {
  let cursor = fail(createRouteCursor(2), 'AUTH', 2, 'auth')
  assert.equal(cursor.currentRouteIndex, 1)
  assert.equal(cursor.state, 'ready')
  assert.equal(cursor.nextActionAt, undefined)
  cursor = fail(cursor, 'INSUFFICIENT_QUOTA', 2, 'quota')
  assert.equal(cursor.state, 'exhausted')
  assert.equal(routeCursorReady(cursor), false)
})

test('unknown and budget failures fail closed; duplicate errors do not spend twice', () => {
  const unknown = fail(createRouteCursor(3), 'SCHEMA_ERROR', 3, 'u1')
  assert.equal(unknown.state, 'exhausted')
  const budget = fail(createRouteCursor(3), 'BUDGET_EXHAUSTED', 3, 'b1')
  assert.equal(budget.state, 'exhausted')
  assert.equal(classifyRouteFailure('bogus'), 'unknown')
  const once = fail(createRouteCursor(3), 'RATE_LIMIT', 3, 'same', 0)
  const duplicate = fail(once, 'RATE_LIMIT', 3, 'same', 100)
  assert.deepEqual(duplicate, once)
})

test('route chain is capped at four additional routes and malformed entries are rejected', () => {
  assert.throws(() => resolveTeamProfile({ demo: {
    members: [{ name: 'w', model: 'primary', fallbacks: [second, third, { provider: 'x', model: 'x' }, { provider: 'y', model: 'y' }, { provider: 'z', model: 'z' }] }],
  } }, 'demo', 8), /at most 4 routes/)
})

test('restart-safe waiting cursor resumes the same attempt after its due time', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-w2-76-'))
  const stateRoot = join(workspace, '.agent-teams')
  const captain = { id: 'captain', status: 'idle', session: { seq: 0, header: { cwd: workspace }, snapshotEvents: () => [] }, followup() {}, steer() {}, whenIdle() { return Promise.resolve() }, cancel() {} }
  const now = Date.now()
  const team = {
    id: 'routes', name: 'Routes', captainSessionId: 'captain', createdAt: now,
    members: [{ id: 'child', name: 'worker', provider: 'p', model: 'primary', fallbacks: [second], joinedAt: now, status: 'idle', generation: 1 }],
    tasks: [{ id: 't1', subject: 'Work', status: 'claimed', assignee: 'worker', dependencies: [], attempt: 0, createdAt: now, updatedAt: now }],
    taskSeq: 1,
  }
  const attemptId = beginTaskAttempt(team.tasks[0], 'worker')
  team.tasks[0].attemptRoute = { ...createRouteCursor(2), state: 'waiting', nextActionAt: Date.now() - 1, lastFailure: { activationId: 'old', hostRunId: 'run-old', code: 'RATE_LIMIT', class: 'transient', at: 0 } }
  await createTeamDir(stateRoot, team)
  const listeners = new Map()
  let request
  const ctx = {
    agents: { get: id => id === 'captain' ? captain : undefined, list: () => [captain] },
    subagents: { startActivation: async spec => ({ childId: spec.childId, result: new Promise(() => {}), dispose: async () => {} }) },
    logger: { warn() {} }, get(name) { return name === 'sessionQuery' ? ctx.sessionQuery : undefined },
    sessionQuery: { observeSession: async () => ({ events: [] }) },
    on(name, fn) { listeners.set(name, fn); return () => {} },
  }
  const scheduler = installTeamScheduler(ctx, { stateDir: '.agent-teams', maxConcurrentWorkers: 2, dispatch: async (_c, _t, _m, _x, _s, _mode, value) => { request = value; return { accepted: true } } })
  try {
    await scheduler.kickMember(workspace, 'routes', 'worker', captain)
    assert.equal(request.attemptId, attemptId)
    const after = await readTeam(stateRoot, 'routes')
    assert.equal(after.tasks[0].attempt, 1)
    assert.equal(after.tasks[0].attemptId, attemptId)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('persisted AUTH failure binds the exact activation and advances the member route', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-w2-route-bind-'))
  const stateRoot = join(workspace, '.agent-teams')
  const now = Date.now()
  const team = {
    id: 'bind', name: 'Bind', captainSessionId: 'captain', createdAt: now,
    members: [{ id: 'child', name: 'worker', provider: 'p', model: 'primary', fallbacks: [second], joinedAt: now, status: 'idle', generation: 1 }],
    tasks: [{ id: 't1', subject: 'Work', status: 'claimed', assignee: 'worker', dependencies: [], attempt: 1, attemptId: 'a1', attemptActivationId: 'old-activation', createdAt: now, updatedAt: now, attemptRoute: createRouteCursor(2) }],
    taskSeq: 1,
  }
  await createTeamDir(stateRoot, team)
  const result = await recordPersistedRouteFailure({ stateRoot, teamId: 'bind', memberName: 'worker', activationId: 'old-activation', hostRunId: 'run-old', code: 'AUTH' })
  assert.equal(result.cursor.currentRouteIndex, 1)
  assert.equal(result.route.model, 'second')
  const after = await readTeam(stateRoot, 'bind')
  assert.equal(after.members[0].activeModel, 'second')
  assert.equal(after.tasks[0].attemptRoute.currentRouteIndex, 1)
})

test('stale route failure cannot mask max-tokens terminal settlement', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-w2-stale-route-'))
  const stateRoot = join(workspace, '.agent-teams')
  const captain = { id: 'captain', status: 'idle', session: { seq: 0, header: { cwd: workspace }, snapshotEvents: () => [] }, followup() {}, steer() {}, whenIdle() { return Promise.resolve() }, cancel() {} }
  const now = Date.now()
  const team = {
    id: 'stale', name: 'Stale', captainSessionId: 'captain', createdAt: now,
    members: [{ id: 'child', name: 'worker', provider: 'p', model: 'primary', fallbacks: [second], joinedAt: now, status: 'idle', generation: 1 }],
    tasks: [{ id: 't1', subject: 'Work', status: 'pending', assignee: 'worker', dependencies: [], attempt: 0, createdAt: now, updatedAt: now }],
    taskSeq: 1,
  }
  await createTeamDir(stateRoot, team)
  const listeners = new Map()
  let request
  const ctx = {
    agents: { get: id => id === 'captain' ? captain : undefined, list: () => [captain] },
    subagents: { startActivation: async () => ({ result: new Promise(() => {}), dispose: async () => {} }) },
    logger: { warn() {} }, get(name) { return name === 'sessionQuery' ? ctx.sessionQuery : undefined },
    sessionQuery: { observeSession: async () => ({ events: [] }) },
    on(name, fn) { listeners.set(name, fn); return () => {} },
    emit(name, payload) {
      const listener = listeners.get(name)
      for (const fn of Array.isArray(listener) ? listener : listener === undefined ? [] : [listener]) void fn(payload)
    },
  }
  const scheduler = installTeamScheduler(ctx, { stateDir: '.agent-teams', maxConcurrentWorkers: 2, dispatch: async (_c, _t, _m, _x, _s, _mode, value) => { request = value; return { accepted: true } } })
  try {
    await scheduler.kickMember(workspace, 'stale', 'worker', captain)
    const before = await readTeam(stateRoot, 'stale')
    before.tasks[0].attemptRoute = {
      ...createRouteCursor(2), state: 'waiting', nextActionAt: Date.now() + 60_000,
      lastFailure: { activationId: 'old-activation', hostRunId: 'old-run', code: 'RATE_LIMIT', class: 'transient', at: 0 },
    }
    await writeTeam(stateRoot, before)
    ctx.emit('subagent/end', { id: request.reservedChildId, runId: 'run-current', provider: 'fake', local: true, stopReason: 'max-tokens', lastAssistantMessage: [] })
    const deadline = Date.now() + 1000
    let after
    while (Date.now() < deadline) {
      after = await readTeam(stateRoot, 'stale')
      if (after.tasks[0].status === 'failed') break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.equal(after.tasks[0].status, 'failed')
    assert.match(after.tasks[0].output, /max-tokens/)
    assert.equal(after.activations[0].permitHeld, false)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})
