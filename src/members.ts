/**
 * Member subagent lifecycle: spawn a continuable child per member, deliver
 * task turns and step-boundary messages, and observe its activity.
 *
 * Members are durable continuable subagents of the captain, so a member keeps
 * its conversation across turns and across harness restarts: the captain
 * queues its next turn through {@link deliverToMember}, it works through its turn
 * (updating team state through the `agent_teams_*` tools), and becomes idle
 * again. Its final assistant message is not readable programmatically, so the
 * member persists its report into the captain's mailbox and the task records,
 * which the captain reads through `agent_teams_status`.
 * @module dsh-agent-teams/members
 */

import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type ModelSelection } from '@deepseek-ai/dsh-agent'
// Declaration merge only: makes ctx.subagents visible.
import { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { createUserMessage, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { join } from 'node:path'
import { agentTeamsSource, boundAgentRun, recordBoundAgentDiagnostic, observedSessionFormatVersion, type MemberStartResult, type SessionFormatBearer, guardSubagentCreation, startMember, usesManagedActivations, guardSubagentDelivery, installContinuableMemberSetup, memberToolFilter, queueMemberPrompt, restrictableToolNames, startMemberWithLenientFilter, steerMemberPrompt, sessionOwnEvents } from './harness-compat.ts'
import { markMailboxDelivered, appendMailbox, CAPTAIN_KEY, clearTaskProbe, createMessage, readRetiredMemberIds, readTeamSync, readTeam, releaseMailboxDelivery, withTeamLock, writeTeam } from './state.ts'
import { mailboxPrompt } from './mailbox.ts'
import { nearestLiveLead } from './lineage.ts'
import { appendTeamEvent, captainSessionOf } from './events.ts'
import type { MemberToolFilter } from './tool-policies.ts'
import { resolveMemberSkills, type SkillBindingConfig } from './profiles.ts'
import { createWorktreeLane, type WorktreeConfig } from './worktrees.ts'
import { TERMINAL_TASK_STATUSES, type RouteCursor, type RouteFailureClass, type TeamMember, type TeamModelFallback, type TeamState, type TeamTask } from './types.ts'

/** Persona snapshot of a profile protocol; the full text lives on team.json. */
export const PERSONA_PROTOCOL_MAX_CHARS = 400

/**
 * Restore the SessionId brand on a value that round-tripped through the
 * durable team file. The brand is erased by JSON serialization; the value
 * originated from `startContinuable`/`agent.id`, so this cast is the boundary
 * restoration, not a new assertion.
 */
function brandedSessionId(value: string): SessionId {
  return value as SessionId
}

/** Runtime knobs for member spawning, resolved from plugin config. */
export interface MemberRuntimeConfig {
  /** Registered `ctx.subagents` provider name (must support continuable + persona). */
  provider: string
  /** Owner-declared skill snippets selected by profile members (#244). */
  skills?: Record<string, SkillBindingConfig>
  /** Child delegation depth cap (0 forbids delegation entirely). */
  maxDepth?: number
  /** Plugin-wide execution prompt. */
  executionPrompt?: string
  /** Plugin-wide fallback route. */
  fallback?: { provider: string; model: string }
  /** Ordered additional routes after the primary route. */
  fallbacks?: { provider: string; model: string }[]
  /** Prompt-only opt-in for multiple AgentTeams calls in one response. */
  parallelToolCalls?: boolean
  /** Opt-in member-lane worktree isolation (#287). */
  worktrees?: WorktreeConfig
}

/** Durable provider/model/reasoning snapshot for one member. */
export interface MemberLlmSelection {
  /** Registered LLM provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-owned reasoning effort, absent when the target has no explicit/default effort. */
  reasoningEffort?: string
  /** Configured second-choice route. */
  fallback?: { provider: string; model: string }
  /** Ordered additional routes after the primary route. */
  fallbacks?: { provider: string; model: string }[]
}

/** Optional member-level route requested by the captain. */
export interface MemberLlmSelectionRequest {
  /** Explicit LLM provider route; requires an explicit model. */
  provider?: string
  /** Explicit model id; otherwise the plugin default or captain model is used. */
  model?: string
  /** Plugin-level member model default. */
  defaultModel?: string
  /** Configured member LLM provider, paired with `defaultModel` (issue #189). */
  defaultProvider?: string
  /** Explicit reasoning effort; "default" selects the target model's default effort. */
  reasoningEffort?: string
  /** Configured fallback route. */
  fallback?: { provider: string; model: string }
  /** Ordered additional routes after the primary route. */
  fallbacks?: { provider: string; model: string }[]
}

/** A composed member route plus where each half came from. */
export interface MemberRouteResolution {
  readonly provider: { readonly value: string; readonly source: 'request' | 'config' | 'captain' }
  readonly model: { readonly value: string; readonly source: 'request' | 'config' | 'captain' }
  /**
   * Whether the provider half was *derived* rather than named. Only a
   * model-only plugin default may have its owner looked up in the provider
   * catalogs; a provider or model the caller named is never re-pointed.
   */
  readonly derivedProvider: boolean
}

/**
 * Compose one member route from request, plugin configuration and the captain
 * session, without performing any I/O. This is the single place where the
 * precedence between the captain's route and a configured member default is
 * decided, so a configured model can never be silently paired with whichever
 * provider the captain happens to sit on (issue #189).
 *
 * Precedence: explicit request > plugin configuration > captain session. Model
 * ids are used verbatim: a `/` inside a model id is part of that id and is
 * never treated as a provider separator.
 *
 * `derivedProvider` is true only for a bare configured `memberModel` with no
 * provider anywhere, which is the one shape whose owner must come from the
 * provider catalogs.
 * @param request - the captain-supplied and plugin-configured route halves.
 * @param captain - the captain's current session route.
 * @returns the composed route, or `undefined` when a half cannot be determined.
 */
export function composeMemberRoute(
  request: Pick<MemberLlmSelectionRequest, 'provider' | 'model' | 'defaultModel' | 'defaultProvider'>,
  captain: { readonly provider: string; readonly model: string },
): MemberRouteResolution | undefined {
  const explicitProvider = request.provider?.trim()
  const explicitModel = request.model?.trim()
  const configuredModel = request.defaultModel?.trim()
  const configuredProvider = request.defaultProvider?.trim()
  if (explicitProvider !== undefined && explicitModel === undefined) return undefined
  if (explicitProvider === '' || explicitModel === '' || configuredModel === '' || configuredProvider === '') return undefined

  const providerValue = explicitProvider ?? configuredProvider ?? captain.provider
  const providerSource = explicitProvider !== undefined ? 'request' as const : configuredProvider !== undefined ? 'config' as const : 'captain' as const
  const modelValue = explicitModel ?? configuredModel ?? captain.model
  const modelSource = explicitModel !== undefined ? 'request' as const : configuredModel !== undefined ? 'config' as const : 'captain' as const
  return {
    provider: { value: providerValue, source: providerSource },
    model: { value: modelValue, source: modelSource },
    // A named provider is authoritative, and a named model keeps the route the
    // caller asked for. Only a model-only plugin default is allowed to have its
    // owner discovered from the catalogs.
    derivedProvider: providerSource === 'captain' && modelSource === 'config',
  }
}

/** Process-local bridge between spawn admission and synchronous child setup. */
export interface MemberSelectionRuntime {
  /** Trusted fresh-child admission, before the durable member id is written. */
  isPendingMember(agent: Agent): boolean
  /** Make one selection visible while Harness materializes the fresh child. */
  withPending<T>(
    parentSessionId: string,
    label: string,
    selection: MemberLlmSelection,
    operation: () => Promise<T>,
    setup?: TeamMember['runtimeSetup'],
  ): Promise<T>
}

/**
 * Validate a resolved roster against every provider catalog before any child
 * session is created. Catalogs are advisory when empty (some adapters accept
 * dynamic model ids), but a non-empty catalog is authoritative enough to
 * catch a typo that would otherwise boot a child and fail on its first turn.
 */
export async function validateMemberLlmSelections(
  ctx: Context,
  selections: readonly MemberLlmSelection[],
  signal?: AbortSignal,
): Promise<void> {
  const catalogs = new Map<string, Awaited<ReturnType<typeof ctx.llm.listModels>>>()
  for (const selection of selections) {
    if (signal?.aborted === true) throw signal.reason ?? new Error('member model validation was cancelled')
    let catalog = catalogs.get(selection.provider)
    if (catalog === undefined) {
      catalog = await ctx.llm.listModels(selection.provider)
      catalogs.set(selection.provider, catalog)
    }
    if (catalog.length === 0 || catalog.some((model) => model.id === selection.model)) continue
    const available = catalog.slice(0, 8).map((model) => model.id).join(', ')
    throw new Error(
      `unknown member model "${selection.model}" for provider "${selection.provider}"`
      + `${available === '' ? '' : ` (available: ${available}${catalog.length > 8 ? ', …' : ''})`}`,
    )
  }
}

const MEMBER_LABEL_PREFIX = 'agent-teams:'
const FALLBACK_FAILURE_CODES = new Set(['QUOTA', 'RATE_LIMIT', 'AUTH', 'MISSING_CREDENTIAL', 'NO_ADAPTER'])

export function isFallbackFailureCode(code: string): boolean {
  return FALLBACK_FAILURE_CODES.has(code)
}

/** Pure state transition used by the request-error handler and TDD tests. */
export function selectFallbackRoute(
  current: { provider: string; model: string },
  fallback: { provider: string; model: string } | undefined,
  failureCode: string,
  alreadySwitched: boolean,
): { retry: boolean; switched: boolean; selection: { provider: string; model: string } } {
  if (alreadySwitched || fallback === undefined || !isFallbackFailureCode(failureCode)) {
    return { retry: false, switched: alreadySwitched, selection: current }
  }
  return { retry: true, switched: true, selection: fallback }
}

/** Per-route transient attempt cap and deterministic backoff schedule. */
export const ROUTE_MAX_TRANSIENT_ATTEMPTS = 3
export const ROUTE_COOLDOWNS_MS = [1_000, 2_000, 4_000] as const
const ROUTE_TRANSIENT_CODES = new Set(['RATE_LIMIT', '429', 'TOO_MANY_REQUESTS'])
const ROUTE_PERMANENT_CODES = new Set(['AUTH', 'MISSING_CREDENTIAL', 'NO_ADAPTER', 'QUOTA', 'INSUFFICIENT_QUOTA'])
const ROUTE_BUDGET_CODES = new Set(['BUDGET', 'BUDGET_EXHAUSTED', 'INSUFFICIENT_BUDGET', 'MAX_TOKENS'])

/** Normalize a legacy singular fallback and an ordered chain into one list. */
export function normalizeRouteChain(
  fallback: TeamModelFallback | undefined,
  fallbacks: readonly TeamModelFallback[] | undefined,
): TeamModelFallback[] {
  const chain = [...(fallbacks ?? [])]
  if (fallback !== undefined) {
    const first = chain[0]
    if (first === undefined || first.provider !== fallback.provider || first.model !== fallback.model) chain.unshift(fallback)
  }
  return chain.slice(0, 4).filter(route => route.provider.trim() !== '' && route.model.trim() !== '')
}

/** Initialize the durable cursor for one newly-started task attempt. */
export function createRouteCursor(routeCount = 1): RouteCursor {
  return {
    routeGeneration: 1,
    currentRouteIndex: 0,
    routeAttempts: [0],
    cooldowns: [],
    state: 'ready',
  }
}

/** Classify a provider failure without relying on host retry policy. */
export function classifyRouteFailure(code: string): RouteFailureClass {
  const normalized = code.trim().toUpperCase()
  if (ROUTE_TRANSIENT_CODES.has(normalized)) return 'transient'
  if (ROUTE_PERMANENT_CODES.has(normalized)) return 'permanent'
  if (ROUTE_BUDGET_CODES.has(normalized)) return 'budget'
  return 'unknown'
}

export interface RouteFailureOptions {
  readonly activationId?: string
  readonly hostRunId?: string
  readonly at?: number
}

/**
 * Apply one route failure to a cursor. The function is pure and deterministic:
 * transient failures retry the same route at 1/2/4 seconds, then advance once;
 * permanent failures advance immediately; unknown and budget failures exhaust.
 */
export function recordRouteFailure(
  input: RouteCursor | undefined,
  code: string,
  routeCount: number,
  options: RouteFailureOptions = {},
): RouteCursor {
  const now = options.at ?? Date.now()
  const cursor: RouteCursor = input === undefined
    ? createRouteCursor(routeCount)
    : {
      ...input,
      routeAttempts: [...input.routeAttempts],
      cooldowns: [...input.cooldowns],
      ...input.lastFailure === undefined ? {} : { lastFailure: { ...input.lastFailure } },
    }
  const activationId = options.activationId ?? cursor.lastFailure?.activationId ?? ''
  const hostRunId = options.hostRunId ?? cursor.lastFailure?.hostRunId ?? ''
  if (cursor.lastFailure !== undefined
    && cursor.lastFailure.activationId === activationId
    && cursor.lastFailure.hostRunId === hostRunId) {
    return cursor
  }
  const failureClass = classifyRouteFailure(code)
  cursor.lastFailure = { activationId, hostRunId, code, class: failureClass, at: now }
  const count = (cursor.routeAttempts[cursor.currentRouteIndex] ?? 0) + 1
  cursor.routeAttempts[cursor.currentRouteIndex] = count
  if (failureClass === 'unknown' || failureClass === 'budget' || routeCount <= 1 && failureClass !== 'transient') {
    cursor.state = 'exhausted'
    cursor.nextActionAt = undefined
    return cursor
  }
  if (failureClass === 'transient' && count < ROUTE_MAX_TRANSIENT_ATTEMPTS) {
    const delay = ROUTE_COOLDOWNS_MS[Math.min(count - 1, ROUTE_COOLDOWNS_MS.length - 1)]!
    cursor.state = 'waiting'
    cursor.nextActionAt = now + delay
    cursor.cooldowns = cursor.cooldowns.filter(item => item.routeIndex !== cursor.currentRouteIndex)
    cursor.cooldowns.push({ routeIndex: cursor.currentRouteIndex, until: cursor.nextActionAt, reason: code })
    return cursor
  }
  if (cursor.currentRouteIndex + 1 < routeCount) {
    cursor.currentRouteIndex += 1
    cursor.routeGeneration += 1
    cursor.routeAttempts[cursor.currentRouteIndex] = 0
    cursor.cooldowns = []
    if (failureClass === 'transient') {
      cursor.state = 'waiting'
      cursor.nextActionAt = now + ROUTE_COOLDOWNS_MS[0]!
      cursor.cooldowns.push({ routeIndex: cursor.currentRouteIndex, until: cursor.nextActionAt, reason: code })
    } else {
      cursor.state = 'ready'
      cursor.nextActionAt = undefined
    }
    return cursor
  }
  cursor.state = 'exhausted'
  cursor.nextActionAt = undefined
  return cursor
}

/** Whether a route cursor may create its next activation now. */
export function routeCursorReady(cursor: RouteCursor | undefined, now = Date.now()): boolean {
  if (cursor === undefined) return true
  if (cursor.state === 'exhausted') return false
  return cursor.state === 'ready' || (cursor.nextActionAt ?? 0) <= now
}

/** The durable route chain for one member, including the legacy singular route. */
export function memberRouteChain(member: Pick<TeamMember, 'provider' | 'model' | 'fallback' | 'fallbacks'>): TeamModelFallback[] {
  if (member.provider === undefined || member.model === undefined || member.provider === '' || member.model === '') return []
  return [{ provider: member.provider, model: member.model }, ...normalizeRouteChain(member.fallback, member.fallbacks)]
}

/** Deliver a durable member report to the live captain at its next model step. */
export function steerCaptainReport(captain: Pick<Agent, 'steer'> & SessionFormatBearer, from: string, content: string, receipt?: string): boolean {
  try {
    captain.steer(createUserMessage({
      content: [{ type: 'text', text: receipt ?? `AgentTeams message from member ${from}:\n\n${content}` }],
      source: agentTeamsSource({ kind: 'agent-teams' }, observedSessionFormatVersion(captain)),
    }))
    return true
  } catch {
    return false
  }
}

interface FailedMemberAttempt {
  readonly captainSessionId: string
  readonly memberId: string
  readonly task?: Pick<TeamTask, 'id' | 'attempt' | 'attemptId'>
}

/** How a final member turn failure relates to the durable record. */
export type MemberFailureDisposition =
  /** A live observed attempt was failed and its task marked failed. */
  | 'failed_attempt'
  /** The work had already settled; only a durable captain note was added. */
  | 'noted_settled'
  /** No record: stale generation, superseded attempt, retired member, or no team. */
  | 'ignored'

/**
 * Classify a final member turn failure against the durable record. Pure, so the
 * policy is testable without a lock or a Harness.
 *
 * A failure may only mutate the attempt the plugin actually observed. When that
 * attempt is gone — the member moved on to newer work, the task was
 * reassigned to a newer attempt, or the member generation was replaced — the
 * late error carries no authority and stays silent. When the failure belongs to
 * the current generation but its work already settled, the task and member are
 * left exactly as they are and only a durable captain note is added: otherwise
 * an operator cannot tell a clean run from one whose member's last turn died
 * (429, auth failure, crash) after the delivery landed (issue #205).
 * @param observed - the live member/task capability captured at the error event.
 * @param current - the current durable member record and open task, if any.
 * @returns the disposition for this failure.
 */
export function classifyMemberFailure(
  observed: FailedMemberAttempt,
  current: {
    readonly member?: Pick<TeamMember, 'id' | 'status'> | undefined
    readonly task?: Pick<TeamTask, 'id' | 'attempt' | 'attemptId'> | undefined
    /** The durable record of the task the observation referred to, settled or not. */
    readonly observedRecord?: Pick<TeamTask, 'id' | 'status' | 'subject'> | undefined
  },
): MemberFailureDisposition {
  const member = current.member
  // Only the exact member generation observed at the error event may report it.
  // A replaced generation (same name, new session id) or a member record that is
  // gone cannot be failed by that child's late error.
  if (member === undefined || member.id !== observed.memberId) return 'ignored'
  const task = current.task
  if (task === undefined) {
    // No open attempt is owned by this generation any more, so nothing here may
    // be mutated — but the failure itself must still be recorded. `working` is
    // NOT evidence of newer work: `syncMemberStatus` writes it as soon as the
    // turn runs, while a task completed earlier in that same turn leaves no open
    // attempt behind (the reporter's run A). Only a *concrete* superseded open
    // attempt — the branch below — or a replaced generation may stay silent.
    return 'noted_settled'
  }
  if (task.id !== observed.task?.id || task.attemptId !== observed.task?.attemptId
    || task.attempt !== observed.task?.attempt) return 'ignored'
  return 'failed_attempt'
}

/**
 * The surviving durable record of the capability observed at the error event,
 * or `undefined` when there is nothing honest to say about it.
 *
 * A task is only described as *settled* when its durable status is terminal
 * (`completed`/`failed`/`cancelled`). A non-terminal record — for example a task
 * that was claimed and then unclaimed or reassigned while the error was queued —
 * must fall back to the plain "no open attempt" wording instead of implying a
 * delivery landed.
 */
export function settledTaskRecord(
  observed: Pick<TeamTask, 'id'> | undefined,
  tasks: readonly Pick<TeamTask, 'id' | 'status' | 'subject'>[],
): Pick<TeamTask, 'id' | 'status' | 'subject'> | undefined {
  if (observed === undefined) return undefined
  const record = tasks.find(candidate => candidate.id === observed.id)
  if (record === undefined) return undefined
  return TERMINAL_TASK_STATUSES.includes(record.status) ? record : undefined
}

/**
 * Build the durable captain note for one recorded failure. Pure, so the wording
 * boundaries are testable without a lock or a Harness.
 * @param memberName - the member that failed.
 * @param summary - the failure message plus its code.
 * @param disposition - what the failure was allowed to do.
 * @param task - the open attempt that was failed, when there was one.
 * @param settledRecord - the terminal record of the observed task, when it exists.
 * @returns the exact message the captain will read.
 */
export function memberFailureMessage(
  memberName: string,
  summary: string,
  disposition: MemberFailureDisposition,
  task: Pick<TeamTask, 'id' | 'subject'> | undefined,
  settledRecord: Pick<TeamTask, 'id' | 'status' | 'subject'> | undefined,
): string {
  const head = `Member "${memberName}" hit an unrecoverable turn failure: ${summary}.`
  if (disposition === 'failed_attempt' && task !== undefined) {
    return `${head} Task ${task.id} ("${task.subject}") was marked failed; reassign it or retry when ready.`
  }
  if (settledRecord === undefined) {
    return disposition === 'noted_settled'
      ? `${head} No open attempt was owned; no task state was changed.`
      : `${head} No open attempt was owned.`
  }
  // Only a completed record supports a claim about delivered work. A failed or
  // cancelled record is described by its actual closed state.
  return settledRecord.status === 'completed'
    ? `${head} Task ${settledRecord.id} ("${settledRecord.subject}") had already completed; its state and output were left unchanged. This member's last turn died after its work landed.`
    : `${head} Task ${settledRecord.id} ("${settledRecord.subject}") was already closed as ${settledRecord.status}; its record was left unchanged. This member's last turn died after that task had closed.`
}

/** Record a final turn failure, never an intermediate request retry. */
export async function failMemberOpenAttempt(
  ctx: Context,
  stateRoot: string,
  teamId: string,
  memberName: string,
  failure: { readonly code: string; readonly message: string },
  fallbackSession: Session,
  observed: FailedMemberAttempt,
): Promise<boolean> {
  const summary = `${failure.message} (code ${failure.code})`
  const lockKey = `team:${stateRoot}:${teamId}`
  const prepared = await withTeamLock(lockKey, async () => {
    const team = await readTeam(stateRoot, teamId)
    if (team === undefined || team.halted === true || team.captainSessionId !== observed.captainSessionId) return
    const member = team.members.find(candidate => candidate.name === memberName && candidate.id === observed.memberId)
    const task = team.tasks.find(candidate => candidate.assignee === memberName
      && (candidate.status === 'claimed' || candidate.status === 'in_progress'))
    // A reassign, completion, or recreated member may win the lock while the
    // final error is queued. Only the capability observed at that event may fail.
    const disposition = classifyMemberFailure(observed, {
      member,
      task,
      observedRecord: observed.task === undefined
        ? undefined
        : team.tasks.find(candidate => candidate.id === observed.task!.id),
    })
    if (disposition === 'ignored') return
    if (disposition === 'failed_attempt' && task !== undefined) {
      task.status = 'failed'
      task.output = summary
      clearTaskProbe(task)
      task.updatedAt = Date.now()
    }
    if (member !== undefined && ctx.agents.get(brandedSessionId(member.id))?.status !== 'running') member.status = 'idle'
    // Only a terminal record of the observed task may be described, and only a
    // completed one supports a claim about delivered work. Anything else — a
    // never-assigned member, or a record left pending/claimed while the error was
    // queued — gets the plain "no open attempt" wording.
    const settledRecord = disposition === 'noted_settled'
      ? settledTaskRecord(observed.task, team.tasks)
      : undefined
    const message = {
      ...createMessage(memberName, CAPTAIN_KEY, memberFailureMessage(memberName, summary, disposition, task, settledRecord)),
      deliveryClaimedAt: Date.now(),
    }
    if (disposition === 'failed_attempt') await writeTeam(stateRoot, team)
    await appendMailbox(stateRoot, team.id, CAPTAIN_KEY, message)
    if (disposition === 'failed_attempt' && task !== undefined) {
      appendTeamEvent(ctx, captainSessionOf(ctx, team.captainSessionId, fallbackSession), 'agent-teams/task-updated', {
        teamId, taskId: task.id, status: task.status, assignee: memberName, output: task.output,
      })
    }
    appendTeamEvent(ctx, captainSessionOf(ctx, team.captainSessionId, fallbackSession), 'agent-teams/message-sent', {
      teamId: team.id,
      messageId: message.id,
      from: memberName,
      to: CAPTAIN_KEY,
      content: message.content,
      ts: message.ts,
    })
    return { captainSessionId: team.captainSessionId, message }
  })
  if (prepared === undefined) return false
  // Use the same lease/acknowledgment contract as send_message, outside the
  // team lock: steering can synchronously start another agent turn.
  const captain = nearestLiveLead(ctx, { captainSessionId: prepared.captainSessionId })
  const delivered = captain !== undefined && steerCaptainReport(captain, memberName, prepared.message.content, mailboxPrompt(teamId, CAPTAIN_KEY, [prepared.message]))
  await withTeamLock(lockKey, () => delivered
    ? markMailboxDelivered(stateRoot, teamId, CAPTAIN_KEY, [prepared.message.id])
    : releaseMailboxDelivery(stateRoot, teamId, CAPTAIN_KEY, [prepared.message.id]))
  return true
}

async function updateFallbackState(
  stateRoot: string,
  teamId: string,
  memberName: string,
  fallback: { provider: string; model: string },
  ctx: Context,
): Promise<void> {
  await withTeamLock(`team:${stateRoot}:${teamId}`, async () => {
    const team = await readTeam(stateRoot, teamId)
    if (team === undefined) return
    const member = team.members.find(candidate => candidate.name === memberName)
    if (member === undefined) return
    member.activeProvider = fallback.provider
    member.activeModel = fallback.model
    member.fallbackActive = true
    await writeTeam(stateRoot, team)
  })
  void ctx
}

export interface PersistedRouteFailure {
  readonly taskId?: string
  readonly cursor: RouteCursor
  readonly route?: TeamModelFallback
  readonly advanced: boolean
}

/** Apply one durable route to a resident child's live request selection. */
export function applyRouteToSelection(
  ref: { current: ModelSelection; assembled?: ModelSelection },
  route: TeamModelFallback,
): void {
  const next = { provider: route.provider, model: route.model }
  ref.current = next
  ref.assembled = next
}

/**
 * Persist one request failure against the exact activation's task attempt.
 * The activation binding, rather than the current member name, selects the
 * task. Late errors from an old Agent therefore cannot move a newer attempt.
 */
export async function recordPersistedRouteFailure(input: {
  stateRoot: string
  teamId: string
  memberName: string
  activationId: string
  hostRunId?: string
  code: string
}): Promise<PersistedRouteFailure | undefined> {
  return withTeamLock(`team:${input.stateRoot}:${input.teamId}`, async () => {
    const team = await readTeam(input.stateRoot, input.teamId)
    if (team === undefined) return undefined
    const lease = team.activations?.find(candidate => candidate.activationId === input.activationId)
    const member = lease === undefined
      ? team.members.find(candidate => candidate.name === input.memberName && candidate.status !== 'removed')
      : team.members.find(candidate => candidate.id === lease.memberId
        && candidate.generation === lease.memberGeneration
        && candidate.status !== 'removed')
    if (member === undefined) return undefined
    const routes = memberRouteChain(member)
    const task = team.tasks.find(candidate => candidate.attemptActivationId === input.activationId
      && (candidate.status === 'claimed' || candidate.status === 'in_progress'))
    if (task === undefined) return undefined
    const previous = task.attemptRoute
    const cursor = recordRouteFailure(previous, input.code, Math.max(1, routes.length), {
      activationId: input.activationId,
      ...input.hostRunId === undefined ? {} : { hostRunId: input.hostRunId },
    })
    task.attemptRoute = cursor
    task.updatedAt = Date.now()
    const route = routes[cursor.currentRouteIndex]
    if (route !== undefined) {
      if (cursor.currentRouteIndex > 0) {
        member.activeProvider = route.provider
        member.activeModel = route.model
        member.fallbackActive = true
      } else {
        delete member.activeProvider
        delete member.activeModel
        delete member.fallbackActive
      }
    }
    await writeTeam(input.stateRoot, team)
    return {
      taskId: task.id,
      cursor,
      ...route === undefined ? {} : { route },
      advanced: (previous?.currentRouteIndex ?? 0) !== cursor.currentRouteIndex,
    }
  })
}

function pendingSelectionKey(parentSessionId: string, label: string): string {
  return `${parentSessionId}\u0000${label}`
}

function selectionFromMember(member: TeamMember | undefined): MemberLlmSelection | undefined {
  if (member?.provider === undefined || member.model === undefined) return undefined
  const provider = (member.activeProvider ?? member.provider).trim()
  const model = (member.activeModel ?? member.model).trim()
  if (provider === '' || model === '') return undefined
  // Effort ids belong to the original model. After a fallback, its own
  // provider default remains authoritative, including after cold recovery.
  const reasoningEffort = member.fallbackActive === true ? undefined : member.reasoningEffort?.trim()
  return {
    provider,
    model,
    ...reasoningEffort === undefined || reasoningEffort === '' ? {} : { reasoningEffort },
    ...member.fallback === undefined || member.fallbackActive === true ? {} : { fallback: member.fallback },
    ...member.fallbacks === undefined ? {} : { fallbacks: member.fallbacks },
  }
}

function modelSelection(selection: MemberLlmSelection): ModelSelection {
  return {
    provider: selection.provider,
    model: selection.model,
    ...selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) },
  }
}

