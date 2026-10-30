import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readTeam } from '../lib/state.js'
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

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-279-manual-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const captain = fakeAgent('captain', workspace)
  const noop = () => {}
  const ctx = {
    effect(setup) { return setup() }, on() { return noop },
    tools: { register() {} },
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
  const runtime = registerAgentTeamsTools(ctx, { stateDir: '.agent-teams', memberProvider: 'spawn', memberMaxDepth: 0, maxMembers: 8, profiles: {}, toolPolicies: {}, skills: {} })
  return { workspace, captain, runtime }
}

test('#279 manual creation persists a staged plan and rejects a second live team', async t => {
  const f = await fixture(t)
  const created = await f.runtime.createStagedTeam(f.captain, {
    name: 'Manual Team', description: 'manual goal',
    members: [{ name: 'worker', role: 'worker' }],
    tasks: [{ subject: 'Do the work', assignee: 'worker' }],
  })
  assert.equal(created.phase, 'staged')
  assert.equal(created.planReviewState, 'awaiting_review')
  const team = await readTeam(join(f.workspace, '.agent-teams'), created.id)
  assert.equal(team.name, 'Manual Team')
  assert.equal(team.members.length, 1)
  assert.equal(team.tasks.length, 1)
  assert.equal(team.tasks[0].assignee, 'worker')
  assert.equal(team.members[0].id, '')
  await assert.rejects(
    () => f.runtime.createStagedTeam(f.captain, { name: 'Another Team', members: [{ name: 'other' }], tasks: [] }),
    /already belong to team/,
  )
})

test('#279 manual create is exposed through the authenticated local route and panel', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const panel = readFileSync(new URL('../src/client/ActivityPanel.tsx', import.meta.url), 'utf8')
  assert.match(source, /path: '\/plugins\/dsh-agent-teams\/plan\/create'/u)
  assert.match(source, /plan\/create-capability/u)
  assert.match(source, /payload\['nonce'\]/u)
  assert.match(source, /agentTeamsRuntime\.createStagedTeam/u)
  assert.match(panel, /ManualTeamDialog/u)
  assert.match(panel, /\/plan\/create/u)
  assert.match(panel, /plan\/create-capability/u)
})
