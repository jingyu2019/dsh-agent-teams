/**
 * P0-5: caller-declared message idempotency keys and the anti-ping-pong ceiling.
 *
 * Two independent behaviours on `agent_teams_send_message`:
 *
 * - a repeated `idempotency_key` from the same sender to the same recipient
 *   inside its 24h window replays the first delivery (same message_id) and must
 *   not write a second mailbox record;
 * - a member↔captain pair that already exchanged the window's message budget is
 *   refused loudly instead of silently dropping the message.
 *
 * The pre-existing content dedupe must keep working unchanged, which is why
 * "different key, same content" is asserted separately from the keyed path.
 *
 * These import the source tree directly (`../src/*.ts`, no build step) like
 * `p1-4-agent-catalog.test.mjs`; Node strips the types on load.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  MESSAGE_KEY_CAP,
  MESSAGE_KEY_WINDOW_MS,
  PINGPONG_WINDOW_MS,
  countPingPongMessages,
  findMessageKey,
  pingPongFailure,
  pingPongMessageLimit,
  recordMessageKey,
} from '../src/tools.ts'
import { createTeamDir, readMailbox } from '../src/state.ts'
import { registerAgentTeamsTools } from '../src/tools.ts'

const TEAM_ID = 'idem-team'

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

const withLimit = async (value, fn) => {
  const previous = process.env['AGENT_TEAMS_PINGPONG_MESSAGE_LIMIT']
  if (value === undefined) delete process.env['AGENT_TEAMS_PINGPONG_MESSAGE_LIMIT']
  else process.env['AGENT_TEAMS_PINGPONG_MESSAGE_LIMIT'] = value
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env['AGENT_TEAMS_PINGPONG_MESSAGE_LIMIT']
    else process.env['AGENT_TEAMS_PINGPONG_MESSAGE_LIMIT'] = previous
  }
}

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-p05-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const stateRoot = join(workspace, '.agent-teams')
  const captain = fakeAgent('captain', workspace)
  const worker = fakeAgent('child-worker', workspace)
  await createTeamDir(stateRoot, {
    id: TEAM_ID, name: 'Idempotency Team', captainSessionId: 'captain', createdAt: 1, phase: 'running', taskSeq: 0,
    members: [{ id: 'child-worker', name: 'worker', joinedAt: 1, status: 'idle' }],
    tasks: [],
  })
  const definitions = new Map()
  const noop = () => {}
  const ctx = {
    effect(setup) { return setup() }, on() { return noop },
    tools: { register(definition) { definitions.set(definition.name, definition) } },
    agents: { list: () => [captain, worker], get: id => id === captain.id ? captain : id === worker.id ? worker : undefined },
    llm: { async listModels(provider) { return [{ provider, id: 'm', name: 'm' }] }, async resolveCallConfig(config) { return config } },
    subagents: {
      getProvider(name) { return name === 'spawn' ? { prepareContinuable() {}, capabilities: { persona: true, toolFilter: true } } : undefined },
      list() { return ['spawn'] }, registerContinuableSetup() { return noop },
      async followup() { return 'queued' }, async sendMessage() { return 'sent' }, interrupt() {},
      async listChildren() { return [] }, async listDescendants() { return [] }, async drainContinuableChildren() {},
    },
    logger: { warn: noop, debug: noop },
  }
  registerAgentTeamsTools(ctx, { stateDir: '.agent-teams', memberProvider: 'spawn', memberMaxDepth: 0, maxMembers: 8, profiles: {}, toolPolicies: {}, skills: {} })
  const send = (args) => definitions.get('agent_teams_send_message').execute(args, {
    agent: captain, callId: 'send-test', signal: new AbortController().signal,
  })
  return { stateRoot, send }
}

test('a repeated idempotency key replays the first delivery without writing new mail', async t => {
  const f = await fixture(t)
  const first = await f.send({ to: 'worker', content: 'start the audit', idempotency_key: 'audit-start-1' })
  assert.notEqual(first.delivered, 'duplicate')
  assert.deepEqual((await readMailbox(f.stateRoot, TEAM_ID, 'worker')).map(message => message.id), [first.message_id])

  const replay = await f.send({ to: 'worker', content: 'start the audit', idempotency_key: 'audit-start-1' })
  assert.equal(replay.delivered, 'duplicate')
  assert.equal(replay.message_id, first.message_id, 'the caller must learn the first delivery it already caused')
  assert.equal((await readMailbox(f.stateRoot, TEAM_ID, 'worker')).length, 1, 'a replay must not write another message')

  const changed = await f.send({ to: 'worker', content: 'start the audit (edited)', idempotency_key: 'audit-start-1' })
  assert.equal(changed.delivered, 'duplicate')
  assert.equal(changed.message_id, first.message_id, 'the key, not the text, identifies the logical message')
  assert.equal((await readMailbox(f.stateRoot, TEAM_ID, 'worker')).length, 1)
})

test('a different key with identical content still takes the existing content-dedupe path', async t => {
  const f = await fixture(t)
  const first = await f.send({ to: 'worker', content: 'same body', idempotency_key: 'key-a' })
  const contentDuplicate = await f.send({ to: 'worker', content: 'same body', idempotency_key: 'key-b' })
  assert.equal(contentDuplicate.delivered, 'duplicate', 'content dedupe is unchanged by the new key path')
  assert.equal(contentDuplicate.message_id, first.message_id)
  assert.equal((await readMailbox(f.stateRoot, TEAM_ID, 'worker')).length, 1)

  const distinct = await f.send({ to: 'worker', content: 'different body', idempotency_key: 'key-c' })
  assert.notEqual(distinct.delivered, 'duplicate')
  assert.equal((await readMailbox(f.stateRoot, TEAM_ID, 'worker')).length, 2)
})

test('the anti-ping-pong ceiling refuses further pair messages with an explicit reason', async t => {
  await withLimit('2', async () => {
    const f = await fixture(t)
    await f.send({ to: 'worker', content: 'one', idempotency_key: 'm-1' })
    await f.send({ to: 'worker', content: 'two', idempotency_key: 'm-2' })
    await assert.rejects(
      () => f.send({ to: 'worker', content: 'three', idempotency_key: 'm-3' }),
      /suspected message ping-pong/u,
    )
    await assert.rejects(
      () => f.send({ to: 'worker', content: 'three again', idempotency_key: 'm-4' }),
      /raise AGENT_TEAMS_PINGPONG_MESSAGE_LIMIT/u,
    )
    assert.equal((await readMailbox(f.stateRoot, TEAM_ID, 'worker')).length, 2, 'a refused send must not be written')
  })
})

test('the ping-pong limit is env-overridable and falls back to 12', async () => {
  await withLimit(undefined, () => assert.equal(pingPongMessageLimit(), 12))
  await withLimit('3', () => assert.equal(pingPongMessageLimit(), 3))
  for (const nonsense of ['0', '-4', '2.5', 'abc', '']) await withLimit(nonsense, () => assert.equal(pingPongMessageLimit(), 12))
  const failure = pingPongFailure('captain', 'worker', 12)
  assert.match(failure, /refused "captain" → "worker"/u)
  assert.match(failure, /already exchanged 12 messages/u)
  assert.match(failure, /limit 12/u)
})

test('the key window expires records and the retained map stays bounded', async t => {
  const team = { messageKeys: [] }
  const at = 1_000_000
  recordMessageKey(team, { key: 'k', from: 'captain', to: 'worker', messageId: 'm1', at }, at)
  assert.equal(findMessageKey(team, 'captain', 'worker', 'k', at + MESSAGE_KEY_WINDOW_MS)?.messageId, 'm1')
  assert.equal(findMessageKey(team, 'captain', 'worker', 'k', at + MESSAGE_KEY_WINDOW_MS + 1), undefined, 'expired keys must not replay')
  assert.equal(findMessageKey(team, 'captain', 'other', 'k', at), undefined, 'keys are scoped to the exact pair')
  assert.equal(findMessageKey(team, 'someone-else', 'worker', 'k', at), undefined)

  // Rewriting the same key keeps one record; expired neighbours are dropped.
  recordMessageKey(team, { key: 'k', from: 'captain', to: 'worker', messageId: 'm2', at: at + 10 }, at + 10)
  assert.equal(team.messageKeys.length, 1)
  assert.equal(team.messageKeys[0].messageId, 'm2')
  recordMessageKey(team, { key: 'fresh', from: 'captain', to: 'worker', messageId: 'm3', at: at + MESSAGE_KEY_WINDOW_MS + 20 }, at + MESSAGE_KEY_WINDOW_MS + 20)
  assert.deepEqual(team.messageKeys.map(record => record.key), ['fresh'], 'records older than the window are pruned')

  for (let index = 0; index < MESSAGE_KEY_CAP + 8; index += 1) {
    recordMessageKey(team, { key: `bulk-${index}`, from: 'captain', to: 'worker', messageId: `id-${index}`, at: at + 100 + index }, at + 100 + index)
  }
  assert.equal(team.messageKeys.length, MESSAGE_KEY_CAP, 'the retained map is capped')
  assert.equal(team.messageKeys.at(-1).key, `bulk-${MESSAGE_KEY_CAP + 7}`, 'the newest record survives')

  const now = 5_000_000
  const messages = [
    { id: '1', from: 'captain', to: 'worker', content: 'a', ts: now - PINGPONG_WINDOW_MS + 1 },
    { id: '2', from: 'worker', to: 'captain', content: 'b', ts: now - PINGPONG_WINDOW_MS + 2 },
    { id: '3', from: 'captain', to: 'worker', content: 'c', ts: now - PINGPONG_WINDOW_MS - 1 },
    { id: '4', from: 'captain', to: 'other', content: 'd', ts: now },
  ]
  assert.equal(countPingPongMessages(messages, 'captain', 'worker', now), 2, 'both directions count, outside-pair and stale mail do not')
})