/**
 * Resolve one member's complete model selection. Ordinary members snapshot the
 * captain's current request route and reasoning effort. When provider or model
 * changes, effort is intentionally omitted so the target model materializes
 * its own default instead of receiving an adapter-owned id from another route.
 * An explicit effort overrides either policy; the sentinel "default" also
 * selects the target model's default. The final effort is validated against
 * the target model before a child is created.
 *
 * A configured `memberModel` is a route preference, not a blind model-id
 * override: it is paired with `memberLlmProvider` (or its own `provider/model`
 * form) when configured, and when only a bare model id is configured it is
 * adopted by the captain's provider only if that provider actually advertises
 * it. Otherwise the catalog decides: exactly one advertising provider wins,
 * none or several produce an actionable error listing them (issue #189). A
 * provider the caller *named* — explicitly or via configuration — is never
 * silently switched away from.
 */
export async function resolveMemberLlmSelection(
  ctx: Context,
  captain: Agent,
  request: MemberLlmSelectionRequest,
  signal?: AbortSignal,
): Promise<MemberLlmSelection> {
  const explicitProvider = request.provider?.trim()
  const explicitModel = request.model?.trim()
  const defaultModel = request.defaultModel?.trim()
  const defaultProvider = request.defaultProvider?.trim()
  const explicitEffort = request.reasoningEffort?.trim()
  const fallback = request.fallback
  const fallbacks = request.fallbacks
  if (fallbacks !== undefined && fallbacks.length > 4) {
    throw new Error('member fallbacks may contain at most 4 routes')
  }
  if (request.provider !== undefined && explicitProvider === '') {
    throw new Error('member LLM provider must not be empty')
  }
  if (request.model !== undefined && explicitModel === '') {
    throw new Error('member model must not be empty')
  }
  if (request.defaultModel !== undefined && defaultModel === '') {
    throw new Error('configured memberModel must not be empty')
  }
  if (request.defaultProvider !== undefined && defaultProvider === '') {
    throw new Error('configured memberLlmProvider must not be empty')
  }
  if (request.reasoningEffort !== undefined && explicitEffort === '') {
    throw new Error('member reasoning effort must not be empty')
  }
  // An explicit provider needs an explicit model; `memberModel` is used
  // verbatim, so a `/` inside a model id is never a provider separator.
  if (explicitProvider !== undefined && explicitModel === undefined) {
    throw new Error('an explicit member LLM provider requires an explicit member model')
  }

  const current = captain.session.requestHeader()?.config
  const currentProvider = current?.provider ?? captain.options.provider
  const currentModel = current?.model ?? captain.options.model
  if (currentProvider === undefined || currentModel === undefined) {
    throw new Error('cannot resolve the member LLM route from the current captain session')
  }
  // The plugin-wide default only applies where the caller did not choose a
  // model. `request.defaultModel` belongs to the plugin configuration; a
  // request-level `model` is a user choice and is never re-routed.
  const composed = composeMemberRoute({
    provider: request.provider,
    model: request.model,
    defaultModel: defaultModel,
    defaultProvider: defaultProvider,
  }, { provider: currentProvider, model: currentModel })
  if (composed === undefined) {
    throw new Error('cannot resolve the member LLM route from the current captain session')
  }
  // Only a bare configured `memberModel` may have its owner resolved from the
  // catalogs. A named provider (explicit or configured) is authoritative — a
  // model it does not advertise is a hard error, never a silent switch — and a
  // model the caller named keeps that caller's route.
  const provider = composed.derivedProvider
    ? await resolveMemberModelOwner(ctx, currentProvider, composed.model.value, signal)
    : composed.provider.value

  // Effort ids belong to one exact provider/model capability. Preserve the
  // captain's effort only on the same route; a changed route must resolve its
  // own default. Explicit effort still wins, while "default" forces that
  // target-default behavior even when the route did not change.
  const model = composed.model.value
  const sameRoute = provider === currentProvider && model === currentModel
  const reasoningEffort = explicitEffort === undefined
    ? sameRoute
      ? current?.reasoningEffort
      : undefined
    : explicitEffort === 'default'
      ? undefined
      : ReasoningEffortId(explicitEffort)
  let resolved: Awaited<ReturnType<typeof ctx.llm.resolveCallConfig>>
  try {
    resolved = await ctx.llm.resolveCallConfig({
      provider,
      model,
      ...reasoningEffort === undefined
        ? {}
        : { reasoningEffort },
    }, signal)
  } catch (error: unknown) {
    throw new Error(describeMemberRouteFailure(provider, model, error), { cause: error })
  }
  return {
    provider: resolved.provider,
    model: resolved.model,
    ...resolved.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: String(resolved.reasoningEffort) },
    ...fallback === undefined ? {} : { fallback },
    ...fallbacks === undefined ? {} : { fallbacks },
  }
}

