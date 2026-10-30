// #305: Running-team task creation missed the non-empty subject gate used by staged graphs and edits.
// #260: tool_policy is optional, blank means none, and an unknown non-empty id fails atomically.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateCreateTask } from '../lib/quality-gates.js'
import { createTeamDir, readTeam } from '../lib/state.js'
import { registerAgentTeamsTools } from '../lib/tools.js'

function runningTeam() {
  return {
    id: 'test', name: 'Test', captainSessionId: 'captain', createdAt: 1,
    phase: 'running', members: [], taskSeq: 1,
    tasks: [{ id: 't1', subject: 'Existing task', status: 'pending', dependencies: [], createdAt: 1, updatedAt: 1 }],
  }
}

function simpleFixture(t, initialTeam) {
  return (async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'issue-305-'))
    t.after(() => rm(workspace, { recursive: true, force: true }))
    const stateDir = '.agent-teams'
    const stateRoot = join(workspace, stateDir)
    const team = initialTeam()
    await createTeamDir(stateRoot, team)
    const noop = () => {}
    const captain = {
      id: 'captain', status: 'idle',
      session: { id: 'captain', header: { cwd: workspace, seedLength: 0 }, events: [], append: noop },
    }
    const definitions = []
    registerAgentTeamsTools({
      on: () => noop, effect: setup => setup(), logger: { warn: noop, debug: noop },
      tools: { register: definition => definitions.push(definition) },
      agents: { get: id => id === captain.id ? captain : undefined },
      subagents: { followup: async () => {}, registerContinuableSetup: () => noop },
    }, { stateDir, memberProvider: 'spawn', memberMaxDepth: 1, maxMembers: 8, profiles: {}, toolPolicies: {} })
    const tool = definitions.find(definition => definition.name === 'agent_teams_create_task')
    assert.ok(tool)
    return {
      load: () => readTeam(stateRoot, team.id),
      create: subject => tool.execute({ subject }, {
        agent: captain, callId: 'blank-subject-test', signal: new AbortController().signal,
      }),
    }
  })()
}

for (const [name, subject] of [['empty', ''], ['whitespace-only', '   ']]) {
  test(`running team rejects ${name} subject without changing tasks or taskSeq`, async t => {
    const { load, create } = await simpleFixture(t, runningTeam)
    const before = await load()
    await assert.rejects(() => create(subject), { message: 'task subject must not be empty' })
    const after = await load()
    assert.deepEqual(after.tasks, before.tasks)
    assert.equal(after.taskSeq, before.taskSeq)
  })
}

test('running team creates a valid subject verbatim', async t => {
  const { load, create } = await simpleFixture(t, runningTeam)
  const before = await load()
  const subject = '  Keep this subject verbatim  '
  const result = await create(subject)
  assert.equal(result.subject, subject)
  assert.equal(result.task_id, `t${before.taskSeq + 1}`)
  const after = await load()
  assert.equal(after.taskSeq, before.taskSeq + 1)
  assert.equal(after.tasks.length, before.tasks.length + 1)
  assert.deepEqual(after.tasks.slice(0, -1), before.tasks)
  assert.equal(after.tasks.at(-1).subject, subject)
  assert.equal(after.tasks.at(-1).id, result.task_id)
})

for (const [label, subject] of [
  ['empty', ''], ['spaces', '   '], ['tabs-newlines', '\t\n'],
  ['undefined', undefined], ['null', null], ['number', 42], ['object', {}],
]) {
  test(`validateCreateTask rejects ${label} subject before quality validation`, () => {
    assert.deepEqual(validateCreateTask(runningTeam(), { subject, kind: 'verification' }), {
      ok: false, error: 'task subject must not be empty',
    })
  })
}

function schemaDefinitions() {
  const definitions = []
  const noop = () => {}
  registerAgentTeamsTools({
    on: () => noop, effect: setup => setup(), logger: { warn: noop, debug: noop },
    tools: { register: definition => definitions.push(definition) },
    agents: { get: () => undefined },
    subagents: { followup: async () => {}, registerContinuableSetup: () => noop },
  }, { stateDir: '.agent-teams', memberProvider: 'spawn', memberMaxDepth: 1, maxMembers: 8, profiles: {}, toolPolicies: {} })
  return definitions
}

test('create-plan and add-member expose tool_policy as an explicit optional input', () => {
  const definitions = schemaDefinitions()
  const create = definitions.find(definition => definition.name === 'agent_teams_create')
  const add = definitions.find(definition => definition.name === 'agent_teams_add_member')
  assert.ok(create)
  assert.ok(add)
  const planPolicy = create.parameters.properties.plan.properties.members.items.properties.tool_policy
  const addPolicy = add.parameters.properties.tool_policy
  assert.equal(planPolicy.type, 'string')
  assert.equal(addPolicy.type, 'string')
  assert.ok(!(create.parameters.properties.plan.properties.members.items.required ?? []).includes('tool_policy'))
  assert.ok(!(add.parameters.required ?? []).includes('tool_policy'))
  for (const description of [planPolicy.description, addPolicy.description]) {
    assert.match(description, /Optional owner-declared tool-policy id/)
    assert.match(description, /Omit when no policy is needed/)
    assert.match(description, /Never invent an id/)
    assert.match(description, /unknown non-empty id is rejected atomically/)
  }
})

