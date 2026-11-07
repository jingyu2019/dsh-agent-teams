/** Terminal member failures, composed with Harness's actual retry plugin. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { apply as installRetry } from '@deepseek-ai/dsh-llm-retry'
import { installMemberSelectionRuntime } from '../lib/members.js'
import { bindAgentRun, recordBoundAgentDiagnostic } from '../lib/harness-compat.js'
import { installTeamScheduler } from '../lib/scheduler.js'
import { appendMailbox, beginTaskAttempt, createMessage, createTeamDir, invalidateTaskAttempt, readTeam, readMailbox, readUnreadMailbox, withTeamLock, writeTeam } from '../lib/state.js'
import { assembleTeamSnapshot } from '../lib/snapshot.js'
import { registerHooks } from 'node:module'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { en, zh } from '../lib/client/locales.js'

// Render the production client panel: only unrelated host UI and CSS imports are stubbed,
// so the failure reminder assertions below run against the shipped component.
const clientHook = registerHooks({ resolve(specifier, context, next) {
  let source
  if (specifier.endsWith('.module.css')) source = 'export default new Proxy({}, {get: (_, key) => key})'
  if (context.parentURL?.endsWith('/client/ActivityPanel.js')) {
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') source = 'export const Modal = () => null'
    if (specifier === './AgentTeamsCard.js') source = 'export const OPEN_PANEL_EVENT = "test-open"'
    if (specifier === './StagingPlanEditor.js') source = 'export const StagingPlanEditor = () => null'
  }
  return source === undefined ? next(specifier, context) : { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
} })
const { TeamSection } = await import('../lib/client/ActivityPanel.js')
clientHook.deregister()

const deliveryHarness = process.argv.includes('--delivery-harness')
const modernHarness = deliveryHarness || process.argv.includes('--modern-harness')
const hostQueue = Symbol.for(deliveryHarness ? 'dsh.subagent.deliverPrompt' : 'dsh.subagent.queuePrompt')

async function eventually(predicate) {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return
    await delay(10)
  }
  assert.fail('terminal failure did not settle')
}

async function fixture(t, { captainStatus = 'idle', fallback, captainOffline = false, rejectDelivery = false, managed = false } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-member-failure-'))
  const pendingFailures = []
  let settleOnCleanup = () => {}
  t.after(async () => {
    settleOnCleanup()
    await Promise.all(pendingFailures)
    await rm(workspace, { recursive: true, force: true })
  })
  const stateRoot = join(workspace, '.agent-teams')
  const listeners = new Map()
  const steers = []
  const deliveries = []
  const warnings = []
  const sessionEvents = []
  const captain = {
    id: 'captain', status: captainStatus,
    session: { append() {} },
    steer(message) {
      if (rejectDelivery) throw new Error('captain cannot receive')
      steers.push(message)
    },
  }
  let resolveIdle
  const idle = new Promise(resolve => { resolveIdle = resolve })
  const child = {
    id: 'worker-session', status: 'running',
    steer(message) { deliveries.push({ id: this.id, content: message.content }) },
    whenIdle: () => child.status === 'idle' ? Promise.resolve() : idle,
    session: {
      header: { cwd: workspace, parentSession: captain.id, seedLength: 0 },
      events: [{ type: 'subagent/descriptor', data: {
        version: 3, mode: 'continuable', provider: 'spawn', label: 'agent-teams:team:worker',
        agentProvider: 'fake', agentModel: 'primary',
      } }],
      append(type, data) { sessionEvents.push({ type, data }) },
    },
  }
  await createTeamDir(stateRoot, {
    id: 'team', name: 'Team', captainSessionId: captain.id, createdAt: 1, taskSeq: 1,
    members: [{ id: child.id, name: 'worker', status: 'working', joinedAt: 1, provider: 'fake', model: 'primary' }],
    tasks: [{ id: 't1', subject: 'work', assignee: 'worker', status: 'in_progress', dependencies: [], attempt: 1, attemptId: 'a1', createdAt: 1, updatedAt: 1 }],
  })
  let setup
  const rootListeners = new Map()
  const disposers = []
  const ctx = {
    logger: { debug() {}, warn(message) { warnings.push(message) } },
    agents: { list: () => [], get(id) { return id === child.id ? child : id === captain.id && !captainOffline ? captain : undefined } },
    on(name, listener) { rootListeners.set(name, listener); return () => rootListeners.delete(name) },
    effect(setup) { const dispose = setup(); disposers.push(dispose); return dispose },
    subagents: {
      ...(managed ? { async startActivation() {} } : {}),
      registerContinuableSetup(fn) { setup = fn },
      async followup(_captain, id, content) { deliveries.push({ id, content }); return 'accepted' },
    },
  }
  if (modernHarness) {
    const oldEvents = child.session.events
    delete child.session.events
    delete child.session.header.seedLength
    child.session.ownEvents = () => oldEvents
    const followup = ctx.subagents.followup
    delete ctx.subagents.followup
    delete ctx.subagents.registerContinuableSetup
    ctx.subagents[hostQueue] = function (parent, id, content, source, signal, delivery) {
      if (deliveryHarness) assert.ok(['queue', 'steer'].includes(delivery))
      return followup.call(this, parent, id, content, { source, signal })
    }
    ctx.subagents.sendMessage = (parent, id, content) => followup.call(ctx.subagents, parent, id, content)
    setup = childCtx => {
      child.ctx = childCtx
      if (deliveryHarness) delete childCtx.agent
      rootListeners.get('agent/session-start')({ agent: child, source: 'startup' })
      return () => { for (const dispose of disposers) dispose() }
    }
  }
  const scheduler = installTeamScheduler(ctx, { stateDir: '.agent-teams' })
  const runtime = installMemberSelectionRuntime(ctx, '.agent-teams', (workspace, teamId, memberName) => (
    scheduler.kickMember(workspace, teamId, memberName)
  ))
  const childCtx = {
    agent: child,
    effect(setup) { const dispose = setup(); disposers.push(dispose); return dispose },
    on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name) },
    ...(managed ? {
      tools: { restrict() { return () => {} } },
      systemPrompt: { getSectionOrder() { return 0 }, section() { return () => {} } },
    } : {}),
  }
  const selection = { provider: 'fake', model: 'primary', ...fallback ? { fallback } : {} }
  const pendingSetup = managed ? { persona: 'worker role', toolFilter: {} } : undefined
  const dispose = await runtime.withPending(captain.id, 'agent-teams:team:worker', selection,
    () => setup(childCtx), pendingSetup)
  t.after(dispose)
  let retryHandler
  let projection
  let retryState = {}
  const retryDisposers = []
  installRetry({
    logger: ctx.logger,
    sessionProjections: { register(value) { projection = value }, stateOf() { return retryState } },
    on(_name, listener) { retryHandler = listener; return () => {} },
    effect(setup) { retryDisposers.push(setup()) },
  })
  t.after(async () => { for (const dispose of retryDisposers) await dispose() })
  child.session.append = (type, data) => {
    sessionEvents.push({ type, data })
    retryState = projection.apply(retryState, { type, data })
  }
  const failure = { code: 'STREAM_CLOSED', message: 'SSE stream ended without [DONE]' }
  const payload = (policy, code = failure.code, signal = new AbortController().signal) => ({
    agent: child, turn: 1, step: 0, provider: 'fake', failure: { ...failure, code }, retryPolicy: policy, signal,
  })
  const memberError = (value, next = async () => undefined) => listeners.get('agent/request-error')?.(value, next) ?? next()
  const settleSilently = () => {
    // The real driver settles after emitting agent/error. Deliberately omit
    // agent/status so recovery cannot depend on that edge reaching the plugin.
    child.status = 'idle'
    resolveIdle()
  }
  settleOnCleanup = settleSilently
  return {
    scheduler, rootListeners, workspace, child, stateRoot, steers, deliveries, warnings, listeners, sessionEvents, memberError, payload, settleSilently,
    state: () => readTeam(stateRoot, 'team'),
    mailbox: () => readMailbox(stateRoot, 'team', 'captain'),
    unread: () => readUnreadMailbox(stateRoot, 'team', 'captain'),
    retry: (policy, code) => { const value = payload(policy, code); return retryHandler(value, () => memberError(value)) },
    terminal({ settle = true, turn = 1 } = {}) {
      pendingFailures.push(listeners.get('agent/error')?.({ agent: child, turn, step: 0, error: new LlmError(failure.message, failure.code) }))
      if (settle) settleSilently()
    },
  }
}

const normal = { mode: 'normal', maxRetries: 1, retryableCodes: ['STREAM_CLOSED'], initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 }
const always = { mode: 'always', initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 }

const translate = (dict = zh) => (key, values = {}) => (dict[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(values[name]))
const renderTeam = (team, dict = zh) => renderToStaticMarkup(React.createElement(TeamSection, {
  team, workspace: true, onNavigate() {}, t: translate(dict),
}))
/** The exact snapshot the panel polls, so failure reminders are asserted end to end. */
const snapshotOf = async (h, state) => assembleTeamSnapshot(
  { agents: { get: () => undefined, list: () => [] }, logger: { warn() {} } },
  h.stateRoot, h.workspace, state ?? await h.state(),
)
const panelOf = async (h, state) => renderTeam(await snapshotOf(h, state))