/**
 * Pick the provider that owns a configured bare model id when the captain's
 * provider does not advertise it. Only an unambiguous owner is accepted: zero
 * advertising providers and several advertising providers both fail with the
 * catalog, because guessing between real providers changes which account and
 * quota the user's members run on (issue #189).
 * @returns the resolved provider id.
 */
async function resolveMemberModelOwner(
  ctx: Context,
  captainProvider: string,
  model: string,
  signal?: AbortSignal,
): Promise<string> {
  // Enumeration is optional: an adapter that cannot list its providers must not
  // turn a resolvable route into a crash. Such a route keeps the captain's
  // provider and lets the durable adapter report the real failure.
  const listProviders = ctx.llm.listProviders
  if (typeof listProviders !== 'function') return captainProvider
  const owners: string[] = []
  for (const provider of listProviders.call(ctx.llm)) {
    if (signal?.aborted === true) throw signal.reason ?? new Error('member model resolution was cancelled')
    const catalog = await ctx.llm.listModels(provider.id)
    if (catalog.length === 0) continue
    if (catalog.some((candidate) => candidate.id === model)) owners.push(provider.id)
  }
  if (owners.includes(captainProvider)) return captainProvider
  if (owners.length === 1) return owners[0]!
  if (owners.length === 0) {
    throw new Error(
      `no configured provider advertises the member model "${model}".`
      + ` The captain's provider "${captainProvider}" does not serve it either.`
      + ' Name the owner explicitly with memberLlmProvider, or pass provider + model to agent_teams_add_member.',
    )
  }
  throw new Error(
    `the member model "${model}" is advertised by ${owners.length} providers (${owners.join(', ')}),`
    + ' so its owner is ambiguous. Name it explicitly with memberLlmProvider, or pass provider + model to agent_teams_add_member.',
  )
}

