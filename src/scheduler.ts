/**
 * Event-driven shared task scheduler.
 *
 * Claude Code teammates keep polling the shared task list after a turn. DSH
 * continuable agents instead expose explicit idle/running edges, so this
 * scheduler closes the same loop without keeping a polling turn alive: every
 * idle edge and every task-graph mutation attempts one atomic claim and wakes
 * the selected durable member. A resident member that becomes idle while it
 * still owns an open attempt is parked: only an explicit captain reassignment
 * may rotate that capability. Automatic retry is reserved for cold recovery,
 * when this process has not observed the durable owner settle its open attempt.
 * @module dsh-agent-teams/scheduler
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SubagentRunEndInfo, SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { deliverToMember, steerCaptainReport } from './members.ts'
import { bindAgentRun, boundAgentRun, unbindAgentRun, usesManagedActivations, type MemberStartResult } from './harness-compat.ts'
import { isCurrentMail, mailboxPrompt } from './mailbox.ts'
import {
  markMailboxDelivered,
  discardMailboxMessages,
  appendMailboxOnce,
  beginTaskAttempt,
  CAPTAIN_KEY,
  createMessage,
  claimMailboxDelivery,
  clearTaskActivation,
  findTeamByParticipant,
  invalidateTaskAttempt,
  readTeam,
  readPendingMailbox,
  releaseMailboxDelivery,
  unsatisfiedDependencies,
  withTeamLock,
  writeTeam,
} from './state.ts'
import { contractStaleness, isVerdictKind, taskKindOf, verdictScopePatterns } from './quality-gates.ts'
import { digestWorkspacePaths, snapshotWorkspacePaths } from './artifacts.ts'
import type { ActivationLease, ActivationStopReason, NotificationLedgerEntry, TaskParking, TeamMember, TeamState, TeamTask } from './types.ts'

/** Per-dependency output cap in the assignment prompt. */
export const DEPENDENCY_OUTPUT_MAX_CHARS = 2_000
/** Combined dependency-output budget in the assignment prompt. */
export const DEPENDENCY_OUTPUTS_TOTAL_MAX_CHARS = 12_000

export interface DispatchRequest {
  readonly attemptId?: string
  readonly activationId?: string
  readonly dispatchToken?: string
  readonly newChild: boolean
  readonly reservedChildId: string
}

export interface DispatchResult {
  readonly accepted: boolean
  readonly receipt?: MemberStartResult
}

export type MailboxActivationDecision = 'allocate' | 'reuse' | 'wait'

/** Decide whether a mailbox wake may start a new run for this child. */
export function mailboxActivationDecision(
  leases: readonly ActivationLease[],
  memberId: string,
  liveRunning: boolean,
): MailboxActivationDecision {
  const active = leases.find(lease => lease.memberId === memberId
    && (lease.state === 'pending' || lease.state === 'started' || lease.state === 'recovering'))
  if (active === undefined) return 'allocate'
  return active.state === 'started' && liveRunning ? 'reuse' : 'wait'
}

export interface SchedulerConfig {
  readonly stateDir: string
  readonly executionPrompt?: string
  /** Global cap on active activation permits; undefined preserves legacy unbounded scheduling. */
  readonly maxConcurrentWorkers?: number
  readonly dispatch?: (
    captain: Agent,
    teamId: string,
    memberName: string,
    text: string,
    signal: AbortSignal,
    mode: 'queue' | 'steer',
    request?: DispatchRequest,
  ) => Promise<boolean | DispatchResult>
}

/** Count permits that still pin a managed activation. */
export function activePermitCount(leases: readonly Pick<ActivationLease, 'permitHeld'>[]): number {
  return leases.reduce((count, lease) => count + (lease.permitHeld === true ? 1 : 0), 0)
}

/** Whether one more activation may acquire a global permit. */
export function canAcquireActivationPermit(
  leases: readonly Pick<ActivationLease, 'permitHeld'>[],
  maxConcurrentWorkers: number | undefined,
): boolean {
  if (maxConcurrentWorkers === undefined) return true
  return activePermitCount(leases) < Math.max(1, Math.floor(maxConcurrentWorkers))
}

export interface TeamScheduler {
  /** Try to give every genuinely idle/ready member one unit of ready work. */
  kickTeam(workspace: string, teamId: string, captain?: Agent): Promise<void>
  /** Try to flush fallback mail or give one member one ready task. */
  kickMember(workspace: string, teamId: string, memberName: string, captain?: Agent): Promise<void>
}

/** One completed recursive dependency shown to the assignee. */
export interface DependencyOutput {
  readonly id: string
  readonly subject: string
  readonly profileSeedId?: string
  readonly output?: string
}

export interface DispatchTicket {
  readonly taskId: string
  readonly memberName: string
  readonly memberId: string
  readonly attempt: number
  readonly attemptId: string
  readonly activationId: string
  readonly dispatchToken: string
  readonly newChild: boolean
  readonly preDispatchSessionSeq: number
  readonly previousAssignee?: string
  /** True when this ticket rotates an unobserved durable open attempt. */
  readonly recoveredOwned: boolean
  /** Original task generation, used to restore a failed automatic recovery. */
  readonly previousStatus?: 'claimed' | 'in_progress'
  readonly previousAttempt?: number
  readonly previousAttemptId?: string
  readonly previousResult?: Pick<TeamTask, 'output' | 'verdict' | 'findings' | 'changedPaths' | 'acceptanceResults' | 'commandsRun'>
  readonly subject: string
  readonly description?: string
  readonly teamDescription?: string
  readonly profileProtocol?: string
  readonly profileSeedId?: string
  readonly dependencyOutputs: readonly DependencyOutput[]
  readonly executionPrompt?: string
  readonly kind?: string
  readonly round?: number
  readonly objective?: string
  readonly inScope?: readonly string[]
  readonly outOfScope?: readonly string[]
  readonly acceptance?: readonly string[]
  readonly verify?: readonly string[]
  readonly reviewedTaskId?: string
  readonly findingSourceTaskIds?: readonly string[]
}

function taskProfileSeedId(task: TeamTask): string | undefined {
  const seed = task.profileSeedId?.trim()
  return seed === undefined || seed === '' ? undefined : seed
}

function teamProfileProtocol(team: TeamState): string | undefined {
  return team.profile?.protocol
}

/**
 * Recursively collect `status=completed` ancestors of `taskId` in topological
 * order (dependencies before dependents). Cycles stop that branch only.
 */
export function collectCompletedDependencyOutputs(
  tasks: readonly TeamTask[],
  taskId: string,
  warn?: (message: string) => void,
): DependencyOutput[] {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const ordered: TeamTask[] = []

  const walk = (id: string): void => {
    if (visiting.has(id)) {
      warn?.(`agent-teams: dependency cycle involving "${id}" while collecting outputs; stopping this branch`)
      return
    }
    if (visited.has(id)) return
    visiting.add(id)
    const task = byId.get(id)
    if (task !== undefined) {
      for (const dependency of task.dependencies) walk(dependency)
      if (id !== taskId) ordered.push(task)
    }
    visiting.delete(id)
    visited.add(id)
  }

  walk(taskId)
  return ordered
    .filter(task => task.status === 'completed')
    .map((task) => {
      const profileSeedId = taskProfileSeedId(task)
      return {
        id: task.id,
        subject: task.subject,
        ...profileSeedId === undefined ? {} : { profileSeedId },
        ...task.output === undefined ? {} : { output: task.output },
      }
    })
}