/** The two steps agent_teams_reassign_task performs before a retried attempt can run. */
const retryAttempt = async (h, next = 'worker') => {
  await withTeamLock(`team:${h.stateRoot}:team`, async () => {
    const team = await readTeam(h.stateRoot, 'team')
    invalidateTaskAttempt(team.tasks[0], next, true)
    await writeTeam(h.stateRoot, team)
  })
  await withTeamLock(`team:${h.stateRoot}:team`, async () => {
    const team = await readTeam(h.stateRoot, 'team')
    beginTaskAttempt(team.tasks[0], next)
    team.tasks[0].status = 'in_progress'
    await writeTeam(h.stateRoot, team)
  })
}

/** The terminal write agent_teams_update_task performs, including optional verdict fields. */
const settleTaskAs = async (h, status, extra = {}) => {
  await withTeamLock(`team:${h.stateRoot}:team`, async () => {
    const team = await readTeam(h.stateRoot, 'team')
    Object.assign(team.tasks[0], { status, parking: undefined, updatedAt: Date.now(), ...extra })
    await writeTeam(h.stateRoot, team)
  })
}

await test('always retry keeps the owned task open and sends no false failure report', async t => {
  const h = await fixture(t)
  assert.deepEqual(await h.retry(always), { kind: 'retry' })
  assert.equal((await h.state()).tasks[0].status, 'in_progress')
  assert.equal((await h.mailbox()).length, 0)
})