function policyFixture(t) {
  return (async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'issue-260-'))
    t.after(() => rm(workspace, { recursive: true, force: true }))
    const definitions = new Map()
    const listeners = new Map()
    const noop = () => {}
    const captain = {
      id: 'captain-session', status: 'idle',
      options: { provider: 'fake', model: 'fake-model' },
      session: {
        id: 'captain-session',
        header: { cwd: workspace, seedLength: 0 },
        events: [],
        append() {},
        requestHeader() { return { config: { provider: 'fake', model: 'fake-model', reasoningEffort: 'high' } } },
      },
      followup() {}, steer() {}, cancel() {}, whenIdle() { return Promise.resolve() },
    }
    const ctx = {
      effect(setup) { return setup() },
      tools: { register(definition) { definitions.set(definition.name, definition) } },
      on(name, listener) {
        const current = listeners.get(name) ?? []
        current.push(listener)
        listeners.set(name, current)
        return () => listeners.set(name, current.filter(item => item !== listener))
      },
      agents: { list: () => [captain], get: id => id === captain.id ? captain : undefined },
      llm: {
        async resolveCallConfig(config) { return config },
        async listModels() { return [] },
      },
      subagents: {
        registerContinuableSetup() { return () => {} },
        getProvider(name) { return name === 'spawn' ? { prepareContinuable() {}, capabilities: { persona: true, toolFilter: true } } : undefined },
        list() { return ['spawn'] },
        async followup() { return 'message-1' },
        async listChildren() { return [] },
        async listDescendants() { return [] },
        interrupt() {},
        async drainContinuableChildren() {},
      },
      logger: { warn: noop, debug: noop },
    }
    registerAgentTeamsTools(ctx, {
      stateDir: '.agent-teams', memberProvider: 'spawn', memberMaxDepth: 1, maxMembers: 8,
      profiles: {}, toolPolicies: { 'researcher-safe': { deny: ['web_search'] } },
    })
    const stateRoot = join(workspace, '.agent-teams')
    const call = (name, args) => {
      const definition = definitions.get(name)
      if (!definition) throw new Error(`missing tool ${name}`)
      return definition.execute(args, { agent: captain, callId: `${name}-test`, signal: new AbortController().signal })
    }
    const load = name => readTeam(stateRoot, name)
    return { call, load }
  })()
}

test('create-plan treats omitted and whitespace tool_policy as no policy', async t => {
  const { call, load } = await policyFixture(t)
  await call('agent_teams_create', {
    name: 'blank-plan', approval: 'required',
    plan: {
      members: [
        { name: 'omitted', provider: 'fake', model: 'fake-model' },
        { name: 'blank', provider: 'fake', model: 'fake-model', tool_policy: '   ' },
      ],
      tasks: [],
    },
  })
  const team = await load('blank-plan')
  assert.equal(team.members.length, 2)
  for (const member of team.members) {
    assert.equal(member.toolPolicy, undefined)
    assert.equal(member.toolFilter, undefined)
  }
})

test('add-member normalizes blank tool_policy and keeps a declared id verbatim', async t => {
  const { call, load } = await policyFixture(t)
  await call('agent_teams_create', { name: 'add-policy', approval: 'required' })
  await call('agent_teams_add_member', { name: 'blank', tool_policy: ' \t ' })
  await call('agent_teams_add_member', { name: 'selected', tool_policy: ' researcher-safe ' })
  const team = await load('add-policy')
  assert.equal(team.members.find(member => member.name === 'blank').toolPolicy, undefined)
  assert.equal(team.members.find(member => member.name === 'blank').toolFilter, undefined)
  assert.equal(team.members.find(member => member.name === 'selected').toolPolicy, 'researcher-safe')
  assert.ok(team.members.find(member => member.name === 'selected').toolFilter)
})

test('an unknown non-empty tool_policy fails before any member is written', async t => {
  const { call, load } = await policyFixture(t)
  await call('agent_teams_create', { name: 'atomic-policy', approval: 'required' })
  const before = await load('atomic-policy')
  await assert.rejects(
    () => call('agent_teams_add_member', { name: 'bad-policy', tool_policy: 'missing' }),
    /unknown tool policy "missing"/,
  )
  const after = await load('atomic-policy')
  assert.deepEqual(after.members, before.members)
  assert.equal(after.members.length, 0)
})

test('optionalToolPolicyId returns undefined for non-strings and blank strings, and trims non-blank ids', async () => {
  const { optionalToolPolicyId } = await import('../lib/tools.js')
  assert.equal(optionalToolPolicyId(undefined), undefined)
  assert.equal(optionalToolPolicyId(null), undefined)
  assert.equal(optionalToolPolicyId(42), undefined)
  assert.equal(optionalToolPolicyId(''), undefined)
  assert.equal(optionalToolPolicyId('  \t '), undefined)
  assert.equal(optionalToolPolicyId(' researcher-safe '), 'researcher-safe')
})
