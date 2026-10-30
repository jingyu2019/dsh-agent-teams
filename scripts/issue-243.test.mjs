import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createTeamDir, readTeam } from '../lib/state.js'
import { registerAgentTeamsTools } from '../lib/tools.js'

function fakeAgent(id, cwd, status = 'idle') {
  return {
    id, status, options: { provider: 'p', model: 'old' },
    session: {
      id, seq: 0, header: { cwd, seedLength: 0 }, events: [], append() {},
      snapshotEvents: () => [],
      requestHeader: () => ({ config: { provider: 'p', model: 'old', reasoningEffort: 'high' } }),
    },
    followup() {}, steer() {}, cancel() {}, whenIdle() { return Promise.resolve() },
  }
}

async function fixture(t, { member = {}, tasks = [], liveStatus = 'idle', models = ['old', 'new'] } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-w4-243-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const stateRoot = join(workspace, '.agent-teams')
  const captain = fakeAgent('captain', workspace)
  const live = member.id ? fakeAgent(member.id, workspace, liveStatus) : undefined
  const now = Date.now()
  const team = {
    id: 'route-team', name: 'Route Team', captainSessionId: 'captain', createdAt: now,
    phase: 'running', taskSeq: tasks.length,
    members: [{ id: '', name: 'worker', role: 'impl', provider: 'p', model: 'old', joinedAt: now, status: 'idle', generation: 2, ...member }],
    tasks,
  }
  await createTeamDir(stateRoot, team)
  const definitions = new Map()
  const listeners = new Map()
  const starts = []
  const drains = []
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
    agents: { list: () => [captain, ...(live ? [live] : [])], get: id => id === captain.id ? captain : id === live?.id ? live : undefined },
    llm: {
      async listModels(provider) { return models.map(id => ({ provider, id, name: id })) },
      async resolveCallConfig(config) { return config },
    },
    subagents: {
      getProvider(name) { return name === 'spawn' ? { prepareContinuable() {}, capabilities: { persona: true, toolFilter: true } } : undefined },
      list() { return ['spawn'] },
      registerContinuableSetup() { return noop },
      async followup() { return 'queued' }, async sendMessage() { return 'sent' }, interrupt() {},
      async listChildren() { return [] }, async listDescendants() { return [] },
      async drainContinuableChildren() {},
      async drainChildren(_parent, ids) { drains.push([...ids]) },
      async startActivation(spec) {
        starts.push(spec)
        return { childId: `child-${spec.label.split(':').at(-1)}`, result: new Promise(() => {}), dispose: async () => {} }
      },
    },
    logger: { warn: noop, debug: noop },
  }
  registerAgentTeamsTools(ctx, {
    stateDir: '.agent-teams', memberProvider: 'spawn', memberMaxDepth: 0, maxMembers: 8,
    maxConcurrentWorkers: 2, profiles: {}, toolPolicies: {}, skills: {},
  })
  const call = (name, args) => {
    const tool = definitions.get(name)
    if (!tool) throw new Error(`missing tool ${name}`)
    return tool.execute(args, { agent: captain, callId: `${name}-test`, signal: new AbortController().signal })
  }
  return { stateRoot, call, starts, drains }
}

const pendingTask = { id: 't1', subject: 'Next turn', status: 'pending', assignee: 'worker', dependencies: [], attempt: 0, createdAt: 1, updatedAt: 1 }

test('#243 route change applies to the next scheduler turn', async t => {
  const f = await fixture(t, { tasks: [pendingTask] })
  const result = await f.call('agent_teams_update_member_route', {
    member_name: 'worker', model: 'new', reasoning_effort: 'high',
  })
  assert.deepEqual(result, { member_name: 'worker', provider: 'p', model: 'new', reasoning_effort: 'high' })
  assert.equal(f.starts.length, 1)
  assert.equal(f.starts[0].request.agentOptions.provider, 'p')
  assert.equal(f.starts[0].request.agentOptions.model, 'new')
  assert.equal(String(f.starts[0].request.agentOptions.reasoningEffort), 'high')
  const team = await readTeam(f.stateRoot, 'route-team')
  assert.equal(team.members[0].provider, 'p')
  assert.equal(team.members[0].model, 'new')
  assert.equal(team.members[0].stopping, false)
  assert.equal(team.tasks[0].attempt, 1)
})

test('#243 idle resident drain preserves member and task identity', async t => {
  const task = { ...pendingTask, status: 'completed', output: 'done', attempt: 1, attemptId: 'a1' }
  const f = await fixture(t, { member: { id: 'child-worker' }, tasks: [task] })
  await f.call('agent_teams_update_member_route', { member_name: 'worker', provider: 'p', model: 'new' })
  assert.deepEqual(f.drains, [['child-worker']])
  const team = await readTeam(f.stateRoot, 'route-team')
  assert.equal(team.members[0].id, 'child-worker')
  assert.equal(team.members[0].generation, 2)
  assert.deepEqual(team.tasks[0], task)
})

test('#243 invalid route restores the old record and remains idle', async t => {
  const f = await fixture(t, { member: { id: 'child-worker' }, models: ['old'] })
  await assert.rejects(
    () => f.call('agent_teams_update_member_route', { member_name: 'worker', model: 'missing-model' }),
    /unknown member model "missing-model"/,
  )
  const team = await readTeam(f.stateRoot, 'route-team')
  assert.equal(team.members[0].provider, 'p')
  assert.equal(team.members[0].model, 'old')
  assert.equal(team.members[0].stopping, false)
  assert.match(team.members[0].spawnError, /missing-model/)
})

test('#243 active turn and open attempt are rejected before any mutation', async t => {
  const f1 = await fixture(t, { member: { id: 'child-worker' }, liveStatus: 'running' })
  await assert.rejects(
    () => f1.call('agent_teams_update_member_route', { member_name: 'worker', model: 'new' }),
    /active turn/,
  )
  assert.deepEqual(f1.drains, [])
  assert.equal((await readTeam(f1.stateRoot, 'route-team')).members[0].model, 'old')

  const claimed = { ...pendingTask, status: 'claimed', attempt: 1, attemptId: 'a1' }
  const f2 = await fixture(t, { member: { id: 'child-worker' }, tasks: [claimed] })
  await assert.rejects(
    () => f2.call('agent_teams_update_member_route', { member_name: 'worker', model: 'new' }),
    /owns open task "t1"/,
  )
  assert.deepEqual(f2.drains, [])
})
