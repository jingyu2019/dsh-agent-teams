/**
 * P2: read-only deliveries need no verification run, and members report tokens.
 *
 * A. `readOnlyDeliveryExemption` (src/quality-gates.ts) waives a pending
 *    `verification` gate only when every completed deliverable recorded an empty
 *    `changedPaths`, and it records the evidence — which verification was
 *    skipped and which deliveries justified it. Anything that reports a changed
 *    path keeps the ordinary gate.
 * B. `memberTokenUsage` (src/scheduler.ts) sums the host's own `assistant/message`
 *    usage records per member from a bounded session window. A member whose host
 *    reports nothing is `unavailable` with a reason; it is never reported as 0.
 *
 * Imports the built output (`../lib/*.js`) like the other regression scripts;
 * run `pnpm build` first when running this file directly.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { canDeclareDelivery, evaluateQualityCompletion, readOnlyDeliveryExemption } from '../lib/quality-gates.js'
import { memberTokenUsage } from '../lib/scheduler.js'

const task = (id, kind, status, extra = {}) => ({
  id, subject: id, kind, status, dependencies: [], attempt: 1, createdAt: 1, updatedAt: 1, ...extra,
})

const verification = (id, status = 'pending', extra = {}) => task(id, 'verification', status, {
  objective: 'check the delivery', acceptance: ['delivery is correct'], verify: ['npm test'], ...extra,
})

const readOnlyTeam = (tasks) => ({
  id: 't', name: 'T', captainSessionId: 'captain', createdAt: 1, phase: 'running',
  members: [{ id: '', name: 'worker', joinedAt: 1, status: 'idle' }],
  tasks,
})

test('P2 read-only delivery exempts its verification and records the evidence', () => {
  const team = readOnlyTeam([
    task('t1', 'work', 'completed', { changedPaths: [] }),
    verification('t2'),
  ])
  const exemption = readOnlyDeliveryExemption(team)
  assert.ok(exemption !== undefined, 'a delivery that changed no paths must be exempt')
  assert.deepEqual(exemption.verificationTaskIds, ['t2'])
  assert.deepEqual(exemption.basisTaskIds, ['t1'])
  assert.match(exemption.reason, /read-only delivery/u)
  assert.match(exemption.reason, /t1/u)
  assert.match(exemption.reason, /t2/u)

  const delivery = canDeclareDelivery(team)
  assert.equal(delivery.ok, true, `delivery blocked by: ${delivery.blockers.join('; ')}`)
  assert.deepEqual(delivery.exemptions?.map((item) => item.verificationTaskIds), [['t2']])
  assert.match(delivery.warnings.join('\n'), /read-only delivery/u, 'the exemption is never silent')
})

test('P2 a delivery that changed a path keeps the ordinary verification gate', () => {
  const team = readOnlyTeam([
    task('t1', 'work', 'completed', { changedPaths: ['src/a.ts'] }),
    verification('t2'),
  ])
  assert.equal(readOnlyDeliveryExemption(team), undefined)
  const delivery = canDeclareDelivery(team)
  assert.equal(delivery.ok, false)
  assert.equal(delivery.exemptions, undefined)
  assert.match(delivery.blockers.join('\n'), /t2 \(verification\) is not completed/u)
})

test('P2 the exemption never waives a non-verification gate', () => {
  const team = readOnlyTeam([
    task('t1', 'work', 'completed', { changedPaths: [] }),
    verification('t2'),
    task('t3', 'review', 'pending', { round: 1 }),
  ])
  const delivery = canDeclareDelivery(team)
  assert.equal(delivery.ok, false)
  assert.match(delivery.blockers.join('\n'), /t3 \(review\) is not completed/u)
})

test('P2 a failed verification is not exempted as if it never ran', () => {
  const team = readOnlyTeam([
    task('t1', 'work', 'completed', { changedPaths: [] }),
    verification('t2', 'failed'),
  ])
  assert.equal(readOnlyDeliveryExemption(team), undefined)
  const delivery = canDeclareDelivery(team)
  assert.equal(delivery.ok, false)
  assert.match(delivery.blockers.join('\n'), /t2 failed without a follow-up repair/u)
})

test('P2 a read-only delivery with no verification is ordinary, not exempt', () => {
  const team = readOnlyTeam([task('t1', 'work', 'completed', { changedPaths: [] })])
  assert.equal(readOnlyDeliveryExemption(team), undefined)
  assert.equal(canDeclareDelivery(team).ok, true)
})

test('P2 verification completion still demands evidence when a path changed', () => {
  // The task-level gate is untouched: a verification still cannot complete on
  // an empty report. The exemption lives at delivery, with recorded evidence.
  const gate = evaluateQualityCompletion(verification('t2', 'in_progress'), { status: 'completed' })
  assert.equal(gate.ok, false)
  assert.match(String(gate.error), /acceptanceResults|commandsRun/u)
})

const sessionAgent = (events) => ({
  id: 'child-1',
  status: 'idle',
  session: { seq: events.length, header: { cwd: '/tmp', seedLength: 0 }, events },
})

const step = (usage) => ({ type: 'assistant/message', data: { turn: 1, step: 1, usage } })

test('P2 member tokens are summed from the host usage records', () => {
  const agent = sessionAgent([
    step({ inputTokens: 10, outputTokens: 5 }),
    step({ inputTokens: 2, outputTokens: 1, cacheReadTokens: 7, totalTokens: 20 }),
    { type: 'turn/end', data: { turn: 1 } },
  ])
  const usage = memberTokenUsage({ agents: { get: (id) => id === 'child-1' ? agent : undefined } }, [
    { id: 'child-1', name: 'worker' },
  ])
  const worker = usage.get('worker')
  assert.equal(worker.status, 'available')
  assert.equal(worker.requests, 2)
  assert.equal(worker.usage.inputTokens, 12)
  assert.equal(worker.usage.outputTokens, 6)
  assert.equal(worker.usage.cacheReadTokens, 7)
  assert.equal(worker.usage.totalTokens, 20)
  assert.equal(worker.reason, undefined)
})

test('P2 a host that reports no usage yields unavailable, never zero', () => {
  const quiet = sessionAgent([{ type: 'turn/end', data: { turn: 1 } }])
  const usage = memberTokenUsage({ agents: { get: () => quiet } }, [{ id: 'child-1', name: 'worker' }])
  const worker = usage.get('worker')
  assert.equal(worker.status, 'unavailable')
  assert.equal(worker.usage, undefined, 'no fabricated zero counters')
  assert.match(worker.reason, /no token usage/u)
})

test('P2 an unattached member session yields unavailable with a reason', () => {
  const usage = memberTokenUsage({ agents: { get: () => undefined } }, [{ id: 'child-1', name: 'worker' }])
  const worker = usage.get('worker')
  assert.equal(worker.status, 'unavailable')
  assert.equal(worker.usage, undefined)
  assert.match(worker.reason, /not attached/u)
})

test('P2 an unspawned member is unavailable without reading a session', () => {
  const usage = memberTokenUsage({ agents: { get: () => { throw new Error('must not read') } } }, [
    { id: '', name: 'worker' },
  ])
  assert.equal(usage.get('worker').status, 'unavailable')
})