await test('request handler delegates recovery and leaves exhausted requests open until final error', async t => {
  const h = await fixture(t)
  let delegated = 0
  assert.deepEqual(await h.memberError(h.payload(undefined), async () => { delegated++; return { kind: 'retry' } }), { kind: 'retry' })
  assert.equal(delegated, 1)
  assert.deepEqual(await h.retry(normal), { kind: 'retry' })
  assert.equal(await h.retry(normal), undefined)
  assert.equal((await h.state()).tasks[0].status, 'in_progress')
})

await test('fallback recovers once and exhausted fallback still delegates without failing the task', async t => {
  const h = await fixture(t, { fallback: { provider: 'backup', model: 'backup-model' } })
  assert.deepEqual(await h.memberError(h.payload(undefined, 'AUTH')), { kind: 'retry' })
  assert.deepEqual(await h.memberError(h.payload(undefined, 'RATE_LIMIT'), async () => ({ kind: 'retry' })), { kind: 'retry' })
  assert.equal((await h.state()).tasks[0].status, 'in_progress')
})

await test('aborted request does not fail a task or consume its fallback route', async t => {
  const h = await fixture(t, { fallback: { provider: 'backup', model: 'backup-model' } })
  const abort = new AbortController()
  abort.abort()
  assert.equal(await h.memberError(h.payload(undefined, 'AUTH', abort.signal)), undefined)
  assert.deepEqual(await h.memberError(h.payload(undefined, 'AUTH')), { kind: 'retry' })
  assert.equal((await h.state()).tasks[0].status, 'in_progress')
})