/** Turn a raw adapter failure into an actionable, route-naming error. */
function describeMemberRouteFailure(provider: string, model: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : ''
  const hint = code === 'UNKNOWN_MODEL' || code === 'NO_ADAPTER' || code === 'INVALID_CONFIG'
    ? ` The member route was composed from the captain's session and the plugin configuration;`
      + ' set memberLlmProvider when the configured member model belongs to a'
      + " different provider than the captain's session."
    : ''
  return `cannot use the member LLM route "${provider}/${model}": ${message}${code === '' ? '' : ` (code ${code})`}.${hint}`
}

/**
 * Install the member selection bridge for every fresh or cold-resumed
 * continuable child. Fresh creation reads the pending in-memory selection;
 * cold resume restores the same selection from the owning team's durable
 * record. Legacy members without a complete saved route retain Harness's
 * descriptor provider/model behavior.
 */
export function installMemberSelectionRuntime(
  ctx: Context,
  stateDir: string,
  onFailureSettled?: (workspace: string, teamId: string, memberName: string) => Promise<void>,
): MemberSelectionRuntime {
  const managedHost = usesManagedActivations(ctx.subagents)
  const pending = new Map<string, MemberLlmSelection>()
  const pendingSetup = new Map<string, NonNullable<TeamMember['runtimeSetup']>>()
  installContinuableMemberSetup(ctx, (childCtx, child) => {
    const descriptor = foldSubagentDescriptor(sessionOwnEvents(child.session))
    if (descriptor?.mode !== 'continuable' || !descriptor.label.startsWith(MEMBER_LABEL_PREFIX)) {
      return () => undefined
    }

    const parentSessionId = child.session.header.parentSession
    if (parentSessionId === undefined) return () => undefined
    const identity = descriptor.label.slice(MEMBER_LABEL_PREFIX.length)
    const separator = identity.indexOf(':')
    if (separator < 1 || separator === identity.length - 1) return () => undefined
    const teamId = identity.slice(0, separator)
    const memberName = identity.slice(separator + 1)
    const workspace = child.session.header.cwd ?? process.cwd()
    const stateRoot = join(workspace, stateDir)
    const key = pendingSelectionKey(parentSessionId, descriptor.label)
    // Internal settlement wakeups bypass the public delivery guard. Recheck
    // exact durable membership on every proposed step, including cold resume.
    const disposeAdmission = childCtx.on('agent/pre-step', async (payload, next) => {
      if (payload.agent.id !== child.id) return next()
      const admitted = await withTeamLock(`team:${stateRoot}:${teamId}`, async () => {
        const team = await readTeam(stateRoot, teamId)
        return team?.captainSessionId === parentSessionId && team.phase !== 'staged' && team.halted !== true
          && team.members.some(member => member.id === child.id && member.name === memberName && member.status !== 'removed' && member.stopping !== true)
          && !team.tasks.some(task => task.reassigning === true && task.assignee === memberName)
      })
      if (!admitted) return { kind: 'reject' }
      return next()
    })
    // New activations no longer persist persona/toolFilter in host descriptors.
    // Install them before the first request, and restore the exact saved values
    // after a cold resume. Historical descriptors remain owned by Harness.
    const savedTeam = pending.has(key) ? undefined : readTeamSync(stateRoot, teamId)
    const savedMember = savedTeam?.captainSessionId === parentSessionId
      ? savedTeam.members.find(member => member.id === child.id && member.name === memberName)
      : undefined
    const setup = pendingSetup.get(key) ?? savedMember?.runtimeSetup
    if (usesManagedActivations(ctx.subagents) && savedMember !== undefined
      && setup === undefined && descriptor.toolFilter === undefined) {
      disposeAdmission()
      throw new Error('agent-teams: saved member runtime setup is missing; refusing an unrestricted resume')
    }
    let disposeSetup = (): void => undefined
    if (usesManagedActivations(ctx.subagents) && setup !== undefined) {
      try {
        const stopFilter = childCtx.tools.restrict(setup.toolFilter)
        try {
          const stopPersona = childCtx.systemPrompt.section({
            name: 'deployment:persona-prefix',
            order: childCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
            text: setup.persona,
          })
          disposeSetup = () => { stopPersona(); stopFilter() }
        } catch (error) { stopFilter(); throw error }
      } catch (error) { disposeAdmission(); throw error }
    }
    const cleanupAdmission = (): void => { disposeSetup(); disposeAdmission() }
    let selection = pending.get(key)
    if (selection === undefined) {
      const team = readTeamSync(stateRoot, teamId)
      if (team?.captainSessionId !== parentSessionId) return cleanupAdmission
      const durableMember = team.members.find(member => member.name === memberName)
      selection = selectionFromMember(durableMember)
      if (selection !== undefined && (descriptor.agentProvider !== durableMember?.provider || descriptor.agentModel !== durableMember?.model)) {
        throw new Error(
          `agent-teams: saved model route for member "${memberName}" does not match its subagent descriptor`,
        )
      }
    }

    let lastFailedTurn: number | undefined
    // Harness emits agent/error only after request recovery is exhausted. In
    // particular, llm-retry's "always" policy calls downstream request-error
    // listeners before it retries; that waterfall cannot declare a turn dead.
    const disposeFailure = childCtx.on('agent/error', async (payload) => {
      if (payload.agent.id !== child.id || payload.turn === lastFailedTurn) return
      lastFailedTurn = payload.turn
      if (recordBoundAgentDiagnostic(payload.agent, payload.error instanceof Error ? payload.error.message : String(payload.error))) {
        // stopReason remains the only settlement authority. A request/turn
        // error is diagnostic evidence for the exact managed run.
        return
      }
      if (managedHost) {
        // A managed activation without its exact Agent binding is stale. It
        // must not fall through to the member-name legacy failure path.
        ctx.logger.warn(`agent-teams: ignored unbound managed agent/error for ${child.id}`)
        return
      }
      try {
        // Capture the attempt synchronously at the event, before any lock wait
        // can let a captain reassign it or replace the member/team generation.
        const snapshot = readTeamSync(stateRoot, teamId)
        if (snapshot?.captainSessionId !== parentSessionId) return
        const member = snapshot.members.find(item => item.id === child.id && item.name === memberName && item.status !== 'removed')
        if (member === undefined) return
        const task = snapshot.tasks.find(item => item.assignee === memberName
          && (item.status === 'claimed' || item.status === 'in_progress'))
        const failure = payload.error instanceof LlmError ? payload.error.failure : {
          code: 'UNKNOWN',
          message: payload.error instanceof Error ? payload.error.message : String(payload.error),
        }
        const recorded = await failMemberOpenAttempt(ctx, stateRoot, teamId, memberName, failure, child.session, {
          captainSessionId: parentSessionId, memberId: child.id, task,
        })
        if (!recorded) return
        // The final-error event precedes driver quiescence. Observe the real
        // lifecycle and kick explicitly even if its idle event was missed.
        // Never force an active Agent's status to idle or retry the failed task.
        await child.whenIdle()
        await withTeamLock(`team:${stateRoot}:${teamId}`, async () => {
          const team = await readTeam(stateRoot, teamId)
          const current = team?.members.find(item => item.id === child.id && item.name === memberName && item.status !== 'removed')
          if (team?.captainSessionId !== parentSessionId || current === undefined || child.status !== 'idle') return
          if (current.status !== 'idle') {
            current.status = 'idle'
            await writeTeam(stateRoot, team)
          }
        })
        await onFailureSettled?.(workspace, teamId, memberName)
      } catch (error: unknown) {
        ctx.logger.warn(`agent-teams: failed to record member turn failure: ${String(error)}`)
      }
    })
    // Legacy teams still need failure reporting even without a saved route.
    if (selection === undefined) return () => { disposeFailure(); cleanupAdmission() }
    const selectionRef = { current: modelSelection(selection), assembled: undefined as ModelSelection | undefined }
    const disposeSelection = installModelSelection(childCtx, selectionRef)
    const fallback = selection.fallback
    let switched = false
    const disposeFallback = childCtx.on('agent/request-error', async (payload, next) => {
      if (payload.agent.id !== child.id || payload.signal.aborted) return next()
      const binding = boundAgentRun(payload.agent)
      if (recordBoundAgentDiagnostic(payload.agent, `${payload.failure.code}: ${payload.failure.message}`)) {
        if (binding !== undefined) {
          const routeFailure = await recordPersistedRouteFailure({
            stateRoot, teamId, memberName,
            activationId: binding.activationId,
            hostRunId: binding.hostRunId,
            code: payload.failure.code,
          }).catch(error => {
            ctx.logger.warn(`agent-teams: failed to persist route failure for ${child.id}: ${String(error)}`)
            return undefined
          })
          if (routeFailure?.route !== undefined) {
            // Keep the resident child's next request on the durable route.
            // Cold resumes already derive this from member.activeProvider;
            // this is the live-child counterpart for the *next* activation.
            applyRouteToSelection(selectionRef, routeFailure.route)
          }
        }
        // A route-owned AgentTeams activation records the failure and returns
        // undefined, deliberately suppressing the host retry policy. The exact
        // subagent/end then moves the durable route/task state.
        return undefined
      }
      if (managedHost) {
        ctx.logger.warn(`agent-teams: ignored unbound managed agent/request-error for ${child.id}`)
        return undefined
      }
      const transition = selectFallbackRoute(selectionRef.current ?? { provider: selection.provider, model: selection.model }, fallback, payload.failure.code, switched)
      // selectFallbackRoute only retries when a fallback route exists; the
      // explicit guard narrows that fact for the compiler.
      if (fallback !== undefined && transition.retry) {
        switched = transition.switched
        selectionRef.current = transition.selection
        // Request recovery repeats buildRequest inside the current step; it
        // does not re-run prompt assembly. Override that captured route too,
        // otherwise the authorized retry would hit the failed primary again.
        selectionRef.assembled = transition.selection
        await updateFallbackState(stateRoot, teamId, memberName, fallback, ctx).catch((error: unknown) => {
          ctx.logger.warn(`agent-teams: failed to persist fallback route: ${String(error)}`)
        })
        ctx.logger.warn(`agent-teams: member ${child.id} switching to fallback ${fallback.provider}/${fallback.model} after ${payload.failure.code}`)
        return { kind: 'retry' as const }
      }
      return next()
    })
    return () => {
      disposeFallback()
      disposeSelection()
      disposeFailure()
      cleanupAdmission()
    }
  })

  return {
    isPendingMember(agent) {
      const parent = agent.session.header.parentSession
      const descriptor = foldSubagentDescriptor(sessionOwnEvents(agent.session))
      return parent !== undefined && descriptor?.mode === 'continuable'
        && pending.has(pendingSelectionKey(parent, descriptor.label))
    },
    async withPending<T>(
      parentSessionId: string,
      label: string,
      selection: MemberLlmSelection,
      operation: () => Promise<T>,
      setup?: TeamMember['runtimeSetup'],
    ): Promise<T> {
      const key = pendingSelectionKey(parentSessionId, label)
      if (pending.has(key)) {
        throw new Error(`member model selection is already pending for "${label}"`)
      }
      pending.set(key, selection)
      if (setup !== undefined) pendingSetup.set(key, setup)
      try {
        return await operation()
      } finally {
        pending.delete(key)
        pendingSetup.delete(key)
      }
    },
  }
}

