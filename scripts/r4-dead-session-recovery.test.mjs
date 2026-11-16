/**
 * R4: a refused delivery to a member whose child session is gone recovers
 * itself instead of only reporting a failure.
 *
 * The plugin owns two refusal causes the host folds into one `NOT_RESUMABLE`:
 * "retired" (a human stopped the member) and "lost session" (the child is
 * gone). Only the second one may be repaired automatically, and the repair must
 * be the very same guarded reset the tool exposes — a guard refusal is reported,
 * never routed around. Both behaviours are asserted here.
 *
 * These import the built output (`../lib/*.js`) like the other regression
 * scripts; run `pnpm build` before running them directly.
 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  AUTO_RESET_REASON,
  lostSessionDeliveryFailure,
  recoverLostSessionDelivery,
  resetMemberContextLocked,
  retiredMemberDeliveryFailure,
} from '../lib/tools.js'
import { createTeamDir, readRetiredMemberIds, readTeam } from '../lib/state.js'
import { removeTestTree } from './test-cleanup.mjs'

const TEAM_ID = 'r4-team'

/** A running team whose single member already owned a child session. */
function teamState(overrides = {}) {
  return {
    id: TEAM_ID, name: 'R4 Team', captainSessionId: 'captain', createdAt: 1,
    phase: 'running', taskSeq: 0,
    members: [{ id: 'dead-session', name: 'writer', joinedAt: 1, status: 'idle', provider: 'p', model: 'm', generation: 1 }],
    tasks: [],
    ...overrides,
  }
}

async function withState(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-r4-'))
  await createTeamDir(root, teamState(overrides))
  return root
}

test('a dead member session is reset automatically and the delivery is retried once', async t => {
  const root = await withState()
  t.after(() => removeTestTree(root))
  const team = await readTeam(root, TEAM_ID)
  assert.equal(team.members[0].id, 'dead-session')
  const failure = lostSessionDeliveryFailure('writer', 'NOT_RESUMABLE')
  const retried = []
  const outcome = await recoverLostSessionDelivery({
    cause: 'lost-session',
    failure,
    reset: () => resetMemberContextLocked({ team, stateRoot: root, memberName: 'writer', reason: AUTO_RESET_REASON }),
    retry: async () => { retried.push('delivery'); return true },
  })
  assert.deepEqual(outcome, { accepted: true, retried: true })
  assert.equal(retried.length, 1)

  const after = await readTeam(root, TEAM_ID)
  assert.equal(after.members[0].id, '', 'the dead child id must be dropped so the next delivery starts fresh')
  assert.equal(after.members[0].status, 'idle')
  assert.equal(after.members[0].generation, 2)
  const resets = after.timeline.filter(entry => entry.action === 'member.context_reset')
  assert.equal(resets.length, 1)
  assert.equal(resets[0].from, 'writer')
  assert.equal(resets[0].result, AUTO_RESET_REASON, 'the audit row must name the automatic trigger')
  assert.ok((await readRetiredMemberIds(root)).has('dead-session'), 'the replaced child must never be resumed again')
})

test('a retired member keeps its refusal wording and is never reset', async t => {
  const root = await withState()
  t.after(() => removeTestTree(root))
  const team = await readTeam(root, TEAM_ID)
  let resets = 0
  const outcome = await recoverLostSessionDelivery({
    cause: 'retired',
    failure: retiredMemberDeliveryFailure('writer'),
    reset: async () => { resets += 1 },
    retry: async () => { assert.fail('a retired member must not be redelivered') },
  })
  assert.deepEqual(outcome, { accepted: false, retried: false })
  assert.equal(resets, 0)
  assert.match(retiredMemberDeliveryFailure('writer'), /was retired: its session was stopped and cannot be resumed/u)

  const after = await readTeam(root, TEAM_ID)
  assert.equal(after.members[0].id, 'dead-session', 'a retired member keeps its roster row untouched')
  assert.equal(after.timeline.filter(entry => entry.action === 'member.context_reset').length, 0)
})