for (const captainStatus of ['idle', 'running']) {
  await test(`final failure notifies ${captainStatus} captain once and flushes without an idle event`, async t => {
    const h = await fixture(t, { captainStatus })
    await appendMailbox(h.stateRoot, 'team', 'worker', createMessage('captain', 'worker', 'status please'))
    h.terminal()
    h.terminal()
    await eventually(async () => (await h.state()).tasks[0].status === 'failed' && h.steers.length === 1 && h.deliveries.length === 1)
    assert.equal((await h.state()).tasks[0].attemptId, 'a1')
    assert.match((await h.state()).tasks[0].output, /STREAM_CLOSED/)
    assert.equal((await h.state()).members[0].status, 'idle')
    assert.match(JSON.stringify(h.steers[0]), /t1/)
    assert.match(JSON.stringify(h.steers[0]), /STREAM_CLOSED/)
    await eventually(async () => (await h.mailbox())[0]?.deliveredAt !== undefined)
    assert.equal((await h.unread()).length, 1, 'delivery alone does not prove consumption')
    assert.equal((await h.mailbox()).length, 1)
    assert.equal((await readUnreadMailbox(h.stateRoot, 'team', 'worker')).length, 1)
    assert.equal(h.warnings.length, 0)
  })
}

await test('report a final error immediately but do not dispatch while the driver is still running', async t => {
  const h = await fixture(t)
  await appendMailbox(h.stateRoot, 'team', 'worker', createMessage('captain', 'worker', 'status please'))
  h.terminal({ settle: false })
  await eventually(async () => (await h.state()).tasks[0].status === 'failed' && h.steers.length === 1)
  assert.equal(h.child.status, 'running')
  assert.equal((await h.state()).members[0].status, 'working')
  assert.equal(h.deliveries.length, 0)
  h.settleSilently()
  await eventually(() => h.deliveries.length === 1)
  assert.equal((await h.state()).members[0].status, 'idle')
})

for (const options of [{ captainOffline: true }, { rejectDelivery: true }]) {
  await test(`unavailable captain keeps failure notification readable: ${JSON.stringify(options)}`, async t => {
    const h = await fixture(t, options)
    h.terminal()
    await eventually(async () => (await h.unread()).length === 1)
    assert.equal((await h.state()).tasks[0].status, 'failed')
    assert.equal(h.steers.length, 0)
  })
}

await test('a queued error cannot fail a newer attempt created before it gets the team lock', async t => {
  const h = await fixture(t)
  let release
  let locked
  const ready = new Promise(resolve => { locked = resolve })
  const lock = withTeamLock(`team:${h.stateRoot}:team`, async () => {
    locked()
    await new Promise(resolve => { release = resolve })
    const team = await h.state()
    team.tasks[0].attempt = 2
    team.tasks[0].attemptId = 'a2'
    await writeTeam(h.stateRoot, team)
  })
  await ready
  h.terminal()
  release()
  await lock
  await withTeamLock(`team:${h.stateRoot}:team`, async () => {})
  assert.equal((await h.state()).tasks[0].status, 'in_progress')
  assert.equal((await h.state()).tasks[0].attemptId, 'a2')
  assert.equal((await h.mailbox()).length, 0)
})

await test('W1 request-error correlation uses the exact Agent object', () => {
  const current = { id: 'same' }
  const stale = { id: 'same' }
  const seen = []
  bindAgentRun(current, { teamId: 't', activationId: 'a', hostRunId: 'r', memberId: 'same',
    memberGeneration: 1, activationEpoch: 1, recordDiagnostic: value => seen.push(value) })
  assert.equal(recordBoundAgentDiagnostic(stale, 'stale'), false)
  assert.equal(recordBoundAgentDiagnostic(current, 'bound'), true)
  assert.deepEqual(seen, ['bound'])
})
await test('W1 route-owned error never falls back to member-name identity', () => {
  const current = { id: 'worker' }
  const impostor = { id: 'worker' }
  let calls = 0
  bindAgentRun(current, { teamId: 't', activationId: 'a', hostRunId: 'r', memberId: 'worker',
    memberGeneration: 1, activationEpoch: 1, recordDiagnostic: () => { calls++ } })
  assert.equal(recordBoundAgentDiagnostic(impostor, 'stale'), false)
  assert.equal(calls, 0)
})