function configuredExecutionPrompt(member: TeamMember, config: MemberRuntimeConfig): string | undefined {
  const prompt = member.executionPrompt?.trim() || config.executionPrompt?.trim()
  return prompt === undefined || prompt === '' ? undefined : prompt
}

function truncatedPersonaProtocol(protocol: string | undefined): string {
  if (protocol === undefined || protocol.trim() === '') return '(none)'
  if (protocol.length <= PERSONA_PROTOCOL_MAX_CHARS) return protocol
  return `${protocol.slice(0, PERSONA_PROTOCOL_MAX_CHARS)}… [truncated]`
}

function assignedNonTerminalCount(team: TeamState, memberName: string): number {
  return team.tasks.filter(task => (
    task.assignee === memberName && !TERMINAL_TASK_STATUSES.includes(task.status)
  )).length
}

/**
 * The member's system prompt (persona), shadowing the deployment persona for
 * that child. Self-contained: it replaces the whole persona section.
 * Frozen at spawn: draft must already carry the Team goal and profile protocol.
 * @param team - the team the member joined.
 * @param member - the member record (name/role are read before spawning).
 * @param stateDir - configured state directory, so the member can locate the
 *   team files with its own file tools.
 */
export function memberPersona(
  team: TeamState,
  member: TeamMember,
  stateDir: string,
  executionPrompt?: string,
  parallelToolCalls = false,
  skillPrompt?: string,
): string {
  const goal = team.description?.trim() || '(not provided)'
  const injectedPrompt = member.executionPrompt?.trim() || executionPrompt?.trim()
  const protocol = truncatedPersonaProtocol(team.profile?.protocol)
  return `You are ${member.name}, a member of the multi-agent team "${team.name}" running inside DeepSeek Harness AgentTeams. The captain leads the team; you are a worker member${member.role ? ` with the role: ${member.role}` : ''}.

Team context:
- Team id: ${team.id}
- Your name inside the team (use it as \`from\`/identity): ${member.name}
- Team goal: ${goal}
- Profile protocol: ${protocol}
${injectedPrompt === undefined || injectedPrompt === '' ? '' : `- Execution guidance:
${injectedPrompt}
`}${skillPrompt === undefined || skillPrompt.trim() === '' ? '' : `- Selected owner-declared skills (apply once; do not request raw skill bundles from the captain):
${skillPrompt.trim()}
`}- The team state lives under ${stateDir}/${team.id}/ (team.json and inbox/*.jsonl). You may inspect these files read-only for diagnostics, but never edit them directly; use the agent_teams_* tools so JSON escaping and concurrent updates stay safe.
- The captain and your teammates reach you through messages. Coordination arrives at your nearest model step. Apply it to your current attempt; a task assignment starts a separate turn.
When you receive a task, treat the assignment prompt's dependency results as source material. Do not ignore them.

Working rules:
1. When you receive a task assignment, call agent_teams_claim_task with the task id. Keep the returned attempt_id: include it in every agent_teams_update_task call for that execution attempt. Then mark the task in_progress.
2. Work thoroughly with your available tools; do not cut corners.
3. When finishing a task:
   - use status=completed only when the task's success criteria are satisfied;
   - use status=failed when blocking findings or validation failures mean downstream work must not proceed;
   - include a concise output in either case;
   - a stale-attempt rejection means the captain reassigned or took over the task; stop touching that task and wait for new work.
   claimed cannot jump to completed. Mark in_progress first, then completed or failed.
   Include attempt_id on every update. Then report once as described below and become idle.
4. Send one short report with agent_teams_send_message (to=captain) when you complete a task or hit a blocker. Include source_task_id and source_attempt_id in task reports; a stale source rejection means stop, never relabel an old result with a new attempt. The captain is also your parent: this single message satisfies both reporting duties. Do not repeat it through the native send_message tool or send acknowledgments that add no new information.
5. To ask a teammate something, use agent_teams_send_message with to=<teammate name>; the message lands in their mailbox and wakes them directly — teammates talk to each other without the captain in the loop. The same applies to the captain (to=captain).
6. After your turn becomes idle, the shared task scheduler may assign your next ready task automatically. Never claim a second task while you still own unfinished work.
7. If you already own an open attempt (claimed or in_progress) and receive mail, treat it as guidance for that same attempt_id unless the mail explicitly tells you to stop or fail. Do not claim a new task in that turn.
8. Do not start a teammate's assigned task. Do not privately tell the next-stage member to start; the scheduler assigns unlocked work after you become idle.
9. You are a worker: do not create or delete teams, reassign tasks, or add/remove members — that is the captain's job.
10. Quality-gate kinds carry a contract (kind, objective, inScope, acceptance, verify). Stay inside inScope. Do not mark your own implementation as review pass. Review/requirements complete only with verdict=pass; needs_revision/reject must fail with findings. Mail is not a formal next review. Completed work must not be repeated to attach late evidence: call update_task on the original task with its attempt_id and acceptanceResults/commandsRun/evidence_note; supplements are append-only and cannot change its verdict.${parallelToolCalls ? `
11. Parallel Emission is enabled: you may emit several AgentTeams tool calls in one assistant response. Exclusive tools still execute in order; dependency ids must already exist, and do not assume a forward reference created later in the same response is valid.` : ''}`
}

