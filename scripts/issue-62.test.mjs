import assert from 'node:assert/strict'
import test from 'node:test'
import { usageSectionText } from '../lib/index.js'
import { memberPersona, spawnMember } from '../lib/members.js'
import { assignmentPrompt } from '../lib/scheduler.js'
import { installTeamScheduler } from '../lib/scheduler.js'
import { createTeamDir } from '../lib/state.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memberRuntime, schedulerRuntimeConfig } from '../lib/tools.js'

const team = { id: 'team', name: 'Team', description: 'goal', captainSessionId: 'c', createdAt: 0, members: [], tasks: [], taskSeq: 0 }
const member = { name: 'worker', id: 'child', role: 'impl', joinedAt: 0, status: 'idle' }
const ticket = { taskId: 't1', memberName: 'worker', memberId: 'child', attempt: 1, attemptId: 'a1', subject: 'Work', dependencyOutputs: [] }

test('parallel emission defaults off on every prompt surface', () => {
  assert.equal(usageSectionText('tools').includes('Parallel Emission'), false)
  assert.equal(memberPersona(team, member, '.agent-teams').includes('Parallel Emission'), false)
  assert.equal(assignmentPrompt(ticket, '.agent-teams', 'team').includes('Parallel Emission'), false)
})

test('parallel emission opt-in changes prompt guidance only', () => {
  const usageOn = usageSectionText('tools', '', true)
  const personaOn = memberPersona(team, member, '.agent-teams', undefined, true)
  const assignmentOn = assignmentPrompt(ticket, '.agent-teams', 'team', [], true)
  assert.match(usageOn, /Parallel Emission is enabled/)
  assert.match(personaOn, /Parallel Emission is enabled/)
  assert.match(assignmentOn, /Parallel Emission is enabled/)
  assert.doesNotMatch(assignmentOn, /dependencies[\s\S]*removed/i)
})

test('dependency wording remains exclusive and does not promise same-response forward references', () => {
  const assignmentOn = assignmentPrompt(ticket, '.agent-teams', 'team', [], true)
  assert.match(assignmentOn, /dependency ids must already exist/i)
  assert.match(assignmentOn, /never assume a same-response forward reference/i)
})

test('real spawn path carries the opt-in flag into the member persona', async () => {
  let received
  const ctx = { subagents: {
    getProvider: () => ({ prepareContinuable() {}, capabilities: { persona: true, toolFilter: true } }),
    startContinuable: async spec => { received = spec; return { childId: 'child' } },
  } }
  const captain = { id: 'captain' }
  const draft = { id: 'team', name: 'Team', captainSessionId: captain.id, members: [], tasks: [], createdAt: 1, taskSeq: 0 }
  const worker = { id: '', name: 'worker', role: 'impl', joinedAt: 1, status: 'idle' }
  const signal = new AbortController().signal
  await spawnMember(ctx, { provider: 'spawn', parallelToolCalls: true },
    { withPending: (_parent, _label, _selection, operation) => operation() },
    { provider: 'p', model: 'm' }, captain, draft, worker, '.agent-teams', signal)
  assert.match(received.request.persona, /Parallel Emission is enabled/)
})

test('scheduler config carries the opt-in into the dispatched assignment', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-w2-parallel-'))
  const stateRoot = join(workspace, '.agent-teams')
  const captain = { id: 'captain', status: 'idle', session: { seq: 0, header: { cwd: workspace }, snapshotEvents: () => [] }, followup() {}, steer() {}, cancel() {} }
  await createTeamDir(stateRoot, {
    id: 'team', name: 'Team', captainSessionId: 'captain', createdAt: 1,
    members: [{ id: 'child', name: 'worker', joinedAt: 1, status: 'idle', generation: 1 }],
    tasks: [{ id: 't1', subject: 'Work', status: 'pending', assignee: 'worker', dependencies: [], attempt: 0, createdAt: 1, updatedAt: 1 }], taskSeq: 1,
  })
  let prompt = ''
  const ctx = {
    agents: { get: id => id === 'captain' ? captain : undefined, list: () => [captain] },
    subagents: { followup: async () => 'accepted' },
    logger: { warn() {} }, on() { return () => {} },
    get(name) { return name === 'sessionQuery' ? { observeSession: async () => ({ events: [] }) } : undefined },
  }
  const scheduler = installTeamScheduler(ctx, { stateDir: '.agent-teams', parallelToolCalls: true, dispatch: async (_c, _t, _m, text) => { prompt = text; return { accepted: true } } })
  try {
    await scheduler.kickMember(workspace, 'team', 'worker', captain)
    assert.match(prompt, /Parallel Emission is enabled/)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('registration config seams propagate the opt-in to scheduler and member runtime', () => {
  const config = { stateDir: '.agent-teams', memberProvider: 'spawn', memberMaxDepth: 0, maxMembers: 8, parallelToolCalls: true, profiles: {}, toolPolicies: {} }
  assert.equal(schedulerRuntimeConfig(config, async () => true).parallelToolCalls, true)
  assert.equal(memberRuntime(config).parallelToolCalls, true)
})