/** Format completed-dependency outputs with per-item and total truncation. */
export function formatDependencyOutputs(items: readonly DependencyOutput[]): string {
  if (items.length === 0) return '(none)'
  const formatted = items.map((item) => {
    const seed = item.profileSeedId === undefined ? '' : ` [${item.profileSeedId}]`
    const raw = item.output === undefined || item.output === ''
      ? '(no output recorded)'
      : item.output
    const truncated = raw.length > DEPENDENCY_OUTPUT_MAX_CHARS
    const body = truncated ? `${raw.slice(0, DEPENDENCY_OUTPUT_MAX_CHARS)} [truncated]` : raw
    return `- ${item.id}${seed} ${item.subject}:\n  ${body}`
  })
  let selected = formatted
  while (selected.length > 1 && selected.join('\n').length > DEPENDENCY_OUTPUTS_TOTAL_MAX_CHARS) {
    selected = selected.slice(1)
  }
  const last = selected[0]
  if (selected.length === 1 && last !== undefined && last.length > DEPENDENCY_OUTPUTS_TOTAL_MAX_CHARS) {
    selected = [`${last.slice(0, DEPENDENCY_OUTPUTS_TOTAL_MAX_CHARS)} [truncated]`]
  }
  return selected.join('\n')
}

function stateRootOf(workspace: string, config: SchedulerConfig): string {
  return join(workspace, config.stateDir)
}

function teamLockKey(stateRoot: string, teamId: string): string {
  return `team:${stateRoot}:${teamId}`
}

function liveCaptain(ctx: Context, captainSessionId: string, supplied?: Agent): Agent | undefined {
  if (supplied !== undefined && supplied.id === captainSessionId) return supplied
  return ctx.agents.get(captainSessionId as SessionId)
}

function liveMember(ctx: Context, member: TeamMember): Agent | undefined {
  return ctx.agents.get(member.id as SessionId)
}

function isMemberAvailable(ctx: Context, member: TeamMember): boolean {
  if (member.stopping === true) return false
  const live = liveMember(ctx, member)
  return live === undefined || live.status === 'idle'
}

function ownedOpenTask(tasks: readonly TeamTask[], memberName: string): TeamTask | undefined {
  return tasks.find(task => task.assignee === memberName
    && (task.status === 'claimed' || task.status === 'in_progress'))
}

function nextReadyTask(tasks: readonly TeamTask[], memberName: string): TeamTask | undefined {
  const ready = tasks.filter(task => task.status === 'pending'
    && task.reassigning !== true
    && unsatisfiedDependencies([...tasks], task.dependencies).length === 0)
  return ready.find(task => task.assignee === memberName)
    ?? ready.find(task => task.assignee === undefined)
}

export function assignmentPrompt(
  ticket: DispatchTicket,
  stateDir: string,
  teamId: string,
  workOrderWarnings: readonly string[] = [],
): string {
  const description = ticket.description === undefined ? '' : `\n\n${ticket.description}`
  const seed = ticket.profileSeedId === undefined ? '' : ` [${ticket.profileSeedId}]`
  const goal = ticket.teamDescription?.trim() || '(not provided)'
  const protocol = ticket.profileProtocol?.trim() || '(none)'
  const executionPrompt = ticket.executionPrompt?.trim()
  const kind = ticket.kind?.trim() || 'work'
  const staleWorkOrder = workOrderWarnings.length === 0
    ? ''
    : `\nBefore you edit anything: this auto-generated work order was derived from a workspace that has since changed.\n${workOrderWarnings.map((warning) => `- ${warning}`).join('\n')}\nRe-read the cited files first, locate the code by content anchor rather than by any position, and report a blocker instead of editing a target that no longer exists.\n`
  const contract = [
    `Kind: ${kind}${ticket.round === undefined ? '' : ` (round ${ticket.round})`}`,
    ticket.objective === undefined || ticket.objective === '' ? '' : `Objective: ${ticket.objective}`,
    ticket.inScope === undefined || ticket.inScope.length === 0 ? '' : `In scope: ${ticket.inScope.join(', ')}`,
    ticket.outOfScope === undefined || ticket.outOfScope.length === 0 ? '' : `Out of scope: ${ticket.outOfScope.join(', ')}`,
    ticket.acceptance === undefined || ticket.acceptance.length === 0 ? '' : `Acceptance: ${ticket.acceptance.join('; ')}`,
    ticket.verify === undefined || ticket.verify.length === 0 ? '' : `Verify: ${ticket.verify.join('; ')}`,
    ticket.reviewedTaskId === undefined ? '' : `Reviewed task: ${ticket.reviewedTaskId}`,
    ticket.findingSourceTaskIds === undefined || ticket.findingSourceTaskIds.length === 0 ? '' : `Fixes findings of: ${ticket.findingSourceTaskIds.join(', ')}`,
  ].filter((line) => line !== '').join('\n')
  const structuredCompletion = ['implementation', 'repair', 'verification', 'integration'].includes(kind)
    ? `
Structured completion payload (keep these arrays in contract order):
acceptanceResults: ${JSON.stringify((ticket.acceptance ?? []).map((criterion) => ({ criterion, status: 'passed', evidence: '<what proved it>' })))}
commandsRun: ${JSON.stringify((ticket.verify ?? []).map((command) => ({ command, status: 'passed', exitCode: 0, evidence: '<observed result>' })))}
${kind === 'implementation' || kind === 'repair' ? 'changedPaths: list the actual workspace-relative POSIX paths you changed.\n' : ''}`
    : ''
  return `AgentTeams automatic task assignment from the shared task list.

You are executing as configured member "${ticket.memberName}".
Do not start a teammate's assigned task.

Team goal:
${goal}

Profile protocol:
${protocol}
${executionPrompt === undefined || executionPrompt === '' ? '' : `
Execution guidance:
${executionPrompt}
`}
Completed dependency results:
${formatDependencyOutputs(ticket.dependencyOutputs)}

Task: ${ticket.taskId}${seed} — ${ticket.subject}${description}
${staleWorkOrder}${contract === '' ? '' : `\nContract:\n${contract}\n`}
${structuredCompletion}
Attempt: ${ticket.attempt}
Attempt id: ${ticket.attemptId}
Activation id: ${ticket.activationId}
Dispatch token: ${ticket.dispatchToken}

Call agent_teams_claim_task for ${ticket.taskId}; it will return this same attempt_id. Include attempt_id=${ticket.attemptId} in every agent_teams_update_task call. If it is rejected as stale, stop work because the task was reassigned. claimed cannot jump to completed. Mark in_progress first, then completed or failed. Include attempt_id on every update. Then send_message to captain with source_task_id and source_attempt_id and become idle.
When finishing: use status=completed only when the task's success criteria are satisfied; use status=failed when blocking findings or validation failures mean downstream work must not proceed; include a concise output in either case. Quality kinds must submit structured fields: review/requirements need verdict=pass to complete (needs_revision/reject must fail with findings); implementation/repair/verification/integration need acceptanceResults and commandsRun, while implementation/repair also need in-scope changedPaths. Use status values "passed" or "failed" inside those arrays. After the work and verification finish, call agent_teams_update_task immediately; do not wait for captain confirmation and do not continue exploring. Do not approve your own implementation. Mail is not a formal next review. Completed work must not be repeated to attach late evidence: call update_task on the original task with its attempt_id and acceptanceResults/commandsRun/evidence_note; supplements are append-only and cannot change its verdict. Treat the dependency results above as source material. Do not ignore them. Work only this task and only its in-scope paths in this turn.

State policy: ${stateDir}/${teamId}/ is read-only diagnostics; mutate team state only through agent_teams_* tools.`
}

