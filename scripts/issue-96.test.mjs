import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { installTeamCapabilities } from '../lib/capabilities.js'
import { resolveToolsConfig } from '../lib/index.js'
import { CORE_CAPTAIN_TOOL_NAMES, TEAM_TOOL_NAMES } from '../lib/tool-names.js'

async function fakeHost(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-96-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const restrictions = []
  const agent = {
    id: 'captain', status: 'idle', session: { id: 'captain', header: { cwd: workspace, seedLength: 0 }, events: [] },
    ctx: {
      tools: { restrict(options) { restrictions.push(options); return () => {} } },
      effect(setup) { return setup() },
    },
  }
  const sections = []
  const ctx = {
    on() { return () => {} },
    effect(setup) { return setup() },
    logger: { warn() {}, debug() {} },
    systemPrompt: { section(definition) { sections.push(definition) } },
    agents: { list: () => [agent] },
  }
  return { workspace, agent, ctx, restrictions, sections }
}

test('#96 toolSurface=core hides advanced tools while keeping a stable compact surface', async t => {
  const host = await fakeHost(t)
  installTeamCapabilities(host.ctx, {
    stateDir: '.agent-teams',
    isPendingMember: () => false,
    captainPrompt: () => 'core prompt',
    toolSurface: 'core',
  })
  assert.equal(host.restrictions.length, 1)
  const deny = host.restrictions[0].deny
  for (const name of CORE_CAPTAIN_TOOL_NAMES) assert.ok(!deny.includes(name), `${name} must stay visible`)
  for (const name of ['agent_teams_edit_plan', 'agent_teams_worktree', 'agent_teams_save_agent_preset', 'agent_teams_amend_task']) {
    assert.ok(deny.includes(name), `${name} must be hidden`)
  }
  assert.ok(CORE_CAPTAIN_TOOL_NAMES.length < TEAM_TOOL_NAMES.length)
})

test('#96 full tool surface remains the default and core resolves through owner config', async t => {
  const host = await fakeHost(t)
  installTeamCapabilities(host.ctx, {
    stateDir: '.agent-teams',
    isPendingMember: () => false,
    captainPrompt: () => 'full prompt',
  })
  assert.equal(host.restrictions.length, 0)
  const resolved = resolveToolsConfig({ profiles: {}, toolPolicies: {}, skills: {}, toolSurface: 'core' })
  assert.equal(resolved.toolSurface, 'core')
})