await test('a bound route-owned request error returns undefined and never calls next', async t => {
  const h = await fixture(t)
  const seen = []
  bindAgentRun(h.child, { teamId: 'team', activationId: 'act', hostRunId: 'run', memberId: h.child.id,
    memberGeneration: 1, activationEpoch: 1, recordDiagnostic: value => seen.push(value) })
  let nextCalls = 0
  const result = await h.memberError(h.payload(undefined, 'RATE_LIMIT'), async () => {
    nextCalls++
    return { kind: 'retry' }
  })
  assert.equal(result, undefined)
  assert.equal(nextCalls, 0)
  assert.match(seen[0], /RATE_LIMIT/)
})

await test('managed unbound agent/error is ignored and cannot fail the task', async t => {
  const h = await fixture(t, { managed: true })
  const before = await h.state()
  h.terminal({ settle: false })
  await new Promise(resolve => setTimeout(resolve, 30))
  const after = await h.state()
  assert.equal(after.tasks[0].status, before.tasks[0].status)
  assert.equal(after.tasks[0].attemptId, before.tasks[0].attemptId)
  assert.equal((await h.mailbox()).length, 0)
})

await test('managed unbound agent/request-error does not call next or mutate the task', async t => {
  const h = await fixture(t, { managed: true })
  let nextCalls = 0
  const result = await h.memberError(h.payload(undefined, 'RATE_LIMIT'), async () => {
    nextCalls++
    return { kind: 'retry' }
  })
  assert.equal(result, undefined)
  assert.equal(nextCalls, 0)
  assert.equal((await h.state()).tasks[0].status, 'in_progress')
})

// ---- The failure reminder must not outlive its own attempt -------------------
// A member turn that dies is reported once, but the reminder is durable state on
// the captain: a mailbox note plus (for scheduler-owned activations) a
// notification-ledger entry. Both must retire as soon as the exact failed
// attempt is retried or reaches a later outcome, and both must survive while
// that attempt is still the failed one.

await test('a retried attempt retires the member failure reminder end to end', async t => {
  const h = await fixture(t)
  h.terminal()
  await eventually(async () => (await h.unread()).length === 1)

  // Before recovery the reminder is real in every surface the captain reads.
  const failed = await h.state()
  assert.equal(failed.tasks[0].status, 'failed')
  const before = await snapshotOf(h, failed)
  assert.equal(before.captainInbox.length, 1)
  assert.match(before.captainInbox[0].content, /was marked failed; reassign it or retry when ready/)
  const failedHtml = renderTeam(before)
  assert.ok(failedHtml.includes(zh['task.detail.failed']), 'the member row must report the open failure')
  assert.match(failedHtml, /data-status="failed"/, 'the member badge must report the open failure')
  assert.ok(failedHtml.includes(translate(zh)('task.summary.ended', { completed: 0, cancelled: 0, failed: 1 })), 'the summary must count the failure')
  assert.match(failedHtml, /class="progressSummary" data-state="warning"/)

  // Real retry path: invalidate (reassign), begin the new attempt, then finish it.
  await retryAttempt(h)
  await settleTaskAs(h, 'completed', { output: 'delivered' })
  await h.scheduler.kickTeam(h.workspace, 'team')

  const team = await h.state()
  assert.equal(team.tasks[0].status, 'completed')
  assert.equal(team.tasks[0].attempt, 2)
  assert.deepEqual(await h.unread(), [], 'a recovered attempt must not keep the captain failure note')
  const after = await snapshotOf(h, team)
  assert.deepEqual(after.captainInbox, [])
  const html = renderTeam(after)
  assert.ok(!html.includes(zh['task.detail.failed']), 'the recovered task must not report a failure')
  assert.doesNotMatch(html, /data-status="failed"/, 'the delivered member must not keep the failure badge')
  assert.ok(html.includes(zh['member.status.delivered']), 'the member must read as delivered')
  assert.ok(html.includes(translate(zh)('task.summary.allDelivered', { count: 1 })))
  assert.ok(!html.includes(translate(zh)('task.summary.ended', { completed: 0, cancelled: 0, failed: 1 })))
  assert.match(html, /data-completed="1" data-total="1"/)
  assert.doesNotMatch(html, /class="progressSummary" data-state="warning"/)
})

