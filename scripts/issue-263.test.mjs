import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { appendTimeline, createTeamDir, readTeam } from '../lib/state.js'
import { assembleTeamSnapshot } from '../lib/snapshot.js'
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

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-263-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const stateRoot = join(workspace, '.agent-teams')
  const captain = fakeAgent('captain', workspace)
  const workerAgent = fakeAgent('child-worker', workspace)
  await createTeamDir(stateRoot, {
    id: 'timeline-team', name: 'Timeline Team', captainSessionId: 'captain', createdAt: 1,
    phase: 'running', taskSeq: 1,
    members: [{ id: 'child-worker', name: 'worker', joinedAt: 1, status: 'idle' }],
    tasks: [{ id: 't1', subject: 'Do the work', status: 'pending', assignee: 'worker', dependencies: [], createdAt: 1, updatedAt: 1 }],
  })
  const definitions = new Map()
  const noop = () => {}
  const ctx = {
    effect(setup) { return setup() },
    on() { return noop },
    tools: { register(definition) { definitions.set(definition.name, definition) } },
    agents: { list: () => [captain, workerAgent], get: id => id === captain.id ? captain : id === workerAgent.id ? workerAgent : undefined },
    llm: {
      async listModels(provider) { return [{ provider, id: 'm', name: 'm' }] },
      async resolveCallConfig(config) { return config },
    },
    subagents: {
      getProvider(name) { return name === 'spawn' ? { prepareContinuable() {}, capabilities: { persona: true, toolFilter: true } } : undefined },
      list() { return ['spawn'] },
      registerContinuableSetup() { return noop },
      async followup() { return 'queued' }, async sendMessage() { return 'sent' }, interrupt() {},
      async listChildren() { return [] }, async listDescendants() { return [] }, async drainContinuableChildren() {},
    },
    logger: { warn: noop, debug: noop },
  }
  registerAgentTeamsTools(ctx, {
    stateDir: '.agent-teams', memberProvider: 'spawn', memberMaxDepth: 0, maxMembers: 8,
    profiles: {}, toolPolicies: {}, skills: {},
  })
  const call = (name, agent, args) => definitions.get(name).execute(args, {
    agent, callId: `${name}-test`, signal: new AbortController().signal,
  })
  return { workspace, stateRoot, captain, workerAgent, call, ctx }
}

test('#263 task mutation timeline is durable, ordered, attributed and idempotent on read', async t => {
  const f = await fixture(t)
  const claim = await f.call('agent_teams_claim_task', f.workerAgent, { task_id: 't1' })
  await f.call('agent_teams_update_task', f.workerAgent, { task_id: 't1', attempt_id: claim.attempt_id, status: 'in_progress' })
  await f.call('agent_teams_update_task', f.workerAgent, { task_id: 't1', attempt_id: claim.attempt_id, status: 'completed', output: 'done' })

  const team = await readTeam(f.stateRoot, 'timeline-team')
  const taskTimeline = team.timeline.filter(entry => entry.taskId === 't1')
  assert.deepEqual(taskTimeline.map(entry => entry.action), ['task.claimed', 'task.started', 'task.completed'])
  assert.deepEqual(taskTimeline.map(entry => entry.actor), ['worker', 'worker', 'worker'])
  assert.deepEqual(taskTimeline.map(entry => entry.taskId), ['t1', 't1', 't1'])
  assert.deepEqual(taskTimeline.map(entry => entry.attemptId), [claim.attempt_id, claim.attempt_id, claim.attempt_id])
  assert.deepEqual(taskTimeline.map(entry => entry.id), ['tl3', 'tl4', 'tl5'])
  assert.deepEqual(team.timeline.slice(0, 2).map(entry => entry.action), ['team.created', 'member.added'])

  const reread = await readTeam(f.stateRoot, 'timeline-team')
  assert.deepEqual(reread.timeline, team.timeline)
  const snapshot = await assembleTeamSnapshot(f.ctx, f.stateRoot, f.workspace, reread)
  assert.deepEqual(snapshot.timeline.map(entry => entry.action), ['team.created', 'member.added', 'task.claimed', 'task.started', 'task.completed'])
})

test('#263 timeline is capped at 500 entries while retaining monotonic ids', () => {
  const team = { name: 'cap', id: 'cap', captainSessionId: 'captain', createdAt: 1, members: [], tasks: [], taskSeq: 0 }
  for (let index = 0; index < 505; index += 1) appendTimeline(team, { action: 'task.created', actor: 'captain', taskId: `t${index}` })
  assert.equal(team.timeline.length, 500)
  assert.equal(team.timeline[0].id, 'tl6')
  assert.equal(team.timeline.at(-1).id, 'tl505')
  assert.equal(team.timelineSeq, 505)
})

test('#263 activity panel renders the durable timeline with localized actions', () => {
  const panel = readFileSync(new URL('../src/client/ActivityPanel.tsx', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../src/client/ActivityPanel.module.css', import.meta.url), 'utf8')
  const locales = readFileSync(new URL('../src/client/locales.ts', import.meta.url), 'utf8')
  assert.match(panel, /data-activity-timeline/u)
  assert.match(panel, /team\.timeline/u)
  assert.match(css, /\.timelineSection/u)
  for (const action of ['team.created', 'task.claimed', 'task.started', 'task.completed', 'task.failed', 'message.sent']) {
    assert.match(locales, new RegExp(`timeline\\.action\\.${action.replace('.', '\\.')}`, 'u'))
  }
})
