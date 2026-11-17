/**
 * R1: the activation-lease TTL sweep.
 *
 * Every delivery path releases its own permit exactly. The gap is the exception
 * paths: a member process that crashed or a turn the host dropped leaves the
 * lease in `pending|started|recovering` with nobody left to drain it, so the
 * permit shrinks the global worker budget forever and the member stays working.
 * `reconcileStaleActivationLeases` is that never-release fallback.
 *
 * The clock is injected (`now`), so an "expired" lease is a number in the
 * fixture rather than a sleep. These import the source tree directly
 * (`../src/state.ts`, no build step) like `p0-5-idempotency.test.mjs`.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  DEFAULT_ACTIVATION_LEASE_TTL_MS,
  activationLeaseAnchorMs,
  activationLeaseTtlMs,
  createTeamDir,
  readTeam,
  reconcileStaleActivationLeases,
} from '../src/state.ts'

const TEAM_ID = 'r1-team'
const NOW = 1_800_000_000_000
const TTL = 30 * 60 * 1000

const lease = (overrides = {}) => ({
  activationId: 'v1',
  dispatchToken: 'dispatch-1',
  teamId: TEAM_ID,
  memberId: 'child-writer',
  memberGeneration: 1,
  activationEpoch: 1,
  purpose: 'task',
  preDispatchSessionSeq: 0,
  startObserved: true,
  endObserved: false,
  state: 'started',
  permitHeld: true,
  createdAt: NOW - 60 * 60 * 1000,
  startedAt: NOW - 40 * 60 * 1000,
  ...overrides,
})

const member = (overrides = {}) => ({
  id: 'child-writer',
  name: 'writer',
  joinedAt: 1,
  status: 'working',
  generation: 1,
  currentActivationId: 'v1',
  ...overrides,
})

const openAttempt = (overrides = {}) => ({
  id: 't7',
  subject: 'still running',
  status: 'in_progress',
  assignee: 'writer',
  attempt: 1,
  attemptId: 'attempt-7',
  revision: 1,
  dependencies: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
})

async function fixture(t, { memberOverrides = {}, activations = [], tasks = [] } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-r1-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const stateRoot = join(workspace, '.agent-teams')
  await createTeamDir(stateRoot, {
    id: TEAM_ID,
    name: 'R1 Team',
    captainSessionId: 'captain',
    createdAt: 1,
    phase: 'running',
    taskSeq: 0,
    members: [member(memberOverrides)],
    tasks,
    activations,
  })
  return { stateRoot }
}

const sweep = (stateRoot, staleAfterMs = TTL, now = NOW) =>
  reconcileStaleActivationLeases({ stateRoot, teamId: TEAM_ID, now, staleAfterMs })

const withTtl = async (value, fn) => {
  const previous = process.env['AGENT_TEAMS_ACTIVATION_LEASE_TTL_MS']
  if (value === undefined) delete process.env['AGENT_TEAMS_ACTIVATION_LEASE_TTL_MS']
  else process.env['AGENT_TEAMS_ACTIVATION_LEASE_TTL_MS'] = value
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env['AGENT_TEAMS_ACTIVATION_LEASE_TTL_MS']
    else process.env['AGENT_TEAMS_ACTIVATION_LEASE_TTL_MS'] = previous
  }
}

test('an expired lease releases its permit, idles the member and leaves a timeline trail', async t => {
  const { stateRoot } = await fixture(t, { activations: [lease()] })
  const swept = await sweep(stateRoot)
  assert.equal(swept.released.length, 1, 'the crash-left lease must be expired')
  assert.equal(swept.kept, 0)

  // readTeam re-validates every timeline entry against the action allowlist, so
  // this call also proves the new action is a legal durable record.
  const team = await readTeam(stateRoot, TEAM_ID)
  const [persisted] = team.activations
  assert.equal(persisted.state, 'released')
  assert.equal(persisted.permitHeld, false, 'the permit must be reclaimed, not just the state')
  assert.equal(persisted.releasedAt, NOW)
  assert.equal(team.members[0].status, 'idle')
  assert.equal(team.members[0].currentActivationId, undefined)
  const entry = team.timeline.find(candidate => candidate.action === 'member.activation_expired')
  assert.ok(entry !== undefined, 'the sweep must be visible in the team timeline')
  assert.equal(entry.from, 'writer')
  assert.match(entry.result, /expired after 2400000ms/)

  const again = await sweep(stateRoot)
  assert.equal(again.released.length, 0, 'a second sweep must not re-expire a released lease')
})

test('a lease younger than the threshold keeps its permit', async t => {
  const fresh = lease({ startedAt: NOW - 5 * 60 * 1000, createdAt: NOW - 5 * 60 * 1000 })
  const { stateRoot } = await fixture(t, { activations: [fresh] })
  const swept = await sweep(stateRoot)
  assert.equal(swept.released.length, 0)
  assert.equal(swept.kept, 1)
  const team = await readTeam(stateRoot, TEAM_ID)
  assert.equal(team.activations[0].permitHeld, true)
  assert.equal(team.activations[0].state, 'started')
  assert.equal(team.members[0].status, 'working', 'a live lease must not idle its member')
})

test('the threshold is inclusive and read from the lease anchor', async t => {
  const boundary = await fixture(t, {
    activations: [lease({ startedAt: NOW - TTL, createdAt: NOW - TTL })],
  })
  assert.equal((await sweep(boundary.stateRoot)).released.length, 1, 'age == ttl is stale')

  const younger = await fixture(t, {
    activations: [lease({ startedAt: NOW - TTL + 1, createdAt: NOW - TTL + 1 })],
  })
  assert.equal((await sweep(younger.stateRoot)).released.length, 0, 'one ms younger is still live')

  // A never-started lease has no startedAt; its creation time is the only anchor.
  const unstarted = await fixture(t, {
    activations: [lease({ state: 'pending', startedAt: undefined, runningObservedAt: undefined, createdAt: NOW - TTL })],
  })
  assert.equal((await sweep(unstarted.stateRoot)).released.length, 1)
  assert.equal(activationLeaseAnchorMs(lease({ state: 'pending', startedAt: undefined })), NOW - 60 * 60 * 1000)
})

test('a member that still owns an open attempt loses the lease but keeps its status', async t => {
  const { stateRoot } = await fixture(t, {
    activations: [lease()],
    tasks: [openAttempt()],
  })
  const swept = await sweep(stateRoot)
  assert.equal(swept.released.length, 1)
  const team = await readTeam(stateRoot, TEAM_ID)
  assert.equal(team.activations[0].permitHeld, false)
  assert.equal(team.members[0].status, 'working', 'the open attempt still owns the member')
  assert.equal(team.members[0].currentActivationId, undefined)
  const entry = team.timeline.find(candidate => candidate.action === 'member.activation_expired')
  assert.match(entry.result, /still owns an open attempt/)
})

test('the sweep threshold is env-overridable and unusable values fall back to 30 minutes', async () => {
  assert.equal(DEFAULT_ACTIVATION_LEASE_TTL_MS, TTL)
  await withTtl('90000', () => {
    assert.equal(activationLeaseTtlMs(), 90_000)
  })
  for (const bad of ['', '0', 'abc', '-5']) {
    await withTtl(bad, () => {
      assert.equal(activationLeaseTtlMs(), TTL, `"${bad}" must fall back to the default`)
    })
  }
  await withTtl(undefined, () => {
    assert.equal(activationLeaseTtlMs(), TTL)
  })
})

test('the sweep reports every active lease it kept, not just the expired ones', async t => {
  const { stateRoot } = await fixture(t, {
    activations: [
      lease({ activationId: 'v-old', startedAt: NOW - 2 * TTL }),
      lease({ activationId: 'v-new', startedAt: NOW - 1000 }),
      lease({ activationId: 'v-settled', state: 'ended', permitHeld: false, startedAt: NOW - 2 * TTL }),
    ],
  })
  const swept = await sweep(stateRoot)
  assert.deepEqual(swept.released.map(item => item.activationId), ['v-old'])
  assert.equal(swept.kept, 1, 'ended leases are not active and not counted as kept')
  const team = await readTeam(stateRoot, TEAM_ID)
  assert.equal(team.activations.find(item => item.activationId === 'v-settled').state, 'ended')
})
test('a session the host still reports as running is never swept, however old its lease looks', async t => {
  // The lease anchor is stamped once and never refreshed inside one activation,
  // so age alone cannot separate a crash from a long healthy turn. The scheduler
  // passes the members it just observed running; those leases must survive.
  const { stateRoot } = await fixture(t, { activations: [lease()] })
  const swept = await reconcileStaleActivationLeases({
    stateRoot,
    teamId: TEAM_ID,
    now: NOW,
    staleAfterMs: TTL,
    skipMemberIds: new Set(['child-writer']),
  })
  assert.equal(swept.released.length, 0, 'a live turn must keep its permit')
  assert.equal(swept.kept, 1)
  const team = await readTeam(stateRoot, TEAM_ID)
  assert.equal(team.activations[0].state, 'started')
  assert.equal(team.activations[0].permitHeld, true)
  assert.equal(team.members[0].status, 'working')
  assert.equal(team.timeline.some(entry => entry.action === 'member.activation_expired'), false,
    'skipping must not write an activation_expired entry either')
})
