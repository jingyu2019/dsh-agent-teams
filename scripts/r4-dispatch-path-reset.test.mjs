/**
 * R4 收尾: a dead child session is reclaimed before the guarded reset runs.
 *
 * The reset guard refuses a member that is working, owns an open attempt, or
 * holds an active lease — and on the task-dispatch path all three are usually
 * true when the child session dies. The fix is to clear that wreckage first
 * (attempt closed as failed, lease ended, permit released) and then call the very
 * same guarded reset. The guard is not loosened anywhere: a member that still
 * owns something open after the cleanup is refused exactly as before.
 *
 * These import the source tree directly (`../src/tools.ts`), like
 * `p0-5-idempotency.test.mjs`, so no build step is needed.
 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  AUTO_RESET_REASON,
  dispatchResetFailure,
  reclaimDeadSessionDelivery,
  recoverLostSessionDelivery,
  resetMemberContextLocked,
} from '../src/tools.ts'
import { createTeamDir, readRetiredMemberIds, readTeam, recordRetiredMemberIds } from '../src/state.ts'
import { removeTestTree } from './test-cleanup.mjs'

const TEAM_ID = 'r4-dispatch-team'
const FAILURE = 'member "writer" has no resumable session (start error: NOT_RESUMABLE)'

const lease = (overrides = {}) => ({
  activationId: 'v1',
  dispatchToken: 'dispatch-1',
  teamId: TEAM_ID,
  memberId: 'dead-session',
  memberGeneration: 1,
  activationEpoch: 1,
  purpose: 'task',
  preDispatchSessionSeq: 0,
  startObserved: true,
  endObserved: false,
  state: 'started',
  permitHeld: true,
  createdAt: 1,
  startedAt: 2,
  ...overrides,
})

const openTask = (overrides = {}) => ({
  id: 't1',
  subject: 'finish the report',
  status: 'in_progress',
  assignee: 'writer',
  attempt: 1,
  attemptId: 'attempt-1',
  revision: 1,
  dependencies: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
})

const teamState = (overrides = {}) => ({
  id: TEAM_ID,
  name: 'R4 Dispatch Team',
  captainSessionId: 'captain',
  createdAt: 1,
  phase: 'running',
  taskSeq: 0,
  members: [{ id: 'dead-session', name: 'writer', joinedAt: 1, status: 'working', provider: 'p', model: 'm', generation: 1, currentActivationId: 'v1' }],
  tasks: [openTask()],
  activations: [lease()],
  ...overrides,
})

async function withState(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-r4-dispatch-'))
  t.after(() => removeTestTree(root))
  await createTeamDir(root, teamState(overrides))
  return root
}

test('a dead session with an open attempt is reclaimed, then the guarded reset succeeds', async t => {
  const root = await withState(t)
  const team = await readTeam(root, TEAM_ID)
  const revisionBefore = team.tasks[0].revision

  const reclaim = await reclaimDeadSessionDelivery({ team, stateRoot: root, memberName: 'writer', failure: FAILURE })
  assert.deepEqual(reclaim.closedAttempts, ['t1'], 'the open attempt must be closed')
  assert.deepEqual(reclaim.releasedLeases, ['v1'], 'the lease must be ended')
  assert.equal(reclaim.retired, false)
  assert.equal(reclaim.live, false)
  assert.equal(reclaim.remainingOpenAttempts, 0)
  assert.equal(reclaim.activeLeases, 0)
  assert.equal(team.members[0].status, 'idle', 'a reclaimed member is idle, not forcibly reset while working')
  assert.equal(team.members[0].currentActivationId, undefined)
  assert.equal(team.tasks[0].status, 'pending', 'the dead attempt returns the task to the queue, it is not failed')
  assert.equal(team.tasks[0].attemptId, undefined, 'the dead attempt is not left open')
  assert.match(team.tasks[0].output, /^lost session \(member "writer" has no resumable session \(start error: NOT_RESUMABLE\)/)
  assert.match(team.tasks[0].output, /returned to the queue for a fresh dispatch/u)
  assert.ok(team.tasks[0].revision > revisionBefore, 'closing the attempt must bump the revision')
  assert.equal(team.activations[0].state, 'ended')
  assert.equal(team.activations[0].permitHeld, false, 'the permit must be released, not just the state')
  assert.equal(team.activations[0].settlementApplied, true)
  assert.equal(team.activations[0].startedAt, 2, 'startedAt is the lease history, never rewritten by a reclaim')

  const persisted = await readTeam(root, TEAM_ID)
  assert.equal(persisted.tasks[0].status, 'pending')
  assert.equal(persisted.activations[0].permitHeld, false)

  const reset = await resetMemberContextLocked({ team: persisted, stateRoot: root, memberName: 'writer', reason: AUTO_RESET_REASON })
  assert.equal(reset.reset, true, 'the reset must now pass its own unchanged guard')
  const after = await readTeam(root, TEAM_ID)
  assert.equal(after.members[0].id, '')
  assert.equal(after.members[0].status, 'idle')
  const trail = after.timeline.filter(entry => entry.action === 'member.context_reset')
  assert.equal(trail.length, 1, 'exactly one reset is recorded')
  assert.equal(trail[0].result, AUTO_RESET_REASON)
})

test('a retired member is not reclaimed and not reset', async t => {
  const root = await withState(t)
  await recordRetiredMemberIds(root, ['dead-session'])
  const team = await readTeam(root, TEAM_ID)
  assert.ok((await readRetiredMemberIds(root)).has('dead-session'))

  const reclaim = await reclaimDeadSessionDelivery({ team, stateRoot: root, memberName: 'writer', failure: FAILURE })
  assert.equal(reclaim.retired, true)
  assert.deepEqual(reclaim.closedAttempts, [])
  assert.deepEqual(reclaim.releasedLeases, [])
  assert.equal(team.tasks[0].status, 'in_progress', 'a retired member keeps its record untouched')
  assert.equal(team.activations[0].state, 'started')
  assert.equal(team.activations[0].permitHeld, true)

  const reason = dispatchResetFailure('writer', 'retired')
  assert.match(reason, /retired on purpose/)
  assert.equal(
    (await recoverLostSessionDelivery({ cause: 'lost-session', failure: FAILURE, reset: async () => { throw new Error(reason) }, retry: async () => true })).deliveryFailure?.includes('automatic context reset refused: '),
    true,
    'a refusal is reported, never routed around',
  )
})

test('a live child session is left alone', async t => {
  const root = await withState(t)
  const team = await readTeam(root, TEAM_ID)
  const reclaim = await reclaimDeadSessionDelivery({ team, stateRoot: root, memberName: 'writer', failure: FAILURE, sessionRunning: true })
  assert.equal(reclaim.live, true)
  assert.deepEqual(reclaim.closedAttempts, [])
  assert.equal(team.tasks[0].status, 'in_progress')
  assert.equal(team.members[0].status, 'working', 'a running member is never reclaimed')
  assert.match(dispatchResetFailure('writer', 'session-alive'), /still has a live session; nothing was reset/)
})

test('the three refusal reasons are distinct and name their own exit', () => {
  const texts = (['retired', 'open-attempt', 'session-alive'])
    .map(reason => dispatchResetFailure('writer', reason))
  assert.equal(new Set(texts).size, 3, 'each refusal must be distinguishable')
  assert.match(texts[0], /retired on purpose/)
  assert.match(texts[1], /still owns an open attempt that could not be reclaimed/)
  assert.match(texts[1], /finish or reassign that attempt, then retry the dispatch/)
  assert.match(texts[2], /still has a live session/)
  for (const text of texts) assert.match(text, /"writer"/)
})

test('a member left working by the cleanup still refuses the reset', async t => {
  // A lease in a non-active state does not block the guard, so the member keeps
  // its 'working' status and the guarded reset must still refuse — the cleanup
  // never turns into a bypass.
  const root = await withState(t, { members: [{ id: 'dead-session', name: 'writer', joinedAt: 1, status: 'working', provider: 'p', model: 'm', generation: 1 }], tasks: [], activations: [lease({ state: 'orphaned', permitHeld: false })] })
  const team = await readTeam(root, TEAM_ID)
  const reclaim = await reclaimDeadSessionDelivery({ team, stateRoot: root, memberName: 'writer', failure: FAILURE })
  assert.deepEqual(reclaim.closedAttempts, [])
  assert.deepEqual(reclaim.releasedLeases, [])
  await assert.rejects(
    () => resetMemberContextLocked({ team, stateRoot: root, memberName: 'writer', reason: AUTO_RESET_REASON }),
    /is running; wait until it is idle/,
  )
})

test('the delivery is retried exactly once and a second failure stops there', async () => {
  const attempts = []
  const outcome = await recoverLostSessionDelivery({
    cause: 'lost-session',
    failure: FAILURE,
    reset: async () => { attempts.push('reset') },
    retry: async () => { attempts.push('retry'); return false },
  })
  assert.deepEqual(attempts, ['reset', 'retry'], 'one reset and one retry, never a loop')
  assert.equal(outcome.retried, true)
  assert.equal(outcome.accepted, false)
  assert.equal(outcome.deliveryFailure, undefined, 'the retried dispatch records its own refusal')

  const retired = await recoverLostSessionDelivery({ cause: 'retired', failure: FAILURE, reset: async () => { attempts.push('reset-retired') }, retry: async () => true })
  assert.equal(retired.retried, false)
  assert.equal(attempts.includes('reset-retired'), false, 'a retired delivery is never reset')
})