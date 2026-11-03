/**
 * Issue #333: ending a team can leave every member's durable host session in
 * `session/list` forever. The delete tool now offers an opt-in archive hook.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { archiveMemberSessions } from '../lib/member-sessions.js'
import { registerAgentTeamsTools } from '../lib/tools.js'
import { readArchivedTeam, readTeam, writeTeam } from '../lib/state.js'

function archiveRegistry() {
  const archived = []
  return {
    archived,
    archiveSession: async (sessionId, options) => { archived.push({ sessionId, options }) },
  }
}

test('#333 member sessions are archived once each through the host registry', async () => {
  const registry = archiveRegistry()
  const result = await archiveMemberSessions(registry, ['m1', 'm1', 'm2', '', '  '])
  assert.equal(result.archived, 2)
  assert.equal(result.skipped, 0)
  assert.deepEqual(registry.archived.map(entry => entry.sessionId), ['m1', 'm2'])
  for (const entry of registry.archived) assert.deepEqual(entry.options, { stopActivity: true })
})

test('#333 a host without the surface is reported, never fatal', async () => {
  const warnings = []
  const result = await archiveMemberSessions(undefined, ['m1', 'm2'], message => warnings.push(message))
  assert.equal(result.archived, 0)
  assert.equal(result.skipped, 2)
  assert.match(result.warnings[0], /no session archive surface/)
  assert.equal(warnings.length, 1)
})

test('#333 one rejected session does not stop the rest', async () => {
  const seen = []
  const result = await archiveMemberSessions({
    archiveSession: async (id) => {
      seen.push(id)
      if (id === 'bad') throw new Error('nope')
    },
  }, ['bad', 'good'])
  assert.equal(result.archived, 1)
  assert.equal(result.skipped, 1)
  assert.deepEqual(seen, ['bad', 'good'])
  assert.match(result.warnings[0], /could not be archived/)
})

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

async function fixture(t, registry) {
  const workspace = await mkdtemp(join(tmpdir(), 'issue-333-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const captain = fakeAgent('captain-333', workspace)
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
    get(name) { return name === 'workspaceRegistry' ? registry : undefined },
    tools: { register(definition) { definitions.set(definition.name, definition) } },
    agents: { list: () => [captain], get: id => id === captain.id ? captain : undefined },
    llm: { async listModels(provider) { return [{ provider, id: 'm', name: 'm' }] }, async resolveCallConfig(config) { return config } },
    subagents: {
      getProvider() { return undefined }, list() { return [] }, registerContinuableSetup() { return noop },
      async followup() { return 'queued' }, async sendMessage() { return 'sent' }, interrupt() {},
      async listChildren() { return [] }, async listDescendants() { return [] }, async drainContinuableChildren() {},
    },
    logger: { warn: noop, debug: noop },
  }
  registerAgentTeamsTools(ctx, { stateDir: '.agent-teams', memberProvider: 'spawn', memberMaxDepth: 0, maxMembers: 8, profiles: {}, toolPolicies: {}, skills: {} })
  const call = (name, args) => {
    const tool = definitions.get(name)
    if (!tool) throw new Error(`missing tool ${name}`)
    return tool.execute(args, { agent: captain, callId: `${name}-test`, signal: new AbortController().signal })
  }
  return { workspace, call }
}

test('#333 delete stays unchanged unless the caller opts in', async t => {
  const registry = archiveRegistry()
  const f = await fixture(t, registry)
  await f.call('agent_teams_create', { name: 'No archive', approval: 'automatic' })
  const deleted = await f.call('agent_teams_delete', {})
  assert.equal(deleted.deleted, true)
  assert.equal(deleted.archived_member_sessions, undefined)
  assert.equal(registry.archived.length, 0)
})

test('#333 opt-in delete archives the roster and reports the count', async t => {
  const registry = archiveRegistry()
  const f = await fixture(t, registry)
  await f.call('agent_teams_create', {
    name: 'Archive members', approval: 'automatic',
    plan: {
      members: [{ name: 'worker', role: 'impl' }, { name: 'reviewer', role: 'review' }],
      tasks: [{ id: 't1', subject: 'Work', assignee: 'worker' }],
    },
  })
  // A staged roster has no host session yet; give the two members the durable
  // ids a spawned member would carry before deleting.
  const root = join(f.workspace, '.agent-teams')
  const team = await readTeam(root, 'archive-members')
  team.members[0].id = 'member-333-a'
  team.members[1].id = 'member-333-b'
  await writeTeam(root, team)
  const deleted = await f.call('agent_teams_delete', { archive_member_sessions: true })
  assert.equal(deleted.deleted, true)
  assert.equal(deleted.archived_member_sessions, 2)
  assert.equal(registry.archived.length, 2)
  assert.deepEqual(registry.archived.map(entry => entry.sessionId), ['member-333-a', 'member-333-b'])
  const archived = await readArchivedTeam(join(f.workspace, '.agent-teams'), 'archive-members')
  assert.ok(archived !== undefined)
})
