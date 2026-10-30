import assert from 'node:assert/strict'
import test from 'node:test'
import { FINAL_REPORT_GRACE_MS, isCurrentMail, isFinalReportForSettlement } from '../lib/mailbox.js'

const now = Date.now()
function fixture(overrides = {}) {
  const lease = {
    activationId: 'a1', dispatchToken: 'd1', teamId: 'w1', memberId: 'child-1', memberGeneration: 2,
    activationEpoch: 4, purpose: 'task', taskId: 't1', attempt: 3, attemptId: 'attempt-1', hostRunId: 'r1',
    preDispatchSessionSeq: 0, startObserved: true, endObserved: true, state: 'released', permitHeld: false,
    createdAt: now, endedAt: now, releasedAt: now, stopReason: 'completed', ...overrides.lease,
  }
  const message = {
    id: 'm1', from: 'worker', to: 'captain', content: 'done', ts: now, reportKind: 'final',
    sourceTaskId: 't1', sourceAttemptId: 'attempt-1', sourceTaskStatus: 'in_progress',
    sourceMemberId: 'child-1', sourceMemberGeneration: 2, sourceActivationId: 'a1', sourceActivationEpoch: 4,
    deliveredAt: now, ...overrides.message,
  }
  const task = {
    id: 't1', subject: 'Work', status: 'completed', assignee: 'worker', dependencies: [], attempt: 3,
    attemptId: 'attempt-1', attemptMemberId: 'child-1', attemptGeneration: 2,
    attemptActivationId: 'a1', attemptActivationEpoch: 4, createdAt: now, updatedAt: now, ...overrides.task,
  }
  return {
    lease,
    message,
    team: { id: 'w1', name: 'W1', captainSessionId: 'captain', createdAt: now, members: [], tasks: [task], taskSeq: 1, activations: [lease], ...overrides.team },
  }
}

test('exact final is bound to task, attempt, member generation and activation', () => {
  const f = fixture()
  assert.equal(isFinalReportForSettlement(f.team, f.message, 'child-1', f.lease), true)
})

test('different task cannot suppress settlement', () => {
  const f = fixture({ message: { sourceTaskId: 't2' } })
  assert.equal(isFinalReportForSettlement(f.team, f.message, 'child-1', f.lease), false)
})

test('old attempt cannot suppress a newer settlement', () => {
  const f = fixture({ message: { sourceAttemptId: 'attempt-old' } })
  assert.equal(isFinalReportForSettlement(f.team, f.message, 'child-1', f.lease), false)
})

test('old activation or generation cannot suppress', () => {
  const f = fixture({ message: { sourceActivationId: 'a-old', sourceMemberGeneration: 1 } })
  assert.equal(isFinalReportForSettlement(f.team, f.message, 'child-1', f.lease), false)
})

test('progress-only report never suppresses', () => {
  const f = fixture({ message: { reportKind: 'progress' } })
  assert.equal(isFinalReportForSettlement(f.team, f.message, 'child-1', f.lease), false)
})

test('final-before-update remains readable after terminal transition', () => {
  const f = fixture()
  assert.equal(isCurrentMail(f.team, f.message), true)
})

test('progress with a terminal source status does not inherit final readability', () => {
  const f = fixture({ message: { reportKind: 'progress' } })
  assert.equal(isCurrentMail(f.team, f.message), false)
})

test('final report grace is exactly the bounded default', () => {
  assert.equal(FINAL_REPORT_GRACE_MS, 500)
})

test('native settlement is suppressed only by an exact final inside the grace', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { appendMailbox, createTeamDir } = await import('../lib/state.js')
  const { installMailboxAdmission } = await import('../lib/mailbox.js')
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-w1d-'))
  const stateRoot = join(workspace, '.agent-teams')
  const f = fixture()
  f.team.tasks[0].status = 'completed'
  await createTeamDir(stateRoot, f.team)
  await appendMailbox(stateRoot, 'w1', 'captain', f.message)
  const listeners = new Map()
  const captainSession = { id: 'captain', header: { cwd: workspace }, ownEvents: () => [] }
  const ctx = {
    agents: { get: id => id === 'captain' ? { id: 'captain', session: captainSession } : undefined, list: () => [] },
    on(name, fn) { listeners.set(name, fn); return () => {} },
    logger: { warn() {} },
  }
  installMailboxAdmission(ctx, '.agent-teams')
  const previous = process.env.AGENT_TEAMS_FINAL_REPORT_GRACE_MS
  process.env.AGENT_TEAMS_FINAL_REPORT_GRACE_MS = '100'
  try {
    const decision = {
      kind: 'enter',
      messages: [{ source: {
        kind: 'subagent-settled', senderSessionId: 'child-1',
        summary: 'Background subagent child-1 finished and will do no further work unless you send it more.',
      }, content: [{ type: 'text', text: 'settled' }] }],
    }
    const result = await listeners.get('agent/pre-step')({ agent: { id: 'captain', session: captainSession }, turn: 1 }, async () => decision)
    assert.equal(result.kind, 'reject')
  } finally {
    if (previous === undefined) delete process.env.AGENT_TEAMS_FINAL_REPORT_GRACE_MS
    else process.env.AGENT_TEAMS_FINAL_REPORT_GRACE_MS = previous
    await rm(workspace, { recursive: true, force: true })
  }
})
