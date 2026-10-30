import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createTeamDir } from '../lib/state.js'
import { registerAgentTeamsTools } from '../lib/tools.js'

function fakeAgent(id, cwd) {
  return {
    id, status: 'idle', options: { provider: 'p', model: 'm' },
    session: { id, seq: 0, header: { cwd, seedLength: 0 }, events: [], append() {}, snapshotEvents: () => [], requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) },
    followup() {}, steer() {}, cancel() {}, whenIdle() { return Promise.resolve() },
  }
}

async function fixture(t, { compactNow } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-190-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const stateRoot = join(workspace, '.agent-teams')
  const captain = fakeAgent('captain', workspace)
  const member = fakeAgent('child-1', workspace)
  await createTeamDir(stateRoot, {
    id: 'compact-team', name: 'Compact Team', captainSessionId: 'captain', createdAt: 1, phase: 'running', taskSeq: 0,
    members: [{ id: 'child-1', name: 'worker', joinedAt: 1, status: 'idle' }], tasks: [],
  })
  const definitions = new Map()
  const noop = () => {}
  const ctx = {
    effect(setup) { return setup() }, on() { return noop }, tools: { register(definition) { definitions.set(definition.name, definition) } },
    agents: { list: () => [captain, member], get: id => id === captain.id ? captain : id === member.id ? member : undefined },
    llm: { async listModels(provider) { return [{ provider, id: 'm', name: 'm' }] }, async resolveCallConfig(config) { return config } },
    subagents: { getProvider(name) { return name === 'spawn' ? { prepareContinuable() {}, capabilities: { persona: true, toolFilter: true } } : undefined }, list() { return ['spawn'] }, registerContinuableSetup() { return noop }, async followup() { return 'queued' }, async sendMessage() { return 'sent' }, interrupt() {}, async listChildren() { return [] }, async listDescendants() { return [] }, async drainContinuableChildren() {} },
    logger: { warn: noop, debug: noop },
    ...compactNow === undefined ? {} : { compaction: { compactNow } },
  }
  registerAgentTeamsTools(ctx, { stateDir: '.agent-teams', memberProvider: 'spawn', memberMaxDepth: 0, maxMembers: 8, profiles: {}, toolPolicies: {}, skills: {} })
  const call = args => definitions.get('agent_teams_compact_member').execute(args, { agent: captain, callId: 'compact-test', signal: new AbortController().signal })
  return { call, member }
}

test('#190 member compaction uses the host compaction service on the exact live session', async t => {
  let received
  const f = await fixture(t, { compactNow: async (agent, signal) => { received = { agent, signal }; return { summary: 'ok' } } })
  const result = await f.call({ member_name: 'worker', confirmed_by_user: true })
  assert.equal(result.compacted, true)
  assert.equal(received.agent.session, f.member.session)
  assert.deepEqual(received.agent.options, { provider: 'p', model: 'm' })
  assert.ok(received.signal instanceof AbortSignal)
})

test('#190 member compaction fails loud without host service or confirmation', async t => {
  const f = await fixture(t)
  await assert.rejects(() => f.call({ member_name: 'worker', confirmed_by_user: false }), /explicit user confirmation/)
  await assert.rejects(() => f.call({ member_name: 'worker', confirmed_by_user: true }), /no compaction service/)
})
