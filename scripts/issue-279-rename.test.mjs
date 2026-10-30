import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { appendMailbox, createMessage, createTeamDir, readMailbox, readTeam, renameMailboxOwner } from '../lib/state.js'
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

async function fixture(t, { phase = 'staged', members = ['old'] } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-279-rename-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const stateRoot = join(workspace, '.agent-teams')
  const captain = fakeAgent('captain', workspace)
  const roster = members.map((name, index) => ({ id: '', name, role: 'worker', provider: 'p', model: 'm', joinedAt: index + 1, status: 'idle' }))
  await createTeamDir(stateRoot, {
    id: 'rename-team', name: 'Rename Team', captainSessionId: 'captain', createdAt: 1,
    phase, taskSeq: 1, members: roster,
    reviewPolicy: { requiredReviewers: ['old', 'captain'] },
    profile: { name: 'demo', reviewPolicy: { requiredReviewers: ['old'] } },
    tasks: [{ id: 't1', subject: 'Do it', status: 'pending', assignee: 'old', dependencies: [], createdAt: 1, updatedAt: 1 }],
  })
  const definitions = new Map()
  const noop = () => {}
  const ctx = {
    effect(setup) { return setup() }, on() { return noop },
    tools: { register(definition) { definitions.set(definition.name, definition) } },
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
  registerAgentTeamsTools(ctx, {
    stateDir: '.agent-teams', memberProvider: 'spawn', memberMaxDepth: 0, maxMembers: 8,
    profiles: {}, toolPolicies: {}, skills: {},
  })
  const call = (args) => definitions.get('agent_teams_edit_plan').execute(args, {
    agent: captain, callId: 'rename-test', signal: new AbortController().signal,
  })
  return { stateRoot, call }
}

test('#279 staged rename updates roster, tasks, reviewers and mailbox atomically', async t => {
  const f = await fixture(t)
  await appendMailbox(f.stateRoot, 'rename-team', 'old', createMessage('old', 'captain', 'old report'))
  await f.call({ operations: [{ action: 'update_member', member_name: 'old', new_name: 'new' }] })
  const team = await readTeam(f.stateRoot, 'rename-team')
  assert.equal(team.members[0].name, 'new')
  assert.equal(team.tasks[0].assignee, 'new')
  assert.deepEqual(team.reviewPolicy.requiredReviewers, ['new', 'captain'])
  assert.deepEqual(team.profile.reviewPolicy.requiredReviewers, ['new'])
  assert.ok(team.timeline.some(entry => entry.action === 'member.renamed' && entry.from === 'old' && entry.to === 'new'))
  assert.equal((await readMailbox(f.stateRoot, 'rename-team', 'old')).length, 0)
  const moved = await readMailbox(f.stateRoot, 'rename-team', 'new')
  assert.equal(moved.length, 1)
  assert.equal(moved[0].from, 'new')
  assert.equal(moved[0].content, 'old report')
})

test('#279 staged rename rejects collisions and reserved names without changing the draft', async t => {
  const f = await fixture(t, { members: ['old', 'taken'] })
  const before = await readTeam(f.stateRoot, 'rename-team')
  await assert.rejects(
    () => f.call({ operations: [{ action: 'update_member', member_name: 'old', new_name: 'taken' }] }),
    /collides with "taken"/,
  )
  await assert.rejects(
    () => f.call({ operations: [{ action: 'update_member', member_name: 'old', new_name: 'captain' }] }),
    /reserved for the captain/,
  )
  await assert.rejects(
    () => f.call({ operations: [{ action: 'update_member', member_name: 'old', new_name: '   ' }] }),
    /must not be empty/,
  )
  const after = await readTeam(f.stateRoot, 'rename-team')
  assert.deepEqual(after.members.map(member => member.name), before.members.map(member => member.name))
  assert.equal(after.tasks[0].assignee, 'old')
})

test('#279 rename is rejected after approval', async t => {
  const f = await fixture(t, { phase: 'running' })
  await assert.rejects(
    () => f.call({ operations: [{ action: 'update_member', member_name: 'old', new_name: 'new' }] }),
    /running team only permits update_task/,
  )
})

test('#279 a failed validation leaves the staged name and mailbox untouched', async t => {
  const f = await fixture(t)
  await appendMailbox(f.stateRoot, 'rename-team', 'old', createMessage('old', 'captain', 'keep me'))
  await assert.rejects(
    () => f.call({ operations: [{ action: 'update_member', member_name: 'old', new_name: 'new', tool_policy: 'missing-policy' }] }),
    /unknown tool policy|not configured|missing-policy/i,
  )
  const team = await readTeam(f.stateRoot, 'rename-team')
  assert.equal(team.members[0].name, 'old')
  assert.equal(team.tasks[0].assignee, 'old')
  assert.equal((await readMailbox(f.stateRoot, 'rename-team', 'old')).length, 1)
  assert.equal((await readMailbox(f.stateRoot, 'rename-team', 'new')).length, 0)
})

test('#279 a later batch failure rolls back before any mailbox move', async t => {
  const f = await fixture(t)
  await appendMailbox(f.stateRoot, 'rename-team', 'old', createMessage('old', 'captain', 'keep me'))
  await assert.rejects(
    () => f.call({ operations: [
      { action: 'update_member', member_name: 'old', new_name: 'new' },
      { action: 'add_task', subject: 'Broken dependency', dependencies: ['missing-task'] },
    ] }),
    /unknown|missing|dependency/i,
  )
  const team = await readTeam(f.stateRoot, 'rename-team')
  assert.equal(team.members[0].name, 'old')
  assert.equal((await readMailbox(f.stateRoot, 'rename-team', 'old')).length, 1)
  assert.equal((await readMailbox(f.stateRoot, 'rename-team', 'new')).length, 0)
})


test('#279 mailbox move removes its destination if source removal fails', async t => {
  const f = await fixture(t)
  await appendMailbox(f.stateRoot, 'rename-team', 'old', createMessage('old', 'captain', 'keep me'))
  const inbox = join(f.stateRoot, 'rename-team', 'inbox')
  const oldFile = join(inbox, 'old.jsonl')
  const newFile = join(inbox, 'new.jsonl')
  await assert.rejects(
    () => renameMailboxOwner(f.stateRoot, 'rename-team', 'old', 'new', {
      remove: async path => {
        if (path === oldFile) throw new Error('source removal failed')
        await rm(path, { force: true })
      },
    }),
    /source removal failed/,
  )
  assert.equal((await readMailbox(f.stateRoot, 'rename-team', 'old')).length, 1)
  assert.equal((await readMailbox(f.stateRoot, 'rename-team', 'new')).length, 0)
})
