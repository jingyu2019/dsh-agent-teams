import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createTeamDir, readMailbox, readTeam } from '../lib/state.js'
import { registerAgentTeamsTools } from '../lib/tools.js'

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

function task(id, status, extra = {}) {
  return { id, subject: `Subject ${id}`, status, assignee: 'worker', dependencies: [], attempt: 1, createdAt: 1, updatedAt: 1, ...extra }
}

async function fixture(t, tasks) {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-w4-195-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const stateRoot = join(workspace, '.agent-teams')
  const captain = fakeAgent('captain', workspace)
  await createTeamDir(stateRoot, {
    id: 'join-team', name: 'Join Team', captainSessionId: 'captain', createdAt: 1,
    phase: 'running', taskSeq: tasks.length,
    members: [{ id: 'child-worker', name: 'worker', joinedAt: 1, status: 'idle', generation: 1 }],
    tasks,
  })
  const definitions = new Map()
  const listeners = new Map()
  let llmCalls = 0
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
      async listModels(provider) { llmCalls += 1; return [{ provider, id: 'm', name: 'm' }] },
      async resolveCallConfig(config) { llmCalls += 1; return config },
    },
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
    profiles: {}, toolPolicies: {}, skills: {},
  })
  const call = (args) => definitions.get('agent_teams_collect').execute(args, {
    agent: captain, callId: 'collect-test', signal: new AbortController().signal,
  })
  return { stateRoot, call, llmCalls: () => llmCalls }
}

test('#195 successful join is deterministic, explicit-order aware, and idempotent', async t => {
  const f = await fixture(t, [
    task('t10', 'completed', { output: 'ten' }),
    task('t2', 'completed', { output: 'two' }),
    task('t1', 'completed', { output: 'one', verdict: 'pass' }),
  ])
  const first = await f.call({ digest: 'extractive' })
  assert.equal(first.ok, true)
  assert.equal(first.partial, false)
  assert.deepEqual(first.tasks.map(item => item.id), ['t1', 't2', 't10'])
  assert.equal(first.digest, 't1\tcompleted\tSubject t1\tone\nt2\tcompleted\tSubject t2\ttwo\nt10\tcompleted\tSubject t10\tten')
  const second = await f.call({ digest: 'extractive' })
  assert.deepEqual(second, first)
  const mailbox = await readMailbox(f.stateRoot, 'join-team', 'captain')
  assert.equal(mailbox.length, 1)
  assert.match(mailbox[0].id, /^join-ready:[0-9a-f]{64}$/)
  const team = await readTeam(f.stateRoot, 'join-team')
  assert.equal(team.joinBarriers.length, 1)
  assert.equal(team.joinBarriers[0].messageId, mailbox[0].id)
  assert.ok(team.joinBarriers[0].notifiedAt)

  const explicit = await f.call({ task_ids: ['t10', 't1'] })
  assert.deepEqual(explicit.tasks.map(item => item.id), ['t10', 't1'])
  assert.equal((await readMailbox(f.stateRoot, 'join-team', 'captain')).length, 2)
  assert.equal(f.llmCalls(), 0)
})

test('#195 nonterminal work fails closed unless partial=true and defers notice', async t => {
  const f = await fixture(t, [task('t1', 'pending'), task('t2', 'completed', { output: 'done' })])
  const closed = await f.call({})
  assert.equal(closed.ok, false)
  assert.equal(closed.partial, true)
  assert.equal(closed.digest, undefined)
  assert.deepEqual(closed.tasks[0].blockers, ['not terminal: pending'])
  assert.equal((await readMailbox(f.stateRoot, 'join-team', 'captain')).length, 0)

  const partial = await f.call({ partial: true, digest: 'extractive' })
  assert.equal(partial.ok, true)
  assert.equal(partial.partial, true)
  assert.match(partial.digest, /t1\tpending/)
  assert.equal((await readMailbox(f.stateRoot, 'join-team', 'captain')).length, 0)
})

test('#195 failed required work stays failed even in partial mode and emits one terminal notice', async t => {
  const f = await fixture(t, [task('t1', 'failed', { output: 'boom' }), task('t2', 'completed', { output: 'ok' })])
  for (let i = 0; i < 2; i += 1) {
    const result = await f.call({ partial: true, digest: 'extractive' })
    assert.equal(result.ok, false)
    assert.equal(result.partial, true)
    assert.equal(result.digest, undefined)
    assert.deepEqual(result.tasks[0].blockers, ['boom'])
  }
  const mailbox = await readMailbox(f.stateRoot, 'join-team', 'captain')
  assert.equal(mailbox.length, 1)
  assert.match(mailbox[0].content, /completed with required failures/)
})
