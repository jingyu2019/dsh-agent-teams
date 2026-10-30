import assert from 'node:assert/strict'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { registerAgentTeamsTools } from '../lib/tools.js'
import { Config, resolveToolsConfig } from '../lib/index.js'
import { spawnMember } from '../lib/members.js'
import { readTeam, writeTeam } from '../lib/state.js'

const SKILLS = {
  alpha: { version: '1', prompt: 'ALPHA-SKILL: inspect architecture.', toolPolicy: 'alpha-policy' },
  beta: { version: '2', prompt: 'BETA-SKILL: write docs.' },
}

function fakeAgent(id, cwd) {
  return {
    id, status: 'idle', options: { provider: 'p', model: 'm' },
    session: {
      id, seq: 0, header: { cwd, seedLength: 0 }, events: [], append() {},
      snapshotEvents: () => [],
      requestHeader: () => ({ config: { provider: 'p', model: 'm', reasoningEffort: 'high' } }),
    },
    followup() {}, steer() {}, cancel() {}, whenIdle() { return Promise.resolve() },
  }
}

async function fixture(t, starts = []) {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-w4-244-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const stateRoot = join(workspace, '.agent-teams')
  const captain = fakeAgent('captain', workspace)
  const definitions = new Map()
  const listeners = new Map()
  const noop = () => {}
  const ctx = {
    effect(setup) { return setup() },
    on(name, listener) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => listeners.set(name, list.filter(item => item !== listener))
    },
    tools: { register(definition) { definitions.set(definition.name, definition) } },
    agents: { list: () => [captain], get: id => id === captain.id ? captain : undefined },
    llm: { async listModels(provider) { return [{ provider, id: 'm', name: 'm' }] }, async resolveCallConfig(config) { return config } },
    subagents: {
      getProvider(name) { return name === 'spawn' ? { prepareContinuable() {}, capabilities: { persona: true, toolFilter: true } } : undefined },
      list() { return ['spawn'] },
      registerContinuableSetup() { return noop },
      async followup() { return 'queued' }, async sendMessage() { return 'sent' }, interrupt() {},
      async listChildren() { return [] }, async listDescendants() { return [] }, async drainContinuableChildren() {},
      async startActivation(spec) {
        starts.push(spec)
        return { childId: `child-${spec.label.split(':').at(-1)}`, result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => {} }
      },
    },
    logger: { warn: noop, debug: noop },
  }
  const config = {
    stateDir: '.agent-teams', memberProvider: 'spawn', memberMaxDepth: 0, maxMembers: 8,
    profiles: {}, toolPolicies: { 'alpha-policy': { deny: ['web_search'] } }, skills: SKILLS,
  }
  registerAgentTeamsTools(ctx, config)
  const call = (name, args) => {
    const tool = definitions.get(name)
    if (!tool) throw new Error(`missing tool ${name}`)
    return tool.execute(args, { agent: captain, callId: `${name}-test`, signal: new AbortController().signal })
  }
  return { workspace, stateRoot, captain, ctx, config, call }
}

const plan = (skillsA = ['alpha'], skillsB = ['beta']) => ({
  members: [
    { name: 'alpha-member', provider: 'p', model: 'm', skills: skillsA },
    { name: 'beta-member', provider: 'p', model: 'm', skills: skillsB },
  ],
  tasks: [],
})

test('#244 persists disjoint owner skill ids/hashes before any spawn', async t => {
  const f = await fixture(t)
  await f.call('agent_teams_create', { name: 'skills-team', approval: 'automatic', plan: plan() })
  const team = await readTeam(f.stateRoot, 'skills-team')
  assert.deepEqual(team.members[0].skills, ['alpha'])
  assert.deepEqual(team.members[1].skills, ['beta'])
  assert.equal(team.members[0].toolPolicy, 'alpha-policy')
  assert.ok(team.members[0].toolFilter?.deny.includes('web_search'))
  assert.ok(team.members[0].toolFilter?.deny.includes('agent_teams_invoke_profile'))
  const expectedAlpha = createHash('sha256').update([
    'Owner-declared skills selected for this member (apply exactly once; IDs, not raw captain input):',
    '### alpha (v1)\nALPHA-SKILL: inspect architecture.',
  ].join('\n\n')).digest('hex')
  assert.equal(team.members[0].skillPromptSha256, expectedAlpha)
  assert.notEqual(team.members[0].skillPromptSha256, team.members[1].skillPromptSha256)
})

