import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createTeamDir, readRetiredMemberIds, readTeam } from '../lib/state.js'
import { registerAgentTeamsTools } from '../lib/tools.js'

function fakeAgent(id, cwd) {
  return {
    id, status: 'idle', options: { provider: 'p', model: 'm' },
    session: { id, seq: 0, header: { cwd, seedLength: 0 }, events: [], append() {}, snapshotEvents: () => [], requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) },
    followup() {}, steer() {}, cancel() {}, whenIdle() { return Promise.resolve() },
  }
}

async function fixture(t, taskExtra = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-162-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const stateRoot = join(workspace, '.agent-teams')
  const captain = fakeAgent('captain', workspace)
  await createTeamDir(stateRoot, {
    id: 'context-team', name: 'Context Team', captainSessionId: 'captain', createdAt: 1, phase: 'running', taskSeq: 1,
    members: [{ id: 'child-old', name: 'worker', joinedAt: 1, status: 'idle', generation: 1 }],
    tasks: [{ id: 't1', subject: 'Work', status: taskExtra.status ?? 'pending', assignee: 'worker', dependencies: [], attempt: taskExtra.attempt ?? 0, ...taskExtra.attemptId === undefined ? {} : { attemptId: taskExtra.attemptId }, createdAt: 1, updatedAt: 1 }],
  })
  const definitions = new Map()
  const noop = () => {}
  const ctx = {
    effect(setup) { return setup() }, on() { return noop }, tools: { register(definition) { definitions.set(definition.name, definition) } },
    agents: { list: () => [captain], get: id => id === captain.id ? captain : undefined },
    llm: { async listModels(provider) { return [{ provider, id: 'm', name: 'm' }] }, async resolveCallConfig(config) { return config } },
    subagents: { getProvider(name) { return name === 'spawn' ? { prepareContinuable() {}, capabilities: { persona: true, toolFilter: true } } : undefined }, list() { return ['spawn'] }, registerContinuableSetup() { return noop }, async followup() { return 'queued' }, async sendMessage() { return 'sent' }, interrupt() {}, async listChildren() { return [] }, async listDescendants() { return [] }, async drainContinuableChildren() {} },
    logger: { warn: noop, debug: noop },
  }
  registerAgentTeamsTools(ctx, { stateDir: '.agent-teams', memberProvider: 'spawn', memberMaxDepth: 0, maxMembers: 8, profiles: {}, toolPolicies: {}, skills: {} })
  const call = args => definitions.get('agent_teams_reset_member_context').execute(args, { agent: captain, callId: 'reset-test', signal: new AbortController().signal })
  return { stateRoot, call }
}

test('#162 explicit context reset retires the old child and preserves the roster', async t => {
  const f = await fixture(t)
  await assert.rejects(() => f.call({ member_name: 'worker', confirmed_by_user: false }), /requires explicit user confirmation/)
  const result = await f.call({ member_name: 'worker', confirmed_by_user: true })
  assert.equal(result.reset, true)
  const team = await readTeam(f.stateRoot, 'context-team')
  assert.equal(team.members[0].id, '')
  assert.equal(team.members[0].generation, 2)
  assert.ok(team.timeline.some(entry => entry.action === 'member.context_reset'))
  assert.deepEqual([...(await readRetiredMemberIds(f.stateRoot))], ['child-old'])
  assert.equal((await f.call({ member_name: 'worker', confirmed_by_user: true })).reset, false)
})

test('#162 context reset refuses an open attempt', async t => {
  const f = await fixture(t, { status: 'in_progress', attempt: 1, attemptId: 'a1' })
  await assert.rejects(() => f.call({ member_name: 'worker', confirmed_by_user: true }), /open attempt/)
  assert.equal((await readTeam(f.stateRoot, 'context-team')).members[0].id, 'child-old')
})