await test('a recovered scheduler settlement failure leaves no reminder on the captain', async t => {
  const h = await fixture(t)
  // Arrange a dispatchable attempt so the scheduler owns the activation and its
  // notification-ledger entry, not the member request-error path.
  await withTeamLock(`team:${h.stateRoot}:team`, async () => {
    const team = await readTeam(h.stateRoot, 'team')
    const task = team.tasks[0]
    task.status = 'pending'
    task.attemptId = undefined
    task.attempt = 0
    team.members[0].status = 'idle'
    await writeTeam(h.stateRoot, team)
  })
  h.settleSilently()
  await h.scheduler.kickMember(h.workspace, 'team', 'worker')
  const lease = (await h.state()).activations?.[0]
  assert.notEqual(lease, undefined, 'the scheduler must own an activation for this path')
  h.rootListeners.get('subagent/end')({
    id: 'worker-session', runId: lease.hostRunId ?? 'run-1', provider: 'fake', local: true,
    stopReason: 'error', lastAssistantMessage: [],
  })
  await eventually(async () => (await h.state()).tasks[0].status === 'failed')
  assert.equal((await h.state()).notifications?.[0]?.kind, 'failed')
  await eventually(async () => (await h.unread()).length === 1)

  await retryAttempt(h)
  await settleTaskAs(h, 'completed', { output: 'delivered' })
  const steers = h.steers.length
  await h.scheduler.kickTeam(h.workspace, 'team')
  await new Promise(resolve => setTimeout(resolve, 60))

  assert.equal(h.steers.length, steers, 'a recovered attempt must not steer the captain about the old failure')
  assert.deepEqual(await h.unread(), [], 'the settlement failure note must be retired with its attempt')
  assert.deepEqual((await snapshotOf(h)).captainInbox, [])
  assert.deepEqual((await h.state()).notifications?.filter(notice => notice.kind !== 'parked' && notice.state === 'pending') ?? [], [])
})

await test('an unresolved failure keeps its reminder and its failed badges', async t => {
  const h = await fixture(t)
  h.terminal()
  await eventually(async () => (await h.unread()).length === 1)
  // Scheduler edges must never clear a reminder whose attempt is still failed.
  await h.scheduler.kickTeam(h.workspace, 'team')
  await h.scheduler.kickTeam(h.workspace, 'team')

  const team = await h.state()
  assert.equal(team.tasks[0].status, 'failed')
  assert.equal((await h.unread()).length, 1)
  const html = await panelOf(h, team)
  assert.ok(html.includes(zh['task.detail.failed']))
  assert.match(html, /data-status="failed"/)
  assert.ok(html.includes(translate(zh)('task.summary.ended', { completed: 0, cancelled: 0, failed: 1 })))
})

for (const verdict of ['needs_revision', 'reject']) {
  await test(`a failed ${verdict} verdict keeps its failure reminder`, async t => {
    const h = await fixture(t)
    h.terminal()
    await eventually(async () => (await h.unread()).length === 1)
    await settleTaskAs(h, 'failed', {
      verdict,
      findings: [{ id: 'f1', severity: 'high', problem: 'incomplete', requiredFix: 'finish it' }],
    })
    await h.scheduler.kickTeam(h.workspace, 'team')

    const team = await h.state()
    assert.equal(team.tasks[0].status, 'failed')
    assert.equal(team.tasks[0].verdict, verdict)
    assert.equal((await h.unread()).length, 1, 'a verdict failure is still an unresolved failure')
    const html = await panelOf(h, team)
    assert.ok(html.includes(zh['task.detail.failed']))
    assert.match(html, /class="progressSummary" data-state="warning"/)
  })
}

await test('a member report is never discarded as a failure reminder', async t => {
  const h = await fixture(t)
  h.terminal()
  await eventually(async () => (await h.unread()).length === 1)
  await appendMailbox(h.stateRoot, 'team', 'captain', {
    ...createMessage('worker', 'captain', 'report: my attempt failed and I stopped'),
    sourceTaskId: 't1',
    sourceAttemptId: 'a1',
    sourceTaskStatus: 'failed',
    reportKind: 'final',
  })
  await retryAttempt(h)
  await settleTaskAs(h, 'completed', { output: 'delivered' })
  await h.scheduler.kickTeam(h.workspace, 'team')

  const remaining = await h.unread()
  assert.equal(remaining.length, 1, 'only the reminder is retired; a member report stays durable')
  assert.match(remaining[0].content, /report: my attempt failed and I stopped/)
})

