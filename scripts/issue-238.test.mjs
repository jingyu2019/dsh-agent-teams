import assert from 'node:assert/strict'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { registerAgentTeamsTools } from '../lib/tools.js'

function fakeAgent(id, cwd) {
  return {
    id,
    status: 'idle',
    options: { provider: 'p', model: 'm' },
    session: {
      id,
      seq: 0,
      header: { cwd, seedLength: 0 },
      events: [],
      snapshotEvents: () => [],
      requestHeader: () => ({ config: { provider: 'p', model: 'm', reasoningEffort: 'high' } }),
      append() {},
    },
    followup() {}, steer() {}, cancel() {}, whenIdle() { return Promise.resolve() },
  }
}

async function fixture(t, outcomes = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-w4-238-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const captain = fakeAgent('captain', workspace)
  const definitions = new Map()
  const listeners = new Map()
  const starts = []
  const disposals = []
  let active = 0
  let maxActive = 0
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
    llm: {
      async listModels(provider) { return [{ provider, id: 'm', name: 'm' }] },
      async resolveCallConfig(config) { return config },
    },
    subagents: {
      getProvider(name) { return name === 'spawn' ? { prepareContinuable() {}, capabilities: { persona: true, toolFilter: true } } : undefined },
      list() { return ['spawn'] },
      registerContinuableSetup() { return noop },
      async followup() { return 'queued' },
      async sendMessage() { return 'sent' },
      interrupt() {},
      async listChildren() { return [] },
      async listDescendants() { return [] },
      async drainContinuableChildren() {},
      async startActivation(spec) {
        const member = spec.label.split(':').at(-1)
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise(resolve => setTimeout(resolve, 10))
        active -= 1
        starts.push({ member, spec })
        if (outcomes[member] === 'reject') throw new Error(`boom-${member}`)
        if (outcomes[member] === 'hang-start') return new Promise(() => {})
        if (outcomes[member] === 'late-start') await new Promise(resolve => setTimeout(resolve, 1200))
        const result = outcomes[member] === 'hang-result'
          ? new Promise(() => {})
          : Promise.resolve({ stopReason: outcomes[member] ?? 'completed', output: [{ type: 'text', text: `result-${member}` }] })
        return {
          childId: `child-${member}`,
          messageId: `msg-${member}`,
          result,
          dispose: async () => { disposals.push(member) },
        }
      },
    },
    logger: { warn: noop, debug: noop },
  }
  const profiles = {
    dev: {
      members: [
        { name: 'Designer', provider: 'p', model: 'm' },
        { name: 'Worker', provider: 'p', model: 'm' },
        { name: 'Reviewer', provider: 'p', model: 'm' },
        { name: 'Scout', provider: 'p', model: 'm' },
        { name: 'TextWriter', provider: 'p', model: 'm' },
      ],
      tasks: [],
    },
  }
  registerAgentTeamsTools(ctx, {
    stateDir: '.agent-teams', memberProvider: 'spawn', memberMaxDepth: 0, maxMembers: 8,
    profiles, toolPolicies: {}, skills: {},
  })
  const call = (name, args) => {
    const tool = definitions.get(name)
    if (!tool) throw new Error(`missing tool ${name}`)
    return tool.execute(args, { agent: captain, callId: `${name}-test`, signal: new AbortController().signal })
  }
  return { workspace, call, starts, disposals, maxActive: () => maxActive }
}

test('#238 starts only explicitly selected profile members with keyed ordered output', async t => {
  const f = await fixture(t)
  const result = await f.call('agent_teams_invoke_profile', {
    profile: 'dev', members: ['Scout', 'Reviewer'], prompt: 'inspect independently', concurrency: 2,
  })
  assert.deepEqual(result.results.map(item => item.member), ['Scout', 'Reviewer'])
  assert.deepEqual(result.results.map(item => item.status), ['completed', 'completed'])
  assert.deepEqual(result.results.map(item => item.output), ['result-Scout', 'result-Reviewer'])
  assert.deepEqual(f.starts.map(item => item.member).sort(), ['Reviewer', 'Scout'])
  assert.deepEqual(f.disposals.sort(), ['Reviewer', 'Scout'])
  await assert.rejects(access(join(f.workspace, '.agent-teams')), error => error?.code === 'ENOENT')
  for (const member of ['Designer', 'Worker', 'TextWriter']) {
    assert.equal(f.starts.some(item => item.member === member), false)
  }
})

test('#238 invalid member selection makes zero child starts', async t => {
  const f = await fixture(t)
  await assert.rejects(
    () => f.call('agent_teams_invoke_profile', { profile: 'dev', members: ['Scout', 'Missing'], prompt: 'x' }),
    /has no member "Missing"/,
  )
  assert.equal(f.starts.length, 0)
})

test('#238 per-member failure is isolated and every acquired activation is disposed', async t => {
  const f = await fixture(t, { Reviewer: 'reject' })
  const result = await f.call('agent_teams_invoke_profile', {
    profile: 'dev', members: ['Scout', 'Reviewer'], prompt: 'x', concurrency: 2,
  })
  assert.equal(result.results[0].status, 'completed')
  assert.equal(result.results[1].status, 'failed')
  assert.match(result.results[1].diagnostic, /boom-Reviewer/)
  assert.deepEqual(f.disposals, ['Scout'])
})


test('#238 concurrency option bounds simultaneous child starts', async t => {
  const f = await fixture(t)
  const result = await f.call('agent_teams_invoke_profile', {
    profile: 'dev', members: ['Scout', 'Reviewer', 'Designer'], prompt: 'x', concurrency: 1,
  })
  assert.equal(result.results.length, 3)
  assert.equal(f.maxActive(), 1)
})

test('#238 timeout covers a child start that never resolves', { timeout: 5000 }, async t => {
  const f = await fixture(t, { Scout: 'hang-start' })
  const started = Date.now()
  const result = await f.call('agent_teams_invoke_profile', {
    profile: 'dev', members: ['Scout'], prompt: 'x', timeoutMs: 1000,
  })
  assert.equal(result.results[0].status, 'timeout')
  assert.equal(result.results[0].stopReason, 'timeout')
  assert.ok(Date.now() - started < 3000)
})

test('#238 maps an aborted child result to cancelled', async t => {
  const f = await fixture(t, { Reviewer: 'aborted' })
  const result = await f.call('agent_teams_invoke_profile', {
    profile: 'dev', members: ['Scout', 'Reviewer'], prompt: 'x', concurrency: 2,
  })
  assert.equal(result.results[0].status, 'completed')
  assert.equal(result.results[1].status, 'cancelled')
  assert.equal(result.results[1].stopReason, 'aborted')
})

test('#238 disposes a child that finishes starting after the deadline', { timeout: 5000 }, async t => {
  const f = await fixture(t, { Scout: 'late-start' })
  const result = await f.call('agent_teams_invoke_profile', {
    profile: 'dev', members: ['Scout'], prompt: 'x', timeoutMs: 1000,
  })
  assert.equal(result.results[0].status, 'timeout')
  await new Promise(resolve => setTimeout(resolve, 350))
  assert.deepEqual(f.disposals, ['Scout'])
})