/**
 * The initial user message delivered when the member is created.
 * Counts non-terminal tasks already assigned to this member on the in-memory draft.
 * @param team - the team the member joined.
 * @param memberName - canonical member name used to count assigned pending work.
 */
export function memberWelcome(team: TeamState, memberName: string): string {
  const assigned = assignedNonTerminalCount(team, memberName)
  return `You have joined the team "${team.name}" as a member. Wait for an automatic assignment or a captain message.
Current team status: ${team.tasks.length} task(s), ${assigned} pending task(s) assigned to you.
Do not start work until the scheduler or captain assigns a task in this turn.`
}

/**
 * Spawn one member as a durable continuable subagent of the captain and fill
 * `member.id` with its child session id. On failure nothing is persisted.
 * @param ctx - the plugin context (injects `subagents`).
 * @param config - member runtime knobs.
 * @param selections - fresh/cold child model-selection bridge.
 * @param llmSelection - resolved provider/model/reasoning snapshot.
 * @param captain - the exact live captain agent (the calling agent).
 * @param team - the team record (read-only here).
 * @param member - the member draft whose `id` is filled on success.
 * @param stateDir - configured state directory (for the persona).
 * @param signal - caller cancellation, forwarded to the start.
 * @param initialPrompt - first turn text; the welcome message when omitted.
 * @param resolvedFilter - the member's effective tool filter (a selected
 *   policy, or the legacy captain-only filter when the member has none). The
 *   caller resolves it so `spawnMember` forwards exactly one immutable filter
 *   to `startContinuable`.
 * @param relaxableDeny - deny names the lenient retry may drop for this
 *   member; the caller narrows it for a policy member so a name the owner
 *   declared is never silently removed.
 */