// The reminder is bound to one attempt generation, not to the task's failure bit.
// A reassigned task keeps failing, but only the newest attempt may report it: the
// reminder of the attempt that was replaced must be retired the moment the task
// carries a newer attemptId, or the captain reads a failure that is already moot.
await test('a re-failed attempt retires only the reminder of the attempt it replaced', async t => {
  const h = await fixture(t)
  // Arrange a dispatchable attempt so the scheduler owns the first failure and its
  // notification-ledger entry; the ledger is where the generation is compared.
  await withTeamLock(`team:${h.stateRoot}:team`, async () => {
    const team = await readTeam(h.stateRoot, 'team')
    const task = team.tasks[0]
    task.status = 'pending'
    task.attemptId = undefined
    task.attempt = 0
    team.members[0].status = 'idle'
    await writeTeam(h.stateRoot, team)
  })
  h.settleSilently()
  await h.scheduler.kickMember(h.workspace, 'team', 'worker')
  const lease = (await h.state()).activations?.[0]
  assert.notEqual(lease, undefined, 'the scheduler must own an activation for this path')
  h.rootListeners.get('subagent/end')({
    id: 'worker-session', runId: lease.hostRunId ?? 'run-1', provider: 'fake', local: true,
    stopReason: 'error', lastAssistantMessage: [],
  })
  await eventually(async () => (await h.state()).tasks[0].status === 'failed')
  const failed = await h.state()
  const firstAttemptId = failed.tasks[0].attemptId
  assert.equal(failed.tasks[0].attempt, 1)
  const firstNotice = failed.notifications?.find(notice => notice.kind === 'failed')
  assert.notEqual(firstNotice, undefined, 'the settlement failure must be recorded in the ledger')
  assert.equal(firstNotice.attemptId, firstAttemptId)
  await eventually(async () => (await h.unread()).length === 1)

  // Reassign replaces the attempt generation, exactly as agent_teams_reassign_task does.
  await retryAttempt(h)
  const retried = await h.state()
  const secondAttemptId = retried.tasks[0].attemptId
  assert.equal(retried.tasks[0].attempt, 2)
  assert.notEqual(secondAttemptId, firstAttemptId, 'the retried attempt must carry a new attemptId')

  // The retried attempt dies too, so the task is failed again - for a newer attempt.
  h.terminal({ turn: 2 })
  await eventually(async () => (await h.state()).tasks[0].status === 'failed'
    && (await h.unread()).some(message => message.sourceAttemptId === secondAttemptId))
  const steers = h.steers.length
  await h.scheduler.kickTeam(h.workspace, 'team')

  const team = await h.state()
  assert.equal(team.tasks[0].attemptId, secondAttemptId)
  const unread = await h.unread()
  assert.equal(unread.length, 1, 'only the newest failed attempt may keep a reminder')
  assert.equal(unread[0].sourceAttemptId, secondAttemptId, 'the surviving reminder belongs to attempt 2')
  const replaced = (await h.mailbox()).find(message => message.sourceAttemptId === firstAttemptId)
  assert.notEqual(replaced, undefined, 'the replaced attempt reminder must stay durable, only retired')
  assert.notEqual(replaced.discardedAt, undefined, 'the replaced attempt reminder must be retired, not left queued')
  const retiredNotice = (await h.state()).notifications.find(notice => notice.id === firstNotice.id)
  assert.ok(!['pending', 'appended'].includes(retiredNotice.state),
    'the replaced attempt notice must never be flushed again')
  assert.equal(h.steers.length, steers, 'a replaced attempt must not steer the captain')

  // The live failure is still a real failure: retirement must not clear the current one.
  const html = await panelOf(h, team)
  assert.ok(html.includes(zh['task.detail.failed']))
  assert.match(html, /data-status="failed"/)
})
