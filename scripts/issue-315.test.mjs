import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadAgentLibrary } from '../lib/agent-library.js'
import { createTeamDir, readTeam } from '../lib/state.js'
import { registerAgentTeamsTools } from '../lib/tools.js'

function fakeAgent(id, cwd) {
  return {
    id, status: 'idle', options: { provider: 'p', model: 'm' },
    session: {
      id, seq: 0, header: { cwd, seedLength: 0 }, events: [], append() {},
      snapshotEvents: () => [], requestHeader: () => ({ config: { provider: 'p', model: 'm', reasoningEffort: 'high' } }),
    },
    followup() {}, steer() {}, cancel() {}, whenIdle() { return Promise.resolve() },
  }
}

async function fixture(t, { enabled = true } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-315-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const stateRoot = join(workspace, '.agent-teams')
  const captain = fakeAgent('captain', workspace)
  const definitions = new Map()
  const noop = () => {}
  const ctx = {
    effect(setup) { return setup() }, on() { return noop },
    tools: { register(definition) { definitions.set(definition.name, definition) } },
    agents: { list: () => [captain], get: id => id === captain.id ? captain : undefined },
    llm: { async listModels(provider) { return [{ provider, id: 'm', name: 'm' }] }, async resolveCallConfig(config) { return config } },
    subagents: {
      getProvider(name) { return name === 'spawn' ? { prepareContinuable() {}, capabilities: { persona: true, toolFilter: true } } : undefined },
      list() { return ['spawn'] }, registerContinuableSetup() { return noop },
      async followup() { return 'queued' }, async sendMessage() { return 'sent' }, interrupt() {},
      async listChildren() { return [] }, async listDescendants() { return [] }, async drainContinuableChildren() {},
    },
    logger: { warn: noop, debug: noop },
  }
  registerAgentTeamsTools(ctx, {
    stateDir: '.agent-teams', memberProvider: 'spawn', memberMaxDepth: 0, maxMembers: 8,
    profiles: {}, toolPolicies: {}, skills: {}, agentLibrary: { enabled },
  })
  await createTeamDir(stateRoot, {
    id: 'preset-team', name: 'Preset Team', captainSessionId: 'captain', createdAt: 1, phase: 'running', taskSeq: 0, members: [], tasks: [],
  })
  const call = (name, args) => definitions.get(name).execute(args, { agent: captain, callId: `${name}-test`, signal: new AbortController().signal })
  return { workspace, stateRoot, captain, call }
}

test('#315 preset revisions persist and are copied immutably into members', async t => {
  const f = await fixture(t)
  const first = await f.call('agent_teams_save_agent_preset', {
    name: 'Researcher', role: 'Reads sources', provider: 'p', model: 'm', execution_prompt: 'Research carefully', skill_ids: [],
  })
  assert.equal(first.revision, 1)
  const second = await f.call('agent_teams_save_agent_preset', {
    id: first.id, name: 'Researcher', role: 'Reads sources', provider: 'p', model: 'm', execution_prompt: 'Research carefully and cite', skill_ids: [],
  })
  assert.equal(second.revision, 2)
  const listed = await f.call('agent_teams_list_agent_presets', {})
  assert.equal(listed.presets.length, 1)
  assert.equal(listed.presets[0].revision, 2)

  await f.call('agent_teams_add_member', { name: 'Scout', preset_id: first.id })
  const team = await readTeam(f.stateRoot, 'preset-team')
  assert.equal(team.members[0].role, 'Reads sources')
  assert.equal(team.members[0].executionPrompt, 'Research carefully and cite')
  assert.equal(team.members[0].presetId, first.id)
  assert.equal(team.members[0].presetRevision, 2)

  await f.call('agent_teams_save_agent_preset', {
    id: first.id, name: 'Researcher', role: 'Changed', provider: 'p', model: 'm', execution_prompt: 'Changed prompt', skill_ids: [],
  })
  const unchanged = await readTeam(f.stateRoot, 'preset-team')
  assert.equal(unchanged.members[0].role, 'Reads sources')
  assert.equal(unchanged.members[0].executionPrompt, 'Research carefully and cite')

  assert.equal((await f.call('agent_teams_delete_agent_preset', { id: first.id })).deleted, true)
  assert.equal((await loadAgentLibrary(f.stateRoot)).presets.length, 0)
  assert.equal((await readTeam(f.stateRoot, 'preset-team')).members.length, 1)
})

test('#315 invalid preset input fails before persistence and disabled library rejects writes', async t => {
  const f = await fixture(t)
  await assert.rejects(
    () => f.call('agent_teams_save_agent_preset', { name: 'Bad', role: 'x', provider: 'p', model: 'm', execution_prompt: 'x', skill_ids: ['missing-skill'] }),
    /unknown skill|skill id|missing-skill/i,
  )
  await assert.rejects(
    () => f.call('agent_teams_save_agent_preset', { name: 'Bad model', role: 'x', provider: 'p', model: 'missing-model', execution_prompt: 'x', skill_ids: [] }),
    /missing-model|model/i,
  )
  assert.equal((await loadAgentLibrary(f.stateRoot)).presets.length, 0)
  const disabled = await fixture(t, { enabled: false })
  await assert.rejects(
    () => disabled.call('agent_teams_save_agent_preset', { name: 'Off', role: 'x', provider: 'p', model: 'm', execution_prompt: 'x', skill_ids: [] }),
    /library is disabled/,
  )
})

test('#315 preset selection has a UI listing and manual-create picker', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const panel = readFileSync(new URL('../src/client/ActivityPanel.tsx', import.meta.url), 'utf8')
  assert.match(source, /path: '\/plugins\/dsh-agent-teams\/agent-library'/u)
  assert.match(panel, /agent-library\?sessionId=/u)
  assert.match(panel, /preset_id: presetId/u)
})