test('#244 unknown, blank and duplicate skill ids fail atomically before persistence', async t => {
  const f = await fixture(t)
  for (const [name, skills] of [
    ['unknown-team', ['does-not-exist']],
    ['blank-team', ['   ']],
    ['duplicate-team', ['alpha', 'alpha']],
  ]) {
    await assert.rejects(
      () => f.call('agent_teams_create', { name, approval: 'automatic', plan: plan(skills) }),
      /unknown owner-declared skill id|non-empty skill id|duplicates|duplicated/,
    )
    await assert.rejects(access(join(f.stateRoot, name)), error => error?.code === 'ENOENT')
  }
})

test('#244 resolved owner prompt is injected once and persisted for cold reapply', async t => {
  const starts = []
  const f = await fixture(t, starts)
  await f.call('agent_teams_create', { name: 'persona-team', approval: 'automatic', plan: plan() })
  let team = await readTeam(f.stateRoot, 'persona-team')
  const member = team.members[0]
  const selection = {
    provider: member.provider, model: member.model, reasoningEffort: member.reasoningEffort,
    ...member.fallback === undefined ? {} : { fallback: member.fallback },
    ...member.fallbacks === undefined ? {} : { fallbacks: member.fallbacks },
  }
  const receipt = await spawnMember(f.ctx, {
    provider: 'spawn', maxDepth: 0, skills: SKILLS,
  }, { withPending: async (_parent, _label, _selection, operation) => operation() }, selection, f.captain, team, member, '.agent-teams', new AbortController().signal, 'direct work')
  assert.equal(receipt.childId, 'child-alpha-member')
  assert.equal(starts.length, 1)
  assert.equal(starts[0].request.persona, undefined, 'managed hosts receive persona through runtimeSetup, not the activation request')
  const persona = member.runtimeSetup.persona
  assert.equal((persona.match(/ALPHA-SKILL/g) ?? []).length, 1)
  assert.doesNotMatch(persona, /BETA-SKILL/)
  await writeTeam(f.stateRoot, team)
  team = await readTeam(f.stateRoot, 'persona-team')
  assert.equal(team.members[0].runtimeSetup.persona, persona)
  assert.equal(team.members[0].skillPromptSha256, member.skillPromptSha256)
})


test('#244 owner Config schema and resolver expose skill bindings without raw bundles', () => {
  const owner = Config({
    skills: SKILLS,
    profiles: {
      dev: {
        members: [{ name: 'alpha-member', provider: 'p', model: 'm', skills: ['alpha'] }],
        taskPlanning: 'captain',
      },
    },
  })
  const resolved = resolveToolsConfig(owner)
  assert.deepEqual(Object.keys(resolved.skills ?? {}), ['alpha', 'beta'])
  assert.equal(resolved.skills.alpha.version, '1')
  assert.deepEqual(resolved.profiles.dev.members[0].skills, ['alpha'])
  assert.throws(() => resolveToolsConfig(Config({ skills: { bad: { version: '', prompt: 'x' } } })), /version/)
})


test('#244 a changed owner prompt cannot silently repersona a cold member', async t => {
  const starts = []
  const f = await fixture(t, starts)
  await f.call('agent_teams_create', { name: 'cold-team', approval: 'automatic', plan: plan() })
  const team = await readTeam(f.stateRoot, 'cold-team')
  const member = team.members[0]
  const selection = { provider: member.provider, model: member.model, reasoningEffort: member.reasoningEffort }
  await assert.rejects(
    () => spawnMember(f.ctx, { provider: 'spawn', maxDepth: 0, skills: {
      ...SKILLS, alpha: { ...SKILLS.alpha, prompt: 'CHANGED PROMPT' },
    } }, { withPending: async (_parent, _label, _selection, operation) => operation() }, selection, f.captain, team, member, '.agent-teams', new AbortController().signal, 'direct work'),
    /no longer matches its persisted hash/,
  )
  assert.equal(starts.length, 0)
})