export async function spawnMember(
  ctx: Context,
  config: MemberRuntimeConfig,
  selections: MemberSelectionRuntime,
  llmSelection: MemberLlmSelection,
  captain: Agent,
  team: TeamState,
  member: TeamMember,
  stateDir: string,
  signal: AbortSignal,
  initialPrompt?: string,
  resolvedFilter?: MemberToolFilter,
  relaxableDeny?: readonly string[],
): Promise<MemberStartResult> {
  // Fail loud at the first use: provider registration is a sibling plugin's
  // effect and may settle after this plugin mounts. Capability checks here
  // mirror what startContinuable would reject, with an actionable error.
  const provider = ctx.subagents.getProvider(config.provider)
  if (provider === undefined) {
    throw new Error(
      `agent-teams: no subagent provider "${config.provider}" is registered (available: ${ctx.subagents.list().join(', ') || 'none'}) — `
      + 'check that the subagent provider row (e.g. subagent-spawn) is mounted in the composition',
    )
  }
  if (provider.prepareContinuable === undefined) {
    throw new Error(`agent-teams: provider "${config.provider}" does not support continuable members`)
  }
  const legacyCapabilities = provider.capabilities as unknown as { persona?: boolean; toolFilter?: boolean }
  if (!usesManagedActivations(ctx.subagents) && !legacyCapabilities.persona) {
    throw new Error(`agent-teams: provider "${config.provider}" cannot apply a member persona`)
  }
  if (!usesManagedActivations(ctx.subagents) && !legacyCapabilities.toolFilter) {
    throw new Error(`agent-teams: provider "${config.provider}" cannot restrict captain-only tools for members`)
  }
  const label = `${MEMBER_LABEL_PREFIX}${team.id}:${member.name}`
  let lane: import('./types.ts').WorktreeLane | undefined
  if (config.worktrees?.enabled === true) {
    if (config.worktrees.root === undefined || config.worktrees.root.trim() === '') {
      throw new Error('agent-teams: worktrees.root is required when worktree isolation is enabled')
    }
    if (member.worktreeLaneId === undefined) {
      lane = await createWorktreeLane({
        teamId: team.id,
        memberId: member.id || member.name,
        workspace: captain.session.header.cwd ?? process.cwd(),
        root: config.worktrees.root,
        baseRef: config.worktrees.baseRef,
      })
      member.worktreeLaneId = lane.laneId
      team.worktreeLanes = [...(team.worktreeLanes ?? []), lane]
    } else {
      lane = team.worktreeLanes?.find(candidate => candidate.laneId === member.worktreeLaneId && candidate.state !== 'cleaned')
      if (lane === undefined) throw new Error(`agent-teams: member "${member.name}" references a missing worktree lane`)
    }
    for (const task of team.tasks) {
      if (task.assignee !== member.name) continue
      if (task.worktreeLaneId !== undefined && task.worktreeLaneId !== lane.laneId) {
        throw new Error(`agent-teams: task "${task.id}" is bound to another member lane`)
      }
      task.worktreeLaneId = lane.laneId
      task.workspace = { kind: 'member_lane', laneId: lane.laneId, worktreePath: lane.worktreePath, branch: lane.branch, baseRef: lane.baseRef }
    }
  } else if (member.worktreeLaneId !== undefined || team.tasks.some(task => task.assignee === member.name && task.worktreeLaneId !== undefined)) {
    throw new Error('agent-teams: this team has worktree-bound tasks but worktree isolation is disabled')
  }
  // The legacy filter of a member without a configured tool policy: the
  // captain-only deny list plus the depth entries this host registers.
  const requestedFilter = resolvedFilter ?? memberToolFilter(config.maxDepth, restrictableToolNames(captain))
  // Owner skills are resolved from ids before any child starts. A cold
  // pre-spawn resume must still see the exact prompt hash frozen in team.json;
  // a changed owner catalog fails loud instead of silently rewriting persona.
  const resolvedSkills = resolveMemberSkills(config.skills ?? {}, member.skills, member.toolPolicy)
  if (member.skillPromptSha256 !== undefined && member.skillPromptSha256 !== resolvedSkills.sha256) {
    throw new Error(`agent-teams: owner skill prompt for member "${member.name}" no longer matches its persisted hash`)
  }
  // The lenient retry may drop names this host reports unknown; keep the exact
  // filter the host accepted for the durable member setup.
  let acceptedFilter = requestedFilter
  const start = await startMemberWithLenientFilter(
    toolFilter => {
      acceptedFilter = toolFilter
      const setup = { persona: memberPersona(team, member, stateDir, config.executionPrompt, config.parallelToolCalls, resolvedSkills.prompt), toolFilter }
      return selections.withPending(captain.id, label, llmSelection, () => startMember(ctx.subagents, {
        provider: config.provider,
        label,
        ...(member.id === '' ? {} : { childId: member.id as import('@deepseek-ai/dsh-session').SessionId }),
        request: {
          prompt: [{ type: 'text', text: initialPrompt ?? memberWelcome(team, member.name) }],
          parent: captain,
          ...lane === undefined ? {} : { cwd: lane.worktreePath },
          persona: memberPersona(team, member, stateDir, config.executionPrompt, config.parallelToolCalls, resolvedSkills.prompt),
          // Depth deny entries name host tools; resolve them against the
          // running host's registry so a renamed delegation tool cannot abort
          // the spawn (see memberToolFilter). Depth is still enforced by the
          // parent-chain guard installed at plugin mount. A filter the host
          // still rejects is retried without the names it reported.
          toolFilter,
          agentOptions: {
            provider: llmSelection.provider,
            model: llmSelection.model,
            ...llmSelection.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: ReasoningEffortId(llmSelection.reasoningEffort) },
          },
          // Harness request.maxDepth caps the absolute depth of THIS creation;
          // it is not inherited by later delegations. The guard below enforces
          // the configured member-relative descendant budget instead.
        },
        signal,
      }), setup)
    },
    requestedFilter,
    relaxableDeny,
  )
  if (member.id !== '' && member.id !== start.childId) {
    throw new Error(`agent-teams: reserved child id ${member.id} does not match activation ${start.childId}`)
  }
  member.id = start.childId
  if (usesManagedActivations(ctx.subagents)) {
    member.runtimeSetup = { persona: memberPersona(team, member, stateDir, config.executionPrompt, config.parallelToolCalls, resolvedSkills.prompt), toolFilter: acceptedFilter }
  }
  // Only a policy member carries a persisted filter snapshot; a member without
  // a policy keeps its public record shape. Legacy descriptors or runtimeSetup
  // restore the filter on cold resume, depending on the host generation.
  if (member.toolFilter !== undefined) member.toolFilter = { ...acceptedFilter }
  return start
}

