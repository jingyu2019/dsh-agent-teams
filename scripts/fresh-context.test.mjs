/**
 * Fresh member context per task (`freshContext`).
 *
 * A captain may want an unrelated task to start in an empty member
 * conversation: the roster row, route, skills, tool policy and worktree lane
 * stay, only the durable child session is retired. The scheduler must never
 * trade live work for that hint, so the decision is a pure predicate and a
 * refused reset degrades to a normal dispatch turn.
 *
 * These import the built output (`../lib/*.js`) like the other regression
 * scripts; run `npm run build` before running them directly.
 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { freshContextEligibility, resetMemberContextForDispatch } from '../lib/members.js'
import { createTeamDir, readTeam } from '../lib/state.js'
import { removeTestTree } from './test-cleanup.mjs'

const now = Date.now()

const member = (overrides = {}) => ({
  name: 'writer', id: 'm-writer', joinedAt: now, status: 'idle', generation: 1, ...overrides,
})

const task = (overrides = {}) => ({
  id: 't1', subject: 'unrelated work', status: 'pending', attempt: 0, revision: 1,
  dependencies: [], createdAt: now, updatedAt: now, ...overrides,
})

test('an idle member with no live work is eligible for a fresh context', () => {
  const decision = freshContextEligibility({ tasks: [], activations: [] }, member(), task())
  assert.deepEqual(decision, { eligible: true })
})

test('a member without a session needs no reset', () => {
  const decision = freshContextEligibility({ tasks: [], activations: [] }, member({ id: '' }), task())
  assert.equal(decision.eligible, false)
  assert.equal(decision.reason, 'member has no session yet')
})

test('live work always wins over the hint', () => {
  const working = freshContextEligibility({ tasks: [], activations: [] }, member({ status: 'working' }), task())
  assert.equal(working.reason, 'member is working')
  const stopping = freshContextEligibility({ tasks: [], activations: [] }, member({ stopping: true }), task())
  assert.equal(stopping.reason, 'member is stopping')
  const otherAttempt = freshContextEligibility(
    { tasks: [task({ id: 't9', assignee: 'writer', status: 'in_progress', attemptId: 'a1' })], activations: [] },
    member(),
    task(),
  )
  assert.equal(otherAttempt.reason, 'member owns another open attempt')
  const leased = freshContextEligibility(
    { tasks: [], activations: [{ activationId: 'v1', memberId: 'm-writer', kind: 'task', state: 'started' }] },
    member(),
    task(),
  )
  assert.equal(leased.reason, 'member has an active activation')
})

test('the reset retires the session and keeps the roster row', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-teams-fresh-context-'))
  try {
    await createTeamDir(stateRoot, {
      id: 'f1', name: 'F1', captainSessionId: 'captain', createdAt: now,
      members: [member()],
      tasks: [task({ freshContext: true })],
      taskSeq: 1,
      messageSeq: 0,
    })
    const team = await readTeam(stateRoot, 'f1')
    assert.equal(team.tasks[0].freshContext, true)

    const outcome = await resetMemberContextForDispatch({
      stateRoot,
      team,
      memberName: 'writer',
      reason: 'fresh context requested by t1',
      task: team.tasks[0],
    })
    assert.deepEqual(outcome, { reset: true, previousMemberId: 'm-writer' })

    const persisted = await readTeam(stateRoot, 'f1')
    assert.equal(persisted.members[0].id, '')
    assert.equal(persisted.members[0].status, 'idle')
    assert.equal(persisted.members[0].generation, 2)
    const reset = (persisted.timeline ?? []).filter(entry => entry.action === 'member.context_reset')
    assert.equal(reset.length, 1)
    assert.equal(reset[0].from, 'writer')
  } finally {
    await removeTestTree(stateRoot)
  }
})

test('a refused reset leaves the live session untouched', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-teams-fresh-context-'))
  try {
    await createTeamDir(stateRoot, {
      id: 'f2', name: 'F2', captainSessionId: 'captain', createdAt: now,
      members: [member({ status: 'working' })],
      tasks: [task({ freshContext: true })],
      taskSeq: 1,
      messageSeq: 0,
    })
    const team = await readTeam(stateRoot, 'f2')
    const outcome = await resetMemberContextForDispatch({
      stateRoot, team, memberName: 'writer', reason: 'fresh context requested by t1', task: team.tasks[0],
    })
    assert.deepEqual(outcome, { reset: false, reason: 'member is working' })
    const persisted = await readTeam(stateRoot, 'f2')
    assert.equal(persisted.members[0].id, 'm-writer')
    assert.equal(persisted.members[0].generation, 1)
  } finally {
    await removeTestTree(stateRoot)
  }
})