test('the automatic reset reuses the guarded path and reports a refusal', async t => {
  await t.test('a running member is refused', async t => {
    const root = await withState()
    t.after(() => removeTestTree(root))
    const team = { ...(await readTeam(root, TEAM_ID)), members: [{ id: 'dead-session', name: 'writer', joinedAt: 1, status: 'working', generation: 1 }] }
    const failure = lostSessionDeliveryFailure('writer', 'NOT_RESUMABLE')
    const outcome = await recoverLostSessionDelivery({
      cause: 'lost-session',
      failure,
      reset: () => resetMemberContextLocked({ team, stateRoot: root, memberName: 'writer', reason: AUTO_RESET_REASON }),
      retry: async () => { assert.fail('a refused reset must not be redelivered') },
    })
    assert.equal(outcome.accepted, false)
    assert.equal(outcome.retried, false)
    assert.equal(outcome.deliveryFailure, `${failure} (automatic context reset refused: member "writer" is running; wait until it is idle)`)
  })

  await t.test('an open attempt is refused', async t => {
    const root = await withState({
      tasks: [{ id: 't1', subject: 'Do it', status: 'in_progress', assignee: 'writer', attemptId: 'a1', dependencies: [], createdAt: 1, updatedAt: 1 }],
    })
    t.after(() => removeTestTree(root))
    const team = await readTeam(root, TEAM_ID)
    const outcome = await recoverLostSessionDelivery({
      cause: 'lost-session',
      failure: lostSessionDeliveryFailure('writer', undefined),
      reset: () => resetMemberContextLocked({ team, stateRoot: root, memberName: 'writer', reason: AUTO_RESET_REASON }),
      retry: async () => { assert.fail('an open attempt must not be reset around') },
    })
    assert.match(outcome.deliveryFailure ?? '', /automatic context reset refused: member "writer" still owns an open attempt/u)
    const after = await readTeam(root, TEAM_ID)
    assert.equal(after.members[0].id, 'dead-session')
    assert.equal(after.timeline.filter(entry => entry.action === 'member.context_reset').length, 0)
  })

  await t.test('an active activation is refused', async t => {
    const root = await withState({
      activations: [{
        activationId: 'act-1', dispatchToken: 'token-1', teamId: TEAM_ID, memberId: 'dead-session',
        memberGeneration: 1, activationEpoch: 1, purpose: 'task', preDispatchSessionSeq: 0,
        startObserved: true, endObserved: false, state: 'started', permitHeld: true, createdAt: 1,
      }],
    })
    t.after(() => removeTestTree(root))
    const team = await readTeam(root, TEAM_ID)
    const outcome = await recoverLostSessionDelivery({
      cause: 'lost-session',
      failure: lostSessionDeliveryFailure('writer', undefined),
      reset: () => resetMemberContextLocked({ team, stateRoot: root, memberName: 'writer', reason: AUTO_RESET_REASON }),
      retry: async () => { assert.fail('an active activation must not be reset around') },
    })
    assert.match(outcome.deliveryFailure ?? '', /automatic context reset refused: member "writer" still has an active activation/u)
  })
})

test('the single retry keeps the existing failure path when it fails too', async t => {
  const root = await withState()
  t.after(() => removeTestTree(root))
  const team = await readTeam(root, TEAM_ID)
  const outcome = await recoverLostSessionDelivery({
    cause: 'lost-session',
    failure: lostSessionDeliveryFailure('writer', 'NOT_RESUMABLE'),
    reset: () => resetMemberContextLocked({ team, stateRoot: root, memberName: 'writer', reason: AUTO_RESET_REASON }),
    retry: async () => false,
  })
  assert.equal(outcome.accepted, false)
  assert.equal(outcome.retried, true)
  assert.equal(outcome.deliveryFailure, undefined, 'the retried dispatch owns its own reason; this path adds none')
  assert.equal((await readTeam(root, TEAM_ID)).members[0].id, '', 'the dead context stays replaced across the retry')
})