/**
 * Deliver one message to a member as its next FIFO turn. Best effort: a
 * failure (member gone or not continuable) is logged and reported as `false`
 * so the caller can decide (mailbox delivery still happened).
 *
 * Any team sender can route through this helper: the captain is the direct
 * parent of every member, and the caller passes the captain's live Agent
 * (its own when the captain calls, the registry-resolved one when a member
 * sends) — mirroring the Claude Code mailbox model where the writer writes
 * the target's inbox and the target picks it up on its own.
 * @param ctx - the plugin context (injects `subagents`).
 * @param captain - the exact live captain agent (the member's direct parent).
 * @param childId - the member's durable child session id.
 * @param text - the message content.
 * @param signal - caller cancellation, forwarded to the delivery.
 * @returns whether the member inbox accepted the message.
 */
export async function deliverToMember(
  ctx: Context,
  captain: Agent,
  childId: string,
  text: string,
  signal: AbortSignal,
  mode: 'queue' | 'steer' = 'queue',
): Promise<boolean> {
  try {
    const content = [{ type: 'text' as const, text }]
    if (mode === 'steer') await steerMemberPrompt(ctx.subagents, captain, brandedSessionId(childId), content, signal, ctx.agents.get(brandedSessionId(childId)))
    else await queueMemberPrompt(ctx.subagents, captain, brandedSessionId(childId), content, signal)
    return true
  } catch (error: unknown) {
    ctx.logger.warn(`agent-teams: prompt delivery to member ${childId} failed: ${String(error)}`)
    return false
  }
}

/**
 * Request cancellation of one live member's current turn. Best effort, fire
 * and return; the target may keep running until it observes the signal.
 * @param ctx - the plugin context (injects `subagents`).
 * @param captain - the exact live captain agent (the member's parent).
 * @param childId - the member's durable child session id.
 */
export function interruptMember(ctx: Context, captain: Agent, childId: string): void {
  try {
    ctx.subagents.interrupt(brandedSessionId(childId), { kind: 'ancestor', agent: captain })
  } catch (error: unknown) {
    ctx.logger.warn(`agent-teams: interrupt of member ${childId} failed: ${String(error)}`)
  }
}

/**
 * Install the missing per-child retirement boundary above Harness rc.6.
 *
 * Upstream `interrupt()` deliberately preserves continuable sessions and the
 * upstream seam exposes no targeted forget/retire method. The durable
 * AgentTeams index therefore rejects every inbox delivery before it can cold-resume a
 * retired member. Catalog rows deliberately remain discoverable: Harness rc.8
 * uses the direct-child catalog to authorize historical transcript reads and
 * `openSubagent()`, so filtering those rows would make an archived member's
 * persisted conversation inaccessible. Exact ids keep unrelated subagents
 * untouched while the delivery boundary still prevents further model turns.
 */
export function installRetiredMemberGuard(ctx: Context, stateDir: string): void {
  guardSubagentDelivery(ctx, async (parent, childId) => {
    const retired = await readRetiredMemberIds(join(parent.session.header.cwd ?? process.cwd(), stateDir))
    return retired.has(childId)
  })
}

/** Bound all descendant creation, including renamed tools and code-runtime calls. */
export function installMemberDelegationGuard(ctx: Context, stateDir: string, maxDepth: number): void {
  let active = true
  const check = (parent: Agent): void => {
    if (!active) return
    let ancestor: Agent | undefined = parent
    let depth = 1
    while (ancestor !== undefined) {
      const descriptor = foldSubagentDescriptor(sessionOwnEvents(ancestor.session))
      if (descriptor?.label?.startsWith(MEMBER_LABEL_PREFIX)) {
        const identity = descriptor.label.slice(MEMBER_LABEL_PREFIX.length)
        const separator = identity.indexOf(':')
        let team: ReturnType<typeof readTeamSync>
        try {
          team = readTeamSync(join(ancestor.session.header.cwd ?? process.cwd(), stateDir), identity.slice(0, separator))
        } catch (error: unknown) {
          // Distinguish "team state unreadable" (e.g. a corrupt team.json) from
          // the guarded rejections below: reject with an actionable message
          // instead of leaking the raw parse error through subagents.start.
          throw new Error(`AgentTeams delegation guard could not read the team state of "${identity.slice(0, separator)}" (its team.json may be corrupt or unreadable): ${String(error)}`)
        }
        const member = team?.members.find(item => item.id === ancestor!.id && item.name === identity.slice(separator + 1))
        if (member === undefined || member.status === 'removed' || member.stopping === true || team?.halted === true) throw new Error('AgentTeams member is no longer admitting delegated work')
        if (depth > maxDepth) throw new Error(`AgentTeams member delegation limit (${maxDepth}) reached; report to the captain instead of spawning another agent`)
        return
      }
      const parentId: SessionId | undefined = ancestor.session.header.parentSession
      ancestor = parentId === undefined ? undefined : ctx.agents.get(parentId)
      depth++
    }
  }
  guardSubagentCreation(ctx, check)
  ctx.effect(() => () => { active = false }, 'agent-teams: delegation guard lifetime')
}

/**
 * Snapshot the real driver activity for durable member ids.
 *
 * The team record is the membership authority, so this path intentionally no
 * longer depends on `listChildren()`'s versioned projection shape. Harness
 * rc.8 changed those rows to branded `SessionId` values plus residency-only
 * `activity`; neither is needed to answer whether the live Agent driver is
 * running, idle, or absent/ready.
 * @param ctx - the plugin context (injects `agents`).
 * @param memberIds - child ids restored from the durable team record.
 * @returns child id → live activity.
 */
export function memberActivity(
  ctx: Context,
  memberIds: readonly string[],
): Map<string, 'running' | 'idle' | 'ready'> {
  const activity = new Map<string, 'running' | 'idle' | 'ready'>()
  for (const id of memberIds) {
    if (id === '') continue
    const live = ctx.agents.get(brandedSessionId(id))
    activity.set(id, live === undefined ? 'ready' : live.status)
  }
  return activity
}
