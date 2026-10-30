import assert from 'node:assert/strict'
import test from 'node:test'
import { usageSectionText } from '../lib/index.js'
import { memberPersona } from '../lib/members.js'
import { assignmentPrompt } from '../lib/scheduler.js'

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