/** Install one scheduler and its member activity observer. */
export function installTeamScheduler(ctx: Context, config: SchedulerConfig): TeamScheduler {
  const memberQueues = new Map<string, Promise<unknown>>()
  // An idle edge in this process proves that the resident member ended its
  // turn while the current attempt was still open. Remember that capability
  // even after Harness disposes the continuable AgentHandle: later status or
  // graph kicks must keep it parked. A cold process starts with an empty map,
  // so durable open attempts are still recovered after restart.
  const parkedAttempts = new Map<string, string>()

  const memberQueueKey = (stateRoot: string, teamId: string, memberName: string): string => (
    `${stateRoot}\u0000${teamId}\u0000${memberName}`
  )

  const pendingByChild = new Map<string, { teamId: string; activationId: string }>()
  const runToActivation = new Map<string, { teamId: string; activationId: string }>()
  const activationRoots = new Map<string, string>()
  const activationWorkspaces = new Map<string, string>()
  const lifecycleLanes = new Map<string, Promise<unknown>>()

  const serializeLifecycle = async <T>(childId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = lifecycleLanes.get(childId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => gate)
    lifecycleLanes.set(childId, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (lifecycleLanes.get(childId) === tail) lifecycleLanes.delete(childId)
    }
  }

  const stopReasonOf = (reason: unknown): ActivationStopReason => {
    return reason === 'completed' || reason === 'max-tokens' || reason === 'aborted'
      || reason === 'error' || reason === 'refusal' ? reason : 'unknown'
  }

  const boundedText = (value: string, max = 2_000): string => (
    value.length <= max ? value : `${value.slice(0, max)}… [truncated]`
  )

  const noticeFor = (
    team: TeamState,
    lease: ActivationLease,
    kind: NotificationLedgerEntry['kind'],
    content: string,
  ): NotificationLedgerEntry => {
    const id = `${lease.activationId}:${kind}`
    const existing = team.notifications?.find(entry => entry.id === id)
    if (existing !== undefined) return existing
    const now = Date.now()
    team.notificationSeq = (team.notificationSeq ?? 0) + 1
    const notice: NotificationLedgerEntry = {
      id,
      messageId: `notice:${id}`,
      teamId: team.id,
      memberId: lease.memberId,
      memberGeneration: lease.memberGeneration,
      activationId: lease.activationId,
      ...lease.taskId === undefined ? {} : { taskId: lease.taskId },
      ...lease.attemptId === undefined ? {} : { attemptId: lease.attemptId },
      kind,
      content: boundedText(content),
      state: 'pending',
      noticeDueAt: now,
      createdAt: now,
    }
    team.notifications = [...(team.notifications ?? []), notice].slice(-200)
    return notice
  }

  const flushNotice = async (workspace: string, stateRoot: string, teamId: string, noticeId: string): Promise<void> => {
    const prepared = await withTeamLock(teamLockKey(stateRoot, teamId), async () => {
      const team = await readTeam(stateRoot, teamId)
      const notice = team?.notifications?.find(entry => entry.id === noticeId)
      if (team === undefined || notice === undefined || notice.noticeDueAt > Date.now()
        || notice.state === 'delivered' || notice.state === 'read' || notice.state === 'superseded') return undefined
      const task = notice.taskId === undefined ? undefined : team.tasks.find(candidate => candidate.id === notice.taskId)
      if (notice.kind === 'parked' && (task?.parking?.noticeKey !== notice.id || task.status !== 'claimed' && task.status !== 'in_progress')) {
        notice.state = 'superseded'
        await writeTeam(stateRoot, team)
        return undefined
      }
      const message = {
        ...createMessage('system', CAPTAIN_KEY, notice.content),
        id: notice.messageId,
        ts: notice.createdAt,
        ...notice.taskId === undefined ? {} : { sourceTaskId: notice.taskId },
        ...notice.attemptId === undefined ? {} : { sourceAttemptId: notice.attemptId },
      }
      await appendMailboxOnce(stateRoot, team.id, CAPTAIN_KEY, message)
      notice.state = 'appended'
      notice.appendedAt ??= Date.now()
      await writeTeam(stateRoot, team)
      return { captainSessionId: team.captainSessionId, message }
    })
    if (prepared === undefined) return
    const captain = ctx.agents.get(prepared.captainSessionId as SessionId)
    const delivered = captain !== undefined && steerCaptainReport(
      captain,
      'system',
      prepared.message.content,
      mailboxPrompt(teamId, CAPTAIN_KEY, [prepared.message]),
    )
    if (!delivered) return
    await withTeamLock(teamLockKey(stateRoot, teamId), async () => {
      const team = await readTeam(stateRoot, teamId)
      const notice = team?.notifications?.find(entry => entry.id === noticeId)
      if (team === undefined || notice === undefined) return
      notice.state = 'delivered'
      notice.deliveredAt ??= Date.now()
      await writeTeam(stateRoot, team)
    })
  }

  const flushDueNotices = async (workspace: string, stateRoot: string, teamId: string): Promise<void> => {
    const team = await readTeam(stateRoot, teamId)
    if (team === undefined) return
    for (const notice of team.notifications ?? []) {
      if (notice.state === 'pending' && notice.noticeDueAt <= Date.now()) {
        await flushNotice(workspace, stateRoot, teamId, notice.id)
      }
    }
  }

  const activationBoundary = async (childId: string, isNew: boolean): Promise<number> => {
    if (isNew) return 0
    const live = ctx.agents.get(SessionId(childId))
    if (live !== undefined) return Number(live.session.seq)
    if (typeof ctx.get !== 'function') return 0
    const query = ctx.get('sessionQuery') as {
      observeSession?: (id: SessionId, options: { signal: AbortSignal }) => Promise<{ events: readonly unknown[] }>
    } | undefined
    if (typeof query?.observeSession !== 'function') {
      throw new Error('agent-teams: managed resume requires the sessionQuery observeSession API')
    }
    const observed = await query.observeSession(SessionId(childId), { signal: new AbortController().signal })
    return observed.events.length
  }

  const allocateActivation = async (
    stateRoot: string,
    workspace: string,
    team: TeamState,
    member: TeamMember,
    purpose: ActivationLease['purpose'],
    options: { task?: TeamTask; attemptId?: string; activationId?: string; dispatchToken?: string } = {},
  ): Promise<{ lease: ActivationLease; newChild: boolean; reservedChildId: string }> => {
    const managed = usesManagedActivations(ctx.subagents)
    const newChild = member.id === ''
    const reservedChildId = newChild ? managed ? String(SessionId(randomUUID())) : '' : member.id
    const activationEpoch = (team.activationSeq ?? 0) + 1
    const activationId = options.activationId ?? randomUUID()
    const dispatchToken = options.dispatchToken ?? randomUUID()
    const lease: ActivationLease = {
      activationId,
      dispatchToken,
      teamId: team.id,
      memberId: reservedChildId,
      memberGeneration: member.generation ?? 1,
      activationEpoch,
      purpose,
      ...options.task === undefined ? {} : { taskId: options.task.id, attempt: options.task.attempt },
      ...options.attemptId === undefined ? {} : { attemptId: options.attemptId },
      preDispatchSessionSeq: await activationBoundary(reservedChildId, newChild),
      startObserved: false,
      endObserved: false,
      settlementApplied: false,
      recoveryDecision: 'none',
      state: 'pending',
      permitHeld: true,
      createdAt: Date.now(),
    }
    if (newChild && managed) member.id = reservedChildId
    if (!managed) {
      return { lease, newChild, reservedChildId }
    }
    member.generation = member.generation ?? 1
    member.currentActivationId = activationId
    member.lastActivationEpoch = activationEpoch
    team.activationSeq = activationEpoch
    team.activations = [...(team.activations ?? []), lease].slice(-200)
    if (options.task !== undefined && options.attemptId !== undefined) {
      options.task.attemptMemberId = reservedChildId
      options.task.attemptGeneration = member.generation
      options.task.attemptActivationId = activationId
      options.task.attemptActivationEpoch = activationEpoch
    }
    pendingByChild.set(reservedChildId, { teamId: team.id, activationId })
    activationRoots.set(team.id, stateRoot)
    activationWorkspaces.set(team.id, workspace)
    return { lease, newChild, reservedChildId }
  }

  const resolveLease = (team: TeamState, activationId: string): ActivationLease | undefined => (
    team.activations?.find(lease => lease.activationId === activationId)
  )

  const settleActivation = async (input: {
    teamId: string
    activationId: string
    hostRunId?: string
    stopReason: unknown
    diagnostic?: string
    lastAssistantMessage?: string
    source: 'end' | 'result' | 'restart'
  }, stateRoot: string): Promise<void> => {
    await withTeamLock(teamLockKey(stateRoot, input.teamId), async () => {
      const team = await readTeam(stateRoot, input.teamId)
      if (team === undefined) return
      const lease = resolveLease(team, input.activationId)
      if (lease === undefined || lease.state === 'released' || lease.endObserved && lease.settlementApplied === true) return
      if (lease.hostRunId !== undefined && input.hostRunId !== undefined && lease.hostRunId !== input.hostRunId) return
      const stopReason = stopReasonOf(input.stopReason)
      lease.hostRunId ??= input.hostRunId
      lease.endObserved = true
      lease.state = 'ended'
      lease.endedAt = Date.now()
      lease.stopReason = stopReason
      if (input.diagnostic !== undefined) lease.diagnostic = boundedText(input.diagnostic)
      if (input.lastAssistantMessage !== undefined) lease.lastAssistantMessage = boundedText(input.lastAssistantMessage)
      const task = input.source === 'end'
        ? team.tasks.find(candidate => candidate.id === lease.taskId
          && candidate.attemptId === lease.attemptId
          && candidate.attemptActivationId === lease.activationId
          && (candidate.status === 'claimed' || candidate.status === 'in_progress'))
        : team.tasks.find(candidate => candidate.id === lease.taskId
          && candidate.attemptId === lease.attemptId
          && candidate.attemptActivationId === lease.activationId)
      if (task !== undefined && (task.status === 'claimed' || task.status === 'in_progress')) {
        const now = Date.now()
        if (stopReason !== 'completed') {
          task.status = 'failed'
          const base = stopReason === 'unknown'
            ? 'settlement_unknown: missing or unknown stopReason (fail closed)'
            : `activation ended with stopReason=${stopReason}`
          task.output = lease.diagnostic === undefined ? base : `${base}: ${lease.diagnostic}`
          task.updatedAt = now
          noticeFor(team, lease, stopReason === 'unknown' ? 'settlement_unknown' : 'failed',
            `Member ${lease.memberId} activation ${lease.activationId} failed task ${task.id}: ${task.output}`)
        } else {
          const noticeKey = `${lease.activationId}:parked`
          const parking: TaskParking = {
            memberId: lease.memberId,
            memberGeneration: lease.memberGeneration,
            activationId: lease.activationId,
            activationEpoch: lease.activationEpoch,
            attemptId: lease.attemptId ?? '',
            noticeDueAt: now,
            noticeKey,
          }
          task.parking = parking
          parkedAttempts.set(lease.memberId, lease.attemptId ?? '')
          noticeFor(team, lease, 'parked',
            `Member ${lease.memberId} finished activation ${lease.activationId} with completed stopReason while task ${task.id} is still ${task.status}. The exact attempt is parked; use reassign_task or update the task with its current attempt_id as appropriate.`)
        }
      }
      lease.settlementApplied = true
      lease.state = 'released'
      lease.permitHeld = false
      lease.releasedAt = Date.now()
      await writeTeam(stateRoot, team)
    })
    const pointer = pendingByChild.get([...pendingByChild.entries()].find(([, value]) => value.activationId === input.activationId)?.[0] ?? '')
    if (pointer !== undefined) {
      const childId = [...pendingByChild.entries()].find(([, value]) => value === pointer)?.[0]
      if (childId !== undefined) {
        pendingByChild.delete(childId)
        const agent = ctx.agents.get(SessionId(childId))
        if (agent !== undefined) unbindAgentRun(agent)
      }
    }
    if (input.hostRunId !== undefined) runToActivation.delete(input.hostRunId)
  }

  const bindStart = async (info: SubagentRunInfo): Promise<void> => {
    const childId = String(info.id)
    const pointer = pendingByChild.get(childId)
    if (pointer === undefined) return
    const agent = ctx.agents.get(info.id)
    const stateRoot = activationRoots.get(pointer.teamId) ?? agent?.session.header.cwd ?? process.cwd()
    await withTeamLock(teamLockKey(stateRoot, pointer.teamId), async () => {
      const team = await readTeam(stateRoot, pointer.teamId)
      if (team === undefined) return
      const lease = resolveLease(team, pointer.activationId)
      if (lease === undefined || lease.state === 'released' || lease.endObserved) return
      if (lease.hostRunId !== undefined && lease.hostRunId !== String(info.runId)) return
      lease.hostRunId = String(info.runId)
      lease.startObserved = true
      lease.state = 'started'
      lease.startedAt ??= Date.now()
      await writeTeam(stateRoot, team)
      runToActivation.set(String(info.runId), { teamId: lease.teamId, activationId: lease.activationId })
      if (agent !== undefined) {
        bindAgentRun(agent, {
          teamId: lease.teamId,
          activationId: lease.activationId,
          hostRunId: String(info.runId),
          memberId: lease.memberId,
          memberGeneration: lease.memberGeneration,
          activationEpoch: lease.activationEpoch,
          recordDiagnostic: diagnostic => {
            void withTeamLock(teamLockKey(stateRoot, lease.teamId), async () => {
              const fresh = await readTeam(stateRoot, lease.teamId)
              const current = fresh === undefined ? undefined : resolveLease(fresh, lease.activationId)
              if (fresh === undefined || current === undefined || current.state === 'released') return
              current.diagnostic = boundedText(diagnostic)
              await writeTeam(stateRoot, fresh)
            }).catch(error => {
              ctx.logger.warn(`agent-teams: activation diagnostic persistence failed: ${String(error)}`)
            })
          },
        })
      }
    })
  }

  const settleEnd = async (info: SubagentRunEndInfo): Promise<void> => {
    const runId = String(info.runId)
    let pointer = runToActivation.get(runId)
    if (pointer === undefined) {
      const child = pendingByChild.get(String(info.id))
      if (child !== undefined) pointer = child
    }
    if (pointer === undefined) return
    const agent = ctx.agents.get(info.id)
    const stateRoot = activationRoots.get(pointer.teamId) ?? agent?.session.header.cwd ?? process.cwd()
    const message = info.lastAssistantMessage?.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    await settleActivation({
      teamId: pointer.teamId,
      activationId: pointer.activationId,
      hostRunId: runId,
      stopReason: info.stopReason,
      ...message === undefined || message === '' ? {} : { lastAssistantMessage: message },
      source: 'end',
    }, stateRoot)
    const workspace = activationWorkspaces.get(pointer.teamId)
    if (workspace !== undefined) await flushDueNotices(workspace, stateRoot, pointer.teamId)
    const fresh = await readTeam(stateRoot, pointer.teamId)
    const memberName = fresh?.members.find(member => member.id === String(info.id))?.name
    if (memberName !== undefined && workspace !== undefined) {
      await runtime.kickMember(workspace, pointer.teamId, memberName)
    }
  }

  const recordReceipt = (input: {
    stateRoot: string
    teamId: string
    activationId: string
    receipt: MemberStartResult
  }): void => {
    void withTeamLock(teamLockKey(input.stateRoot, input.teamId), async () => {
      const team = await readTeam(input.stateRoot, input.teamId)
      const lease = team === undefined ? undefined : resolveLease(team, input.activationId)
      if (team === undefined || lease === undefined) return
      if (input.receipt.messageId !== undefined) lease.hostMessageId = String(input.receipt.messageId)
      await writeTeam(input.stateRoot, team)
    }).catch(error => {
      ctx.logger.warn(`agent-teams: activation receipt persistence failed: ${String(error)}`)
    })
    const result = input.receipt.result
    if (result === undefined) return
    void result.then(async (value: unknown) => {
      const observed = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
      try {
        if (input.receipt.dispose !== undefined) await input.receipt.dispose()
      } catch (error: unknown) {
        ctx.logger.warn(`agent-teams: exact activation dispose failed: ${String(error)}`)
      }
      const team = await readTeam(input.stateRoot, input.teamId)
      const lease = team === undefined ? undefined : resolveLease(team, input.activationId)
      if (lease === undefined || lease.endObserved) return
      const output = Array.isArray(observed['output'])
        ? observed['output'].flatMap(block => typeof block === 'object' && block !== null
          && (block as Record<string, unknown>)['type'] === 'text'
          && typeof (block as Record<string, unknown>)['text'] === 'string'
          ? [(block as Record<string, unknown>)['text'] as string] : []).join('\n')
        : undefined
      await settleActivation({
        teamId: input.teamId,
        activationId: input.activationId,
        stopReason: observed['stopReason'],
        ...typeof observed['diagnostic'] === 'string' ? { diagnostic: observed['diagnostic'] } : {},
        ...output === undefined || output === '' ? {} : { lastAssistantMessage: output },
        source: 'result',
      }, input.stateRoot)
      const workspace = activationWorkspaces.get(input.teamId)
      if (workspace !== undefined) await flushDueNotices(workspace, input.stateRoot, input.teamId)
    }, async error => {
      try {
        if (input.receipt.dispose !== undefined) await input.receipt.dispose()
      } catch (disposeError: unknown) {
        ctx.logger.warn(`agent-teams: exact activation dispose after result rejection failed: ${String(disposeError)}`)
      }
      const errorText = error instanceof Error ? error.message : String(error)
      await settleActivation({
        teamId: input.teamId,
        activationId: input.activationId,
        stopReason: 'unknown',
        diagnostic: errorText,
        source: 'result',
      }, input.stateRoot)
      const workspace = activationWorkspaces.get(input.teamId)
      if (workspace !== undefined) await flushDueNotices(workspace, input.stateRoot, input.teamId)
    }).catch(error => {
      ctx.logger.warn(`agent-teams: activation result reconciliation failed: ${String(error)}`)
    })
  }

  const recoveryEvents = async (childId: string, from: number): Promise<readonly { type: string; data?: unknown }[]> => {
    const live = ctx.agents.get(SessionId(childId))
    if (live !== undefined && typeof live.session.snapshotEvents === 'function') {
      return live.session.snapshotEvents(SessionLogOffset(from)) as readonly { type: string; data?: unknown }[]
    }
    if (typeof ctx.get !== 'function') return []
    const query = ctx.get('sessionQuery') as {
      observeSession?: (id: SessionId, options: { signal: AbortSignal }) => Promise<{ events: readonly { type: string; data?: unknown }[] }>
    } | undefined
    if (typeof query?.observeSession !== 'function') return []
    const observed = await query.observeSession(SessionId(childId), { signal: new AbortController().signal })
    return observed.events.slice(from)
  }

  const orphanActivation = async (stateRoot: string, workspace: string, teamId: string, lease: ActivationLease): Promise<void> => {
    await withTeamLock(teamLockKey(stateRoot, teamId), async () => {
      const team = await readTeam(stateRoot, teamId)
      const current = team === undefined ? undefined : resolveLease(team, lease.activationId)
      if (team === undefined || current === undefined || current.state === 'released') return
      current.state = 'orphaned'
      current.recoveryDecision = 'orphaned_parked'
      current.endObserved = true
      current.stopReason = 'unknown'
      current.settlementApplied = true
      current.permitHeld = false
      current.endedAt ??= Date.now()
      current.releasedAt = Date.now()
      const task = current.taskId === undefined ? undefined : team.tasks.find(candidate => candidate.id === current.taskId
        && candidate.attemptId === current.attemptId && candidate.attemptActivationId === current.activationId)
      if (task !== undefined && (task.status === 'claimed' || task.status === 'in_progress')) {
        const now = Date.now()
        task.parking = {
          memberId: current.memberId,
          memberGeneration: current.memberGeneration,
          activationId: current.activationId,
          activationEpoch: current.activationEpoch,
          attemptId: current.attemptId ?? '',
          noticeDueAt: now,
          noticeKey: `${current.activationId}:parked`,
        }
        noticeFor(team, current, 'parked',
          `Member ${current.memberId} activation ${current.activationId} has no observable end after restart; task ${task.id} is parked and requires an exact captain decision.`)
      }
      await writeTeam(stateRoot, team)
    })
    activationRoots.set(teamId, stateRoot)
    activationWorkspaces.set(teamId, workspace)
  }

  const recoverActivations = async (workspace: string, stateRoot: string, teamId: string): Promise<void> => {
    const team = await readTeam(stateRoot, teamId)
    if (team === undefined) return
    activationRoots.set(teamId, stateRoot)
    activationWorkspaces.set(teamId, workspace)
    for (const lease of [...(team.activations ?? [])]) {
      if (lease.state === 'released' || lease.state === 'rejected') continue
      // A start event is delivered through an async lifecycle lane. Do not
      // mistake that in-process publication window for a crash and roll back
      // the lease while it is still acquiring its exact run binding.
      if ([...pendingByChild.values()].some(pointer => pointer.activationId === lease.activationId)) continue
      if (lease.endObserved && lease.settlementApplied !== true) {
        await settleActivation({
          teamId, activationId: lease.activationId, hostRunId: lease.hostRunId,
          stopReason: lease.stopReason, diagnostic: lease.diagnostic, source: 'restart',
        }, stateRoot)
        continue
      }
      if (lease.endObserved) continue
      const live = ctx.agents.get(SessionId(lease.memberId))
      if (live?.status === 'running') {
        await withTeamLock(teamLockKey(stateRoot, teamId), async () => {
          const fresh = await readTeam(stateRoot, teamId)
          const current = fresh === undefined ? undefined : resolveLease(fresh, lease.activationId)
          if (fresh === undefined || current === undefined || current.state === 'released') return
          current.state = 'recovering'
          await writeTeam(stateRoot, fresh)
        })
        continue
      }
      const events = await recoveryEvents(lease.memberId, lease.preDispatchSessionSeq)
      const prompts = events.filter(event => event.type === 'user/message' && JSON.stringify(event.data ?? {}).includes(lease.dispatchToken))
      const turns = events.filter(event => event.type === 'turn/end')
      const starts = events.filter(event => event.type === 'turn/start')
      if (prompts.length > 1 || turns.length > 1) {
        await orphanActivation(stateRoot, workspace, teamId, lease)
        continue
      }
      if (prompts.length === 1 && turns.length === 1) {
        const reason = typeof turns[0]!.data === 'object' && turns[0]!.data !== null
          ? (turns[0]!.data as Record<string, unknown>)['reason']
          : undefined
        await settleActivation({
          teamId, activationId: lease.activationId, hostRunId: lease.hostRunId,
          stopReason: stopReasonOf(reason), source: 'restart',
        }, stateRoot)
        continue
      }
      // A committed turn event is acceptance evidence even when the exact
      // prompt token/start marker was lost. Roll back only a provably empty
      // post-boundary trace.
      const accepted = lease.startObserved || lease.hostMessageId !== undefined
        || prompts.length === 1 || starts.length > 0 || turns.length > 0
      if (accepted) {
        await orphanActivation(stateRoot, workspace, teamId, lease)
        continue
      }
      await withTeamLock(teamLockKey(stateRoot, teamId), async () => {
        const fresh = await readTeam(stateRoot, teamId)
        const current = fresh === undefined ? undefined : resolveLease(fresh, lease.activationId)
        if (fresh === undefined || current === undefined || current.state === 'released') return
        const task = current.taskId === undefined ? undefined : fresh.tasks.find(candidate => candidate.id === current.taskId
          && candidate.attemptId === current.attemptId && candidate.attemptActivationId === current.activationId)
        if (task !== undefined && (task.status === 'claimed' || task.status === 'in_progress')) {
          const memberName = fresh.members.find(member => member.id === current.memberId)?.name
          task.status = 'pending'
          task.assignee = memberName
          task.attempt = Math.max(0, (task.attempt ?? 1) - 1)
          task.attemptId = undefined
          clearTaskActivation(task)
          task.updatedAt = Date.now()
        }
        current.state = 'rejected'
        current.recoveryDecision = 'rolled_back'
        current.permitHeld = false
        current.releasedAt = Date.now()
        await writeTeam(stateRoot, fresh)
      })
    }
  }

  ctx.on('subagent/start', info => {
    void serializeLifecycle(String(info.id), () => bindStart(info)).catch(error => {
      ctx.logger.warn(`agent-teams: activation start binding failed for ${String(info.id)}: ${String(error)}`)
    })
  })
  ctx.on('subagent/end', info => {
    void serializeLifecycle(String(info.id), () => settleEnd(info)).catch(error => {
      ctx.logger.warn(`agent-teams: activation settlement failed for ${String(info.id)}: ${String(error)}`)
    })
  })

  const serializeMember = async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const previous = memberQueues.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => gate)
    memberQueues.set(key, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (memberQueues.get(key) === tail) memberQueues.delete(key)
    }
  }

  const runtime: TeamScheduler = {
    async kickTeam(workspace, teamId, suppliedCaptain) {
      const stateRoot = stateRootOf(workspace, config)
      await recoverActivations(workspace, stateRoot, teamId)
      await flushDueNotices(workspace, stateRoot, teamId)
      const team = await readTeam(stateRoot, teamId)
      if (team === undefined || team.halted === true || team.phase === 'staged') return
      const captain = liveCaptain(ctx, team.captainSessionId, suppliedCaptain)
      if (captain === undefined) return
      for (const member of team.members) {
        if (member.status === 'removed') continue
        await runtime.kickMember(workspace, teamId, member.name, captain)
      }
    },

    async kickMember(workspace, teamId, memberName, suppliedCaptain) {
      const stateRoot = stateRootOf(workspace, config)
      const queueKey = memberQueueKey(stateRoot, teamId, memberName)
      await serializeMember(queueKey, async () => {
        await recoverActivations(workspace, stateRoot, teamId)
        await flushDueNotices(workspace, stateRoot, teamId)
        let team = await readTeam(stateRoot, teamId)
        if (team === undefined || team.halted === true || team.phase === 'staged') return
        const captain = liveCaptain(ctx, team.captainSessionId, suppliedCaptain)
        if (captain === undefined) return
        let member = team.members.find(candidate => candidate.name === memberName && candidate.status !== 'removed')
        if (member === undefined || !isMemberAvailable(ctx, member)) return

        // A mailbox-only fallback is real pending work. Deliver it before a
        // fresh task and acknowledge only after Harness accepts the follow-up.
        const mailboxDelivery = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
          const fresh = await readTeam(stateRoot, team!.id)
          if (fresh === undefined) return { messages: [], memberId: member!.id, newChild: false }
          const currentMember = fresh.members.find(candidate => candidate.name === member!.name && candidate.status !== 'removed')
          if (currentMember === undefined) return { messages: [], memberId: member!.id, newChild: false }
          const pending = await readPendingMailbox(stateRoot, fresh.id, currentMember.name)
          await discardMailboxMessages(stateRoot, fresh.id, currentMember.name, pending.filter(message => !isCurrentMail(fresh, message)).map(message => message.id))
          const current = pending.filter(message => isCurrentMail(fresh, message))
          await claimMailboxDelivery(stateRoot, fresh.id, currentMember.name, current.map(message => message.id))
          if (current.length === 0) return { messages: current, memberId: currentMember.id, newChild: false }
          const live = ctx.agents.get(SessionId(currentMember.id))
          const decision = mailboxActivationDecision(fresh.activations ?? [], currentMember.id, live?.status === 'running')
          const activeLease = fresh.activations?.find(lease => lease.memberId === currentMember.id
            && (lease.state === 'pending' || lease.state === 'started' || lease.state === 'recovering'))
          const reuse = decision === 'reuse'
          if (decision === 'wait') {
            // A second mailbox wake cannot allocate another activation or
            // overwrite pendingByChild. Leave mail durable until the exact
            // end/drain/recovery path closes this lease.
            await releaseMailboxDelivery(stateRoot, fresh.id, currentMember.name, current.map(message => message.id))
            return { messages: [], memberId: currentMember.id, newChild: false, blocked: true }
          }
          if (!reuse && !canAcquireActivationPermit(fresh.activations ?? [], config.maxConcurrentWorkers)) {
            // Mailbox work is real work, but it may not bypass the global
            // activation budget. Keep the durable mail queued and retry from
            // the next scheduler edge after an exact permit release.
            await releaseMailboxDelivery(stateRoot, fresh.id, currentMember.name, current.map(message => message.id))
            return { messages: [], memberId: currentMember.id, newChild: false, blocked: true }
          }
          const activation = reuse ? undefined : await allocateActivation(stateRoot, workspace, fresh, currentMember, 'mailbox')
          await writeTeam(stateRoot, fresh)
          return {
            messages: current,
            memberId: currentMember.id,
            activation: activation?.lease ?? activeLease,
            newChild: activation === undefined ? false : activation.newChild,
          }
        })
        const unread = mailboxDelivery.messages
        if (unread.length > 0) {
          const activationText = mailboxDelivery.activation === undefined
            ? ''
            : `\n\nActivation id: ${mailboxDelivery.activation.activationId}\nDispatch token: ${mailboxDelivery.activation.dispatchToken}`
          const prompt = `${mailboxPrompt(team.id, member.name, unread)}${activationText}`
          const signal = new AbortController().signal
          const dispatched = config.dispatch === undefined
            ? await deliverToMember(ctx, captain, mailboxDelivery.memberId, prompt, signal, 'steer')
            : await config.dispatch(captain, team.id, member.name, prompt, signal, 'steer', {
              ...mailboxDelivery.activation === undefined ? {} : {
                activationId: mailboxDelivery.activation.activationId,
                dispatchToken: mailboxDelivery.activation.dispatchToken,
              },
              newChild: mailboxDelivery.newChild,
              reservedChildId: mailboxDelivery.memberId,
            })
          const accepted = typeof dispatched === 'boolean' ? dispatched : dispatched.accepted
          if (typeof dispatched !== 'boolean' && dispatched.receipt !== undefined && mailboxDelivery.activation !== undefined) {
            recordReceipt({
              stateRoot,
              teamId: team.id,
              activationId: mailboxDelivery.activation.activationId,
              receipt: dispatched.receipt,
            })
          }
          if (accepted) {
            await withTeamLock(teamLockKey(stateRoot, team.id), () => (
              markMailboxDelivered(stateRoot, team!.id, member!.name, unread.map(message => message.id))
            ))
          } else {
            if (mailboxDelivery.activation !== undefined) {
              await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
                const fresh = await readTeam(stateRoot, team!.id)
                const lease = fresh === undefined ? undefined : resolveLease(fresh, mailboxDelivery.activation!.activationId)
                if (fresh === undefined || lease === undefined) return
                lease.state = 'rejected'
                lease.permitHeld = false
                lease.releasedAt = Date.now()
                await writeTeam(stateRoot, fresh)
              })
            }
            await withTeamLock(teamLockKey(stateRoot, team.id), () => (
              releaseMailboxDelivery(stateRoot, team!.id, member!.name, unread.map(message => message.id))
            ))
          }
          return
        }

        const ticket = await withTeamLock(teamLockKey(stateRoot, team.id), async (): Promise<DispatchTicket | undefined> => {
          const fresh = await readTeam(stateRoot, team!.id)
          if (fresh === undefined || fresh.halted === true || fresh.phase === 'staged') return undefined
          const currentMember = fresh.members.find(candidate => candidate.name === memberName && candidate.status !== 'removed')
          if (currentMember === undefined || !isMemberAvailable(ctx, currentMember)) return undefined
          if (!canAcquireActivationPermit(fresh.activations ?? [], config.maxConcurrentWorkers)) return undefined
          const owned = ownedOpenTask(fresh.tasks, currentMember.name)
          const durableParking = owned?.parking
          const parkingBlocks = durableParking !== undefined
            && owned?.attemptId !== undefined
            && durableParking.attemptId === owned.attemptId
            && durableParking.memberId === currentMember.id
            && durableParking.memberGeneration === (currentMember.generation ?? 1)
          if (parkingBlocks) {
            parkedAttempts.set(currentMember.id, owned!.attemptId!)
            if (currentMember.status !== 'idle') {
              currentMember.status = 'idle'
              await writeTeam(stateRoot, fresh)
            }
            return undefined
          }
          const exactActiveLease = usesManagedActivations(ctx.subagents) && owned?.attemptActivationId !== undefined
            ? resolveLease(fresh, owned.attemptActivationId)
            : undefined
          const exactActive = exactActiveLease !== undefined
            && exactActiveLease.memberId === currentMember.id
            && exactActiveLease.memberGeneration === (currentMember.generation ?? 1)
            && (exactActiveLease.state === 'pending' || exactActiveLease.state === 'started' || exactActiveLease.state === 'recovering')
          // An idle edge observed by this scheduler parks the exact open
          // capability. Harness may dispose its AgentHandle after settlement,
          // so registry absence is not evidence that the owner was lost. Keep
          // the marker sticky across later kicks; only a durable attempt that
          // this process has not observed is eligible for one cold recovery.
          const parkedAttemptId = parkedAttempts.get(currentMember.id)
          const recoverOwned = owned !== undefined
            && (owned.attemptId === undefined || owned.attemptId !== parkedAttemptId)
          const task = exactActive ? undefined : recoverOwned ? owned : owned === undefined
            ? nextReadyTask(fresh.tasks, currentMember.name)
            : undefined
          if (task === undefined) {
            if (currentMember.status !== 'idle') {
              currentMember.status = 'idle'
              await writeTeam(stateRoot, fresh)
            }
            return undefined
          }
          const previousAssignee = task.assignee
          const previousStatus = recoverOwned ? task.status as 'claimed' | 'in_progress' : undefined
          const previousAttempt = recoverOwned ? task.attempt : undefined
          const previousAttemptId = recoverOwned ? task.attemptId : undefined
          const previousResult = recoverOwned ? {
            output: task.output, verdict: task.verdict, findings: task.findings,
            changedPaths: task.changedPaths, acceptanceResults: task.acceptanceResults, commandsRun: task.commandsRun,
          } : undefined
          const attemptId = beginTaskAttempt(task, currentMember.name)
          const activation = await allocateActivation(stateRoot, workspace, fresh, currentMember, 'task', { task, attemptId })
          // A verdict must be able to say which revision was on disk when it
          // started, so a review that runs while someone else edits the tree
          // cannot later claim to have judged stable bytes (issue #161).
          if (isVerdictKind(taskKindOf(task))) {
            const scope = verdictScopePatterns(fresh, task)
            if (scope.length > 0) task.verdictStartSnapshot = snapshotWorkspacePaths(workspace, scope)
          }
          // A recovered generation is parked before delivery. This makes each
          // (member, attempt) recovery idempotent even if every status poll
          // sees a disposed handle. Fresh pending work remains unparked so a
          // genuinely lost first delivery can be recovered once.
          if (recoverOwned) parkedAttempts.set(currentMember.id, attemptId)
          else parkedAttempts.delete(currentMember.id)
          currentMember.status = 'working'
          await writeTeam(stateRoot, fresh)
          const profileSeedId = taskProfileSeedId(task)
          const protocol = teamProfileProtocol(fresh)
          return {
            taskId: task.id,
            memberName: currentMember.name,
            memberId: activation.reservedChildId,
            attempt: task.attempt ?? 1,
            attemptId,
            activationId: activation.lease.activationId,
            dispatchToken: activation.lease.dispatchToken,
            newChild: activation.newChild,
            preDispatchSessionSeq: activation.lease.preDispatchSessionSeq,
            previousAssignee,
            recoveredOwned: recoverOwned,
            ...previousResult === undefined ? {} : { previousResult },
            ...previousStatus === undefined ? {} : { previousStatus },
            ...previousAttempt === undefined ? {} : { previousAttempt },
            ...previousAttemptId === undefined ? {} : { previousAttemptId },
            subject: task.subject,
            description: task.description,
            teamDescription: fresh.description,
            ...protocol === undefined ? {} : { profileProtocol: protocol },
            ...profileSeedId === undefined ? {} : { profileSeedId },
            ...fresh.profile?.executionPrompt === undefined && config.executionPrompt === undefined
              ? {}
              : { executionPrompt: fresh.profile?.executionPrompt ?? config.executionPrompt },
            kind: task.kind ?? 'work',
            ...task.round === undefined ? {} : { round: task.round },
            ...task.objective === undefined ? {} : { objective: task.objective },
            ...task.inScope === undefined ? {} : { inScope: task.inScope },
            ...task.outOfScope === undefined ? {} : { outOfScope: task.outOfScope },
            ...task.acceptance === undefined ? {} : { acceptance: task.acceptance },
            ...task.verify === undefined ? {} : { verify: task.verify },
            ...task.reviewedTaskId === undefined ? {} : { reviewedTaskId: task.reviewedTaskId },
            ...task.findingSourceTaskIds === undefined ? {} : { findingSourceTaskIds: task.findingSourceTaskIds },
            dependencyOutputs: collectCompletedDependencyOutputs(
              fresh.tasks,
              task.id,
              (message) => ctx.logger.warn(message),
            ),
          }
        })
        if (ticket === undefined) return

        const taskForWarning = team.tasks.find((item) => item.id === ticket.taskId)
        const workOrderStale = taskForWarning?.contractSnapshot === undefined
          ? []
          : contractStaleness(
            taskForWarning,
            digestWorkspacePaths(workspace, taskForWarning.contractSnapshot.artifacts.map((artifact) => artifact.path)),
          )
        const prompt = assignmentPrompt(ticket, config.stateDir, team.id, workOrderStale)
        const signal = new AbortController().signal
        const dispatched = config.dispatch === undefined
          ? await deliverToMember(ctx, captain, ticket.memberId, prompt, signal)
          : await config.dispatch(captain, team.id, ticket.memberName, prompt, signal, 'queue', {
            attemptId: ticket.attemptId,
            activationId: ticket.activationId,
            dispatchToken: ticket.dispatchToken,
            newChild: ticket.newChild,
            reservedChildId: ticket.memberId,
          })
        const accepted = typeof dispatched === 'boolean' ? dispatched : dispatched.accepted
        if (typeof dispatched !== 'boolean' && dispatched.receipt !== undefined) {
          recordReceipt({
            stateRoot,
            teamId: team.id,
            activationId: ticket.activationId,
            receipt: dispatched.receipt,
          })
        }
        if (accepted) return

        // Roll back only our exact failed dispatch. A concurrent captain
        // handoff has already changed the capability and wins.
        await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
          const fresh = await readTeam(stateRoot, team!.id)
          if (fresh === undefined) return
          const task = fresh.tasks.find(candidate => candidate.id === ticket.taskId)
          if (task?.attemptId !== ticket.attemptId) return
          if (ticket.recoveredOwned && ticket.previousStatus !== undefined && ticket.previousAttemptId !== undefined) {
            // Recovery delivery failed. Restore the durable generation instead
            // of returning it to pending, then keep it parked so later status
            // kicks cannot spend an unbounded sequence of fresh attempts.
            task.status = ticket.previousStatus
            task.assignee = ticket.previousAssignee
            task.attempt = ticket.previousAttempt
            task.attemptId = ticket.previousAttemptId
            Object.assign(task, ticket.previousResult)
            parkedAttempts.set(ticket.memberId, ticket.previousAttemptId)
          } else {
            task.status = 'pending'
            task.assignee = ticket.previousAssignee
            task.attemptId = undefined
            clearTaskActivation(task)
            parkedAttempts.delete(ticket.memberId)
          }
          const lease = resolveLease(fresh, ticket.activationId)
          if (lease !== undefined) {
            lease.state = 'rejected'
            lease.permitHeld = false
            lease.releasedAt = Date.now()
          }
          if (lease !== undefined && ticket.previousAttemptId !== undefined) {
            task.attemptMemberId = lease.memberId
            task.attemptGeneration = lease.memberGeneration
            task.attemptActivationId = lease.activationId
            task.attemptActivationEpoch = lease.activationEpoch
          }
          task.handoffId = undefined
          task.reassigning = false
          task.updatedAt = Date.now()
          const currentMember = fresh.members.find(candidate => candidate.name === ticket.memberName)
          if (currentMember !== undefined && currentMember.status !== 'removed') currentMember.status = 'idle'
          await writeTeam(stateRoot, fresh)
        })
      })
    },
  }

  const syncMemberStatus = async (agent: Agent, status: AgentStatus): Promise<void> => {
    const workspace = agent.session.header.cwd ?? process.cwd()
    const stateRoot = stateRootOf(workspace, config)
    const located = await findTeamByParticipant(stateRoot, agent.id)
    if (located === undefined) {
      parkedAttempts.delete(agent.id)
      return
    }
    if (located.captainSessionId === agent.id) {
      // Captain takeover is scoped to the captain's current turn. Unlike a
      // durable member, the captain has no scheduler lane that can resume an
      // abandoned attempt later. Returning unfinished captain-owned work to
      // the shared pool on the idle edge prevents it from becoming a
      // permanently parked `claimed` task after the captain answers, is
      // interrupted, or the user switches conversations.
      if (status === 'running') return
      let requeued = false
      await withTeamLock(teamLockKey(stateRoot, located.id), async () => {
        const fresh = await readTeam(stateRoot, located.id)
        if (fresh === undefined || fresh.captainSessionId !== agent.id) return
        for (const task of fresh.tasks) {
          if (task.assignee !== CAPTAIN_KEY
            || task.status === 'completed'
            || task.status === 'failed'
            || task.status === 'cancelled') continue
          invalidateTaskAttempt(task)
          task.reassigning = false
          requeued = true
        }
        if (requeued) await writeTeam(stateRoot, fresh)
      })
      if (requeued) await runtime.kickTeam(workspace, located.id, agent)
      return
    }
    const member = located.members.find(candidate => candidate.id === agent.id && candidate.status !== 'removed')
    if (member === undefined) {
      parkedAttempts.delete(agent.id)
      return
    }
    if (usesManagedActivations(ctx.subagents)) {
      const binding = boundAgentRun(agent)
      if (binding === undefined || binding.teamId !== located.id) return
      await withTeamLock(teamLockKey(stateRoot, located.id), async () => {
        const fresh = await readTeam(stateRoot, located.id)
        const current = fresh?.members.find(candidate => candidate.id === agent.id && candidate.status !== 'removed')
        const lease = fresh === undefined ? undefined : resolveLease(fresh, binding.activationId)
        if (fresh === undefined || current === undefined || lease === undefined) return
        const exact = lease.hostRunId === binding.hostRunId
          && lease.activationId === current.currentActivationId
          && lease.memberGeneration === (current.generation ?? 1)
          && lease.state !== 'released'
        if (!exact) return
        // Status is display-only. Exact settlement and permit release belong to
        // subagent/end, never to an idle/status edge.
        const next = status === 'running' ? 'working' : 'idle'
        if (current.status !== next) {
          current.status = next
          await writeTeam(stateRoot, fresh)
        }
      })
      return
    }
    await withTeamLock(teamLockKey(stateRoot, located.id), async () => {
      const fresh = await readTeam(stateRoot, located.id)
      const current = fresh?.members.find(candidate => candidate.id === agent.id && candidate.status !== 'removed')
      if (fresh === undefined || current === undefined) return
      const next = status === 'running' ? 'working' : 'idle'
      if (next === 'idle') {
        const owned = ownedOpenTask(fresh.tasks, current.name)
        if (owned?.attemptId === undefined) parkedAttempts.delete(agent.id)
        else parkedAttempts.set(agent.id, owned.attemptId)
      } else {
        parkedAttempts.delete(agent.id)
      }
      if (current.status === next) return
      current.status = next
      await writeTeam(stateRoot, fresh)
    })
    if (status === 'idle') await runtime.kickMember(workspace, located.id, member.name)
  }

  ctx.on('agent/status', ({ agent, status }) => {
    void syncMemberStatus(agent, status).catch((error: unknown) => {
      ctx.logger.warn(`agent-teams: member status scheduling failed for ${agent.id}: ${String(error)}`)
    })
  })

  return runtime
}
