/**
 * R3: change a running member's model/reasoning route, and explain refusals.
 *
 * The activity panel gained a per-member route editor, and the server copy that
 * refused these changes was vague. Both now share one runtime method
 * (`AgentTeamsRuntime.updateMemberRoute`, used by the tool and the panel route)
 * whose refusals come from the pure messages asserted here.
 *
 * Semantics are unchanged: the member must belong to a running team, must be
 * idle, and must own no open attempt. These tests pin the three refusal texts,
 * the allowed path, and the fact that the tool and the panel route agree.
 *
 * Imports the built output (`../lib/*.js`) like the other regression scripts;
 * run `pnpm build` first when running this file directly.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createTeamDir, readTeam } from '../lib/state.js'
import {
  memberRouteBusyFailure,
  memberRouteNotRunningFailure,
  memberRouteOpenAttemptFailure,
  registerAgentTeamsTools,
} from '../lib/tools.js'
import { removeTestTree } from './test-cleanup.mjs'

const SERVER_SOURCE = new URL('../src/index.ts', import.meta.url)

function fakeAgent(id, cwd, status = 'idle') {
  return {
    id, status, options: { provider: 'p', model: 'm' },
    session: {
      id, seq: 0, header: { cwd, seedLength: 0 }, events: [], append() {},
      snapshotEvents: () => [],
      requestHeader: () => ({ config: { provider: 'p', model: 'm', reasoningEffort: 'high' } }),
    },
    followup() {}, steer() {}, cancel() {}, inject() {}, whenIdle() { return Promise.resolve() },
  }
}

const noop = () => {}

async function fixture({ phase = 'running', member = {}, tasks = [] } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-r3-'))
  const stateRoot = join(workspace, '.agent-teams')
  const captain = fakeAgent('captain', workspace)
  const live = new Map()
  await createTeamDir(stateRoot, {
    id: 'route-team', name: 'Route Team', captainSessionId: captain.id, createdAt: 1,
    phase, taskSeq: tasks.length,
    members: [{
      id: '', name: 'worker', role: 'impl', provider: 'p', model: 'm',
      joinedAt: 1, status: 'idle', generation: 1, ...member,
    }],
    tasks,
  })
  const definitions = new Map()
  const ctx = {
    effect(setup) { return setup() },
    on() { return noop },
    tools: { register(definition) { definitions.set(definition.name, definition) } },
    agents: { list: () => [captain, ...live.values()], get: id => id === captain.id ? captain : live.get(id) },
    llm: {
      async listModels(provider) { return ['m', 'm2'].map(id => ({ provider, id, name: id })) },
      async resolveCallConfig(config) { return config },
    },
    subagents: {
      getProvider(name) {
        return name === 'spawn' ? { prepareContinuable() {}, capabilities: { persona: true, toolFilter: true } } : undefined
      },
      list() { return ['spawn'] },
      registerContinuableSetup() { return noop },
      async followup() { return 'queued' },
      async sendMessage() { return 'sent' },
      interrupt() {},
      async listChildren() { return [] },
      async listDescendants() { return [] },
      async drainContinuableChildren() {},
      async drainChildren() {},
    },
    logger: { warn: noop, debug: noop },
  }
  const runtime = registerAgentTeamsTools(ctx, {
    stateDir: '.agent-teams', memberProvider: 'spawn', memberMaxDepth: 0, maxMembers: 8,
    maxConcurrentWorkers: 2, profiles: {}, toolPolicies: {}, skills: {},
  })
  const callTool = (name, args) => {
    const tool = definitions.get(name)
    if (tool === undefined) throw new Error(`missing tool ${name}`)
    return tool.execute(args, { agent: captain, callId: `${name}-test`, signal: new AbortController().signal })
  }
  return { workspace, stateRoot, captain, runtime, callTool, live, cleanup: () => removeTestTree(workspace) }
}

test('R3 refusal messages name the blocker and the exit', () => {
  const staged = memberRouteNotRunningFailure('Route Team', 'staged')
  const halted = memberRouteNotRunningFailure('Route Team', 'halted')
  const blocked = memberRouteOpenAttemptFailure('worker', 't1')
  const busy = memberRouteBusyFailure('worker')

  assert.match(staged, /not running yet/u)
  assert.match(staged, /staged plan|agent_teams_approve/u)
  assert.match(halted, /halted/u)
  assert.match(halted, /agent_teams_resume/u)
  assert.match(blocked, /"worker"/u)
  assert.match(blocked, /open task "t1"/u)
  assert.match(blocked, /agent_teams_reassign_task/u)
  assert.match(busy, /"worker"/u)
  assert.match(busy, /active turn/u)
  assert.match(busy, /agent_teams_status/u)

  // Three distinct causes must never collapse into one sentence.
  assert.equal(new Set([staged, halted, blocked, busy]).size, 4)
})

test('R3 an idle member of a running team can change route', async () => {
  const f = await fixture()
  try {
    const updated = await f.runtime.updateMemberRoute(f.captain, 'route-team', {
      memberName: 'worker', provider: 'p', model: 'm2', reasoningEffort: 'high',
    })
    assert.equal(updated.member_name, 'worker')
    assert.equal(updated.provider, 'p')
    assert.equal(updated.model, 'm2')
    const team = await readTeam(f.stateRoot, 'route-team')
    assert.equal(team.members[0].provider, 'p')
    assert.equal(team.members[0].model, 'm2')
    assert.equal(team.members[0].reasoningEffort, 'high')

    // The tool surface shares the same path and returns the same shape.
    const viaTool = await f.callTool('agent_teams_update_member_route', { member_name: 'worker', model: 'm' })
    assert.equal(viaTool.model, 'm')
    assert.equal((await readTeam(f.stateRoot, 'route-team')).members[0].model, 'm')
  } finally { await f.cleanup() }
})

test('R3 a staged team refuses with the staging exit', async () => {
  const f = await fixture({ phase: 'staged' })
  try {
    await assert.rejects(
      () => f.runtime.updateMemberRoute(f.captain, 'route-team', { memberName: 'worker', model: 'm2' }),
      /not running yet/u,
    )
    await assert.rejects(
      () => f.callTool('agent_teams_update_member_route', { member_name: 'worker', model: 'm2' }),
      /not running yet/u,
    )
    assert.equal((await readTeam(f.stateRoot, 'route-team')).members[0].model, 'm')
  } finally { await f.cleanup() }
})

test('R3 a member with an open attempt refuses and names the task', async () => {
  const f = await fixture({
    tasks: [{
      id: 't1', subject: 'open work', status: 'in_progress', assignee: 'worker',
      dependencies: [], attempt: 1, attemptId: 'a1', createdAt: 1, updatedAt: 1,
    }],
  })
  try {
    await assert.rejects(
      () => f.runtime.updateMemberRoute(f.captain, 'route-team', { memberName: 'worker', model: 'm2' }),
      /open task "t1"/u,
    )
    assert.equal((await readTeam(f.stateRoot, 'route-team')).members[0].model, 'm')
  } finally { await f.cleanup() }
})

test('R3 a member mid-turn refuses until it is idle', async () => {
  const f = await fixture({ member: { id: 'child-worker' } })
  try {
    f.live.set('child-worker', fakeAgent('child-worker', f.workspace, 'running'))
    await assert.rejects(
      () => f.runtime.updateMemberRoute(f.captain, 'route-team', { memberName: 'worker', model: 'm2' }),
      /active turn/u,
    )
    assert.equal((await readTeam(f.stateRoot, 'route-team')).members[0].model, 'm')
  } finally { await f.cleanup() }
})
test('R3 the panel route resolves ownership before delegating', async () => {
  // The handler is a thin wrapper; this pins the two things a wrapper can get
  // wrong — skipping the captain/team check, or hand-writing refusal copy
  // instead of using the pure messages above.
  const source = await readFile(SERVER_SOURCE, 'utf8')
  const start = source.indexOf("path: '/plugins/dsh-agent-teams/member-route'")
  assert.ok(start > 0, 'the member-route handler must stay registered')
  const end = source.indexOf('agent-teams: member route', start)
  const handler = source.slice(start, end)
  assert.match(handler, /findTeamByCaptain/u, 'ownership must be resolved from the captain session, not teamId alone')
  assert.match(handler, /agentTeamsRuntime\.updateMemberRoute/u)
  assert.doesNotMatch(handler, /route changes are only available|is halted, not awaiting|active turn/u, 'refusal copy belongs to the pure helpers')
})
