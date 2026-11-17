/**
 * M1: dispatch diagnostics and failure recovery.
 *
 * Four behaviours landed together in `4dbadab` and none of them had a test:
 *
 * - a member that keeps failing to start must stop being re-dispatched instead
 *   of spinning the scheduler and inflating its attempt counter (#350);
 * - a refused delivery must name the cause the plugin owns — "retired" (our
 *   retired-member guard) versus "no resumable session" (the host lost it) —
 *   because the host folds both terminal states into one `NOT_RESUMABLE` code;
 * - the staged-plan guard must say which operation was refused (#348);
 * - the failure counter must survive a state round trip, or the breaker resets
 *   on every read.
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
  lostSessionDeliveryFailure,
  memberDispatchPaused,
  memberSpawnFailureLimit,
  requireStagedTeam,
  retiredMemberDeliveryFailure,
  startedSessionEvidence,
} from '../lib/tools.js'
import { createTeamDir, readTeam } from '../lib/state.js'
import { removeTestTree } from './test-cleanup.mjs'

const withEnv = (value, fn) => {
  const previous = process.env['AGENT_TEAMS_MEMBER_SPAWN_FAILURE_LIMIT']
  if (value === undefined) delete process.env['AGENT_TEAMS_MEMBER_SPAWN_FAILURE_LIMIT']
  else process.env['AGENT_TEAMS_MEMBER_SPAWN_FAILURE_LIMIT'] = value
  try {
    return fn()
  } finally {
    if (previous === undefined) delete process.env['AGENT_TEAMS_MEMBER_SPAWN_FAILURE_LIMIT']
    else process.env['AGENT_TEAMS_MEMBER_SPAWN_FAILURE_LIMIT'] = previous
  }
}

test('the dispatch breaker stops re-dispatching a member that keeps failing', async t => {
  await t.test('the default limit tolerates two failures and pauses at three', () => {
    withEnv(undefined, () => {
      assert.equal(memberSpawnFailureLimit(), 3)
      assert.equal(memberDispatchPaused(undefined), false)
      assert.equal(memberDispatchPaused(0), false)
      assert.equal(memberDispatchPaused(2), false)
      assert.equal(memberDispatchPaused(3), true)
      assert.equal(memberDispatchPaused(16), true)
    })
  })

  await t.test('the env override replaces the default and rejects nonsense', () => {
    for (const configured of ['5', ' 5 ']) {
      withEnv(configured, () => assert.equal(memberSpawnFailureLimit(), 5))
    }
    // A zero, negative or non-numeric limit would disable the breaker entirely,
    // so every unusable value falls back to the bounded default.
    for (const configured of ['0', '-1', 'abc', '']) {
      withEnv(configured, () => assert.equal(memberSpawnFailureLimit(), 3))
    }
  })

  await t.test('an explicit limit argument wins over the environment', () => {
    withEnv('9', () => {
      assert.equal(memberDispatchPaused(3, 5), false)
      assert.equal(memberDispatchPaused(5, 5), true)
    })
  })

  await t.test('the failure counter survives a state round trip', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-m1-'))
    const stateRoot = join(workspace, '.agent-teams')
    t.after(() => removeTestTree(workspace))
    const now = Date.now()
    await createTeamDir(stateRoot, {
      id: 'w1', name: 'W1', captainSessionId: 'captain', createdAt: now,
      members: [
        { id: 'm-writer', name: 'writer', joinedAt: now, status: 'working', generation: 1, spawnFailures: 3, spawnError: 'boom' },
      ],
      tasks: [],
      taskSeq: 0,
      messageSeq: 0,
    })
    const team = await readTeam(stateRoot, 'w1')
    // Without this the breaker re-reads a team that always looks fresh.
    assert.equal(team.members[0].spawnFailures, 3)
    assert.equal(team.members[0].spawnError, 'boom')
    assert.equal(memberDispatchPaused(team.members[0].spawnFailures), true)
  })
})

test('a refused delivery names the cause the plugin owns', async t => {
  await t.test('retired and lost-session deliveries do not share one message', () => {
    const retired = retiredMemberDeliveryFailure('writer')
    const lost = lostSessionDeliveryFailure('writer', 'spawn exploded')
    assert.notEqual(retired, lost)
    // The host shows one generic sentence for both, so each message must carry
    // the distinguishing cause and a way out.
    assert.match(retired, /was retired/u)
    assert.match(retired, /Reset its context|remove the member/u)
    assert.match(lost, /no resumable session/u)
    assert.match(lost, /spawn exploded/u)
    assert.match(lost, /reassign the task|reset the member/u)
  })

  await t.test('a lost session without a recorded start error still reads', () => {
    assert.match(lostSessionDeliveryFailure('writer', undefined), /start error: unknown/u)
  })

  await t.test('both messages name the member that was refused', () => {
    assert.match(retiredMemberDeliveryFailure('drafter'), /"drafter"/u)
    assert.match(lostSessionDeliveryFailure('drafter', 'x'), /"drafter"/u)
  })
})

test('the staged-plan guard says which operation was refused', async t => {
  const staged = { name: 'T', phase: 'staged' }
  await t.test('a staged team passes and a halted one asks for a resume', () => {
    assert.doesNotThrow(() => requireStagedTeam(staged, 'approving a plan'))
    assert.throws(() => requireStagedTeam({ name: 'T', phase: 'staged', halted: true }, 'approving a plan'), /halted.*resume/u)
  })

  await t.test('a running team names the operation instead of the whole team', () => {
    const running = { name: 'T', phase: 'running' }
    assert.throws(() => requireStagedTeam(running, 'discarding a plan'), /discarding a plan/u)
    assert.throws(() => requireStagedTeam(running, 'editing this plan'), /editing this plan/u)
    // The old copy claimed the whole plan was locked; a running team still has
    // status and edit_plan, and the message must point there.
    assert.throws(() => requireStagedTeam(running, 'editing this plan'), /agent_teams_status|agent_teams_edit_plan/u)
  })
})

test('a reserved child id is not evidence that a session started', async t => {
  const member = (over = {}) => ({ id: 'child-1', name: 'worker', joinedAt: 0, status: 'idle', currentActivationId: 'a1', ...over })
  const pending = { activationId: 'a1', memberId: 'child-1', state: 'pending', startObserved: false }

  await t.test('the reserved id alone does not count, so a start failure is recorded', () => {
    // The scheduler writes the reserved child id before asking the host to start
    // the session (#350). Treating that id as "already has a session" kept the
    // failure counter at zero forever, so the breaker could never trip.
    assert.equal(startedSessionEvidence({ activations: [pending] }, member()), false)
  })

  await t.test('an observed start counts', () => {
    assert.equal(startedSessionEvidence({ activations: [{ ...pending, startObserved: true }] }, member()), true)
    assert.equal(startedSessionEvidence({ activations: [{ ...pending, state: 'started' }] }, member()), true)
    assert.equal(startedSessionEvidence({ activations: [{ ...pending, startedAt: 7 }] }, member()), true)
  })

  await t.test('a member without any lease keeps the strict reading', () => {
    assert.equal(startedSessionEvidence({}, member({ currentActivationId: undefined })), true)
    assert.equal(startedSessionEvidence({ activations: [] }, member({ id: '' })), false)
  })
})
