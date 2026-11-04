import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTeamDir, findTeamByCaptain, findTeamByParticipant, readTeam } from '../lib/state.js'
import { registerAgentTeamsTools } from '../lib/tools.js'

function team(id, captainSessionId) {
  return {
    id, name: id, captainSessionId, createdAt: 1, members: [], tasks: [], taskSeq: 0,
  }
}

function fixture(t) {
  return (async () => {
    const root = await mkdtemp(join(tmpdir(), 'issue-331-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    return {
      root,
      add: value => createTeamDir(root, value),
    }
  })()
}

function createToolFixture(t, captain, initialTeams) {
  return (async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'issue-331-create-'))
    t.after(() => rm(workspace, { recursive: true, force: true }))
    const stateRoot = join(workspace, '.agent-teams')
    for (const value of initialTeams) await createTeamDir(stateRoot, value)
    const parent = {
      id: 'C', status: 'idle',
      session: { id: 'C', header: { cwd: workspace }, events: [], append() {} },
    }
    captain.session.header.cwd = workspace
    const agents = [captain, parent]
    const definitions = []
    const noop = () => {}
    const ctx = {
      on: () => noop,
      effect: setup => setup(),
      logger: { warn: noop, debug: noop },
      tools: { register: definition => definitions.push(definition) },
      agents: { list: () => agents, get: id => agents.find(agent => agent.id === id) },
      subagents: { followup: async () => {}, registerContinuableSetup: () => noop },
    }
    registerAgentTeamsTools(ctx, {
      stateDir: '.agent-teams', memberProvider: 'spawn', memberMaxDepth: 1,
      maxMembers: 8, profiles: {}, toolPolicies: {},
    })
    const create = definitions.find(definition => definition.name === 'agent_teams_create')
    assert.ok(create)
    return {
      stateRoot,
      execute: args => create.execute(args, { agent: captain, callId: 'issue-331', signal: new AbortController().signal }),
    }
  })()
}

const lead = (sessionId, ancestry) => ({ sessionId, ancestry, inheritsLead: true })

test('a fork resolves its exact-owned team ahead of an inherited ancestor team', async t => {
  const { root, add } = await fixture(t)
  await add(team('T0', 'C'))
  await add(team('T1', 'F'))
  const fork = lead('F', ['C'])

  assert.equal((await findTeamByCaptain(root, 'F', fork))?.id, 'T1')
  assert.equal((await findTeamByParticipant(root, 'F', fork))?.id, 'T1')
  assert.equal((await findTeamByCaptain(root, 'C', lead('C', [])))?.id, 'T0')
})

test('a deeper fork inherits the nearest ancestor team', async t => {
  const { root, add } = await fixture(t)
  await add(team('T0', 'C'))
  await add(team('T1', 'F'))

  assert.equal((await findTeamByParticipant(root, 'G', lead('G', ['F', 'C'])))?.id, 'T1')
})

test('two exact-owned teams for one session remain an ambiguity error', async t => {
  const { root, add } = await fixture(t)
  await add(team('T1', 'F'))
  await add(team('T2', 'F'))

  await assert.rejects(
    findTeamByParticipant(root, 'F', lead('F', ['C'])),
    /agent session belongs to multiple active teams/,
  )
})

test('a captain fork can create its independent team while inheriting its parent team', async t => {
  const captain = {
    id: 'F', status: 'idle',
    session: { id: 'F', header: { parentSession: 'C', seedLength: 0 }, events: [], append() {} },
  }
  const { stateRoot, execute } = await createToolFixture(t, captain, [team('T0', 'C')])

  const result = await execute({ name: 'Fork Team', description: 'Independent work' })
  const created = await readTeam(stateRoot, 'fork-team')
  assert.equal(result.team_id, 'fork-team')
  assert.equal(created?.captainSessionId, 'F')
})

test('a member session remains unable to create an independent team', async t => {
  const captain = {
    id: 'F', status: 'idle',
    session: { id: 'F', header: { parentSession: 'C', origin: 'subagent', delegationDepth: 1, seedLength: 0 }, events: [], append() {} },
  }
  const memberTeam = { ...team('T0', 'C'), members: [{ id: 'F', name: 'worker', status: 'working', joinedAt: 1 }] }
  const { execute } = await createToolFixture(t, captain, [memberTeam])

  await assert.rejects(execute({ name: 'Forbidden Team', description: 'Must not be created' }), /already belong to team/)
})

