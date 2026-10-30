/** Durable delivery receipts and execution-generation filtering at step admission. */
import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { acknowledgeMailbox, CAPTAIN_KEY, discardMailboxMessages, findTeamByCaptain, readMailbox, readUnreadMailbox, readTeam, sanitizeKey, withTeamLock } from './state.ts'
import { TERMINAL_TASK_STATUSES, type ActivationLease, type TeamMessage, type TeamState } from './types.ts'
import { sessionOwnEvents } from './harness-compat.ts'
import { leadIdentityOfAsync, sessionLeadsTeamAsync } from './lineage.ts'

const PREFIX = 'AgentTeams inbox receipt: '
/** Bounded best-effort wait for a final report at native settlement. */
export const FINAL_REPORT_GRACE_MS = 500

function finalReportGraceMs(): number {
  const configured = Number(process.env['AGENT_TEAMS_FINAL_REPORT_GRACE_MS'])
  return Number.isFinite(configured) && configured >= 0 ? Math.min(configured, 2_000) : FINAL_REPORT_GRACE_MS
}

export function isCurrentMail(team: TeamState, message: TeamMessage): boolean {
  if (message.discardedAt !== undefined) return false
  if (message.sourceAttemptId !== undefined) {
    const source = team.tasks.find(task => task.id === message.sourceTaskId
      && task.attemptId === message.sourceAttemptId && task.assignee === message.from)
    if (source === undefined) return false
    const allowedStatus = message.sourceTaskStatus === undefined
      || !TERMINAL_TASK_STATUSES.includes(source.status)
      || message.sourceTaskStatus === source.status
      || (message.reportKind === 'final' && !TERMINAL_TASK_STATUSES.includes(message.sourceTaskStatus))
    if (!allowedStatus) return false
  }
  if (message.attemptId === undefined) return true
  return team.tasks.some(task => task.id === message.taskId && task.attemptId === message.attemptId
    && task.assignee === message.to && (task.status === 'claimed' || task.status === 'in_progress'))
}

/** Exact final-report predicate used by native settlement suppression. */
export function isFinalReportForSettlement(
  team: TeamState,
  message: TeamMessage,
  childId: string,
  lease: Pick<ActivationLease, 'activationId' | 'memberId' | 'memberGeneration'>,
): boolean {
  if (message.reportKind !== 'final' || message.sourceTaskId === undefined || message.sourceAttemptId === undefined) return false
  if (message.deliveredAt === undefined && message.readAt === undefined) return false
  if (message.sourceMemberId !== childId || lease.memberId !== childId) return false
  if (message.sourceActivationId !== lease.activationId) return false
  if ((message.sourceMemberGeneration ?? 0) !== lease.memberGeneration) return false
  const task = team.tasks.find(candidate => candidate.id === message.sourceTaskId)
  return task?.attemptId === message.sourceAttemptId
    && task.status === 'completed'
    && task.attemptActivationId === lease.activationId
}

/** Include structured provenance even in the status-tool fallback presentation. */
export function mailboxContent(message: TeamMessage): string {
  return (message.sourceTaskId === undefined ? ''
    : `[Source task ${message.sourceTaskId}, attempt_id ${message.sourceAttemptId}${message.sourceTaskStatus === undefined ? '' : `, status=${message.sourceTaskStatus}`}]\n`) + message.content
}

function mailboxBody(recipient: string, messages: readonly TeamMessage[]): string {
  return messages.map(message => recipient === CAPTAIN_KEY
      ? `AgentTeams message from member ${message.from}:\n\n${mailboxContent(message)}`
      : `AgentTeams message from ${message.from}${message.attemptId === undefined ? '' : ` for task ${message.taskId}, attempt_id ${message.attemptId}`}:\n\n${mailboxContent(message)}`).join('\n\n')
}

/** Fallback reads must enforce the same current-generation rule as live admission. */
export async function readCurrentMailbox(root: string, teamId: string, recipient: string, onMalformed?: (line: number) => void): Promise<TeamMessage[]> {
  return withTeamLock(`team:${root}:${teamId}`, async () => {
    const team = await readTeam(root, teamId)
    if (team === undefined) return []
    const messages = await readUnreadMailbox(root, teamId, recipient, onMalformed)
    await discardMailboxMessages(root, teamId, recipient, messages.filter(message => !isCurrentMail(team, message)).map(message => message.id))
    return messages.filter(message => isCurrentMail(team, message))
  })
}

export function mailboxPrompt(teamId: string, recipient: string, messages: readonly TeamMessage[]): string {
  return PREFIX + JSON.stringify({ teamId, recipient, ids: messages.map(message => message.id) }) + '\n\n' + mailboxBody(recipient, messages)
}

interface Receipt { teamId: string; recipient: string; ids: string[] }
function parseReceipt(text: string): Receipt | undefined {
  if (!text.startsWith(PREFIX)) return undefined
  try {
    const value: unknown = JSON.parse(text.slice(PREFIX.length).split('\n')[0]!)
    if (typeof value !== 'object' || value === null) return undefined
    const raw = value as Record<string, unknown>
    if (typeof raw['teamId'] !== 'string' || typeof raw['recipient'] !== 'string'
      || !Array.isArray(raw['ids']) || !raw['ids'].every(id => typeof id === 'string')) return undefined
    if (raw['teamId'] !== sanitizeKey(raw['teamId'])) return undefined
    return { teamId: raw['teamId'], recipient: raw['recipient'], ids: raw['ids'] as string[] }
  } catch { return undefined }
}

/** Only messages actually admitted to this recipient's step become read. */
export function installMailboxAdmission(ctx: Context, stateDir: string): void {
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const root = join(payload.agent.session.header.cwd ?? process.cwd(), stateDir)
    // The native runtime also wakes a parent when a background activation
    // settles. A successfully delivered Team report already carries that
    // result. Keep abnormal endings and missing reports as fallback signals.
    const successfulSettlements = new Set(decision.messages.flatMap(input => {
      const source = input.source
      return source?.kind === 'subagent-settled'
        && source.summary === `Background subagent ${source.senderSessionId} finished and will do no further work unless you send it more.`
        ? [source.senderSessionId as string] : []
    }))
    const redundantSettlements = new Set<string>()
    if (successfulSettlements.size > 0) {
      // Only an exact final report for the just-ended activation can suppress
      // the native settlement. Hold admission for a bounded grace so a report
      // that is already in flight can land; after that, never suppress based
      // on sender/time alone.
      const deadline = Date.now() + finalReportGraceMs()
      try {
        const owned = await findTeamByCaptain(root, payload.agent.id, await leadIdentityOfAsync(ctx, payload.agent.session))
        if (owned !== undefined) {
          while (true) {
            await withTeamLock(`team:${root}:${owned.id}`, async () => {
              const team = await readTeam(root, owned.id)
              if (team === undefined || !(await sessionLeadsTeamAsync(ctx, team, payload.agent.id)) || team.halted) return
              const reports = await readMailbox(root, team.id, CAPTAIN_KEY)
              for (const childId of successfulSettlements) {
                if (redundantSettlements.has(childId)) continue
                const leases = (team.activations ?? [])
                  .filter(lease => lease.memberId === childId && (lease.state === 'ended' || lease.state === 'released'))
                  .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
                const lease = leases[0]
                if (lease === undefined) continue
                if (reports.some(report => report.discardedAt === undefined && isFinalReportForSettlement(team, report, childId, lease))) {
                  redundantSettlements.add(childId)
                }
              }
            })
            if (redundantSettlements.size === successfulSettlements.size || Date.now() >= deadline) break
            await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))))
          }
        }
      } catch (error: unknown) {
        // A corrupt AgentTeams state file (e.g. an invalid team.json) must never
        // hold the host's step admission hostage: degrade to plain admission.
        ctx.logger?.warn(`agent-teams: mailbox admission degraded to plain pass-through for agent ${payload.agent.id}: could not read team state under ${root} (a team.json may be corrupt or unreadable): ${String(error)}`)
        return decision
      }
    }
    const batches = new Map<string, { receipt: Receipt; ids: Set<string>; current: Map<string, TeamMessage>; failed?: boolean }>()
    const inputs = decision.messages.map(input => {
      // Alpha.5/0.1.2-rc.1 public steering prepends a native sender block.
      // The host-authored receipt remains a separate text block after it.
      const receipt = input.content.flatMap(block => block.type === 'text' ? [parseReceipt(block.text)] : []).find(value => value !== undefined)
      if (receipt === undefined) return { input }
      const key = JSON.stringify([receipt.teamId, receipt.recipient])
      let batch = batches.get(key)
      if (batch === undefined) { batch = { receipt, ids: new Set(), current: new Map() }; batches.set(key, batch) }
      for (const id of receipt.ids) batch.ids.add(id)
      return { input, receipt, batch }
    })
    // One read/acknowledgement per recipient per step, even for a large burst.
    for (const batch of batches.values()) {
      const { receipt } = batch
      try {
        await withTeamLock(`team:${root}:${receipt.teamId}`, async () => {
          const team = await readTeam(root, receipt.teamId)
          if (team === undefined) return
          // Captain mail is admitted for any lead session of the team: after a
          // fork the human reads it in the fork while members still address the
          // recorded captain. Acknowledging marks it read for both.
          const isCaptainRecipient = receipt.recipient === CAPTAIN_KEY
            && await sessionLeadsTeamAsync(ctx, team, payload.agent.id)
          const recipientId = receipt.recipient === CAPTAIN_KEY ? team.captainSessionId
            : team.members.find(member => member.name === receipt.recipient && member.status !== 'removed' && member.stopping !== true)?.id
          if (!isCaptainRecipient && recipientId !== payload.agent.id) return
          const selected = (await readMailbox(root, team.id, receipt.recipient)).filter(message => batch.ids.has(message.id))
          const current = selected.filter(message => message.readAt === undefined && isCurrentMail(team, message))
          await discardMailboxMessages(root, team.id, receipt.recipient, selected.filter(message => !isCurrentMail(team, message)).map(message => message.id))
          await acknowledgeMailbox(root, team.id, receipt.recipient, current.map(message => message.id))
          batch.current = new Map(current.map(message => [message.id, message]))
        })
      } catch (error: unknown) {
        // Narrow containment, per team: the messages of this batch are not
        // acked (the teamId/recipient above identify the unread mail), but the
        // receipt inputs still pass through untouched instead of holding the
        // host's step admission hostage.
        batch.failed = true
        ctx.logger?.warn(`agent-teams: mailbox admission degraded to plain pass-through for agent ${payload.agent.id}: could not read team "${receipt.teamId}" (state under ${root} may be corrupt or unreadable, recipient ${receipt.recipient} mail left unacked): ${String(error)}`)
      }
    }
    const admitted = []
    for (const { input, receipt, batch } of inputs) {
      if (input.source?.kind === 'subagent-settled' && redundantSettlements.has(input.source.senderSessionId)
        && input.source.summary === `Background subagent ${input.source.senderSessionId} finished and will do no further work unless you send it more.`) continue
      if (receipt === undefined || batch === undefined || batch.failed === true) { admitted.push(input); continue }
      const messages = []
      for (const id of receipt.ids) {
        const message = batch.current.get(id)
        if (message === undefined) continue
        batch.current.delete(id)
        messages.push(message)
      }
      if (messages.length > 0) admitted.push({ ...input, content: [{ type: 'text' as const, text: mailboxBody(receipt.recipient, messages) }] })
    }
    // Reject only a new turn whose sole trigger was obsolete mail. During an
    // existing turn, a status tool may have consumed this same mail already;
    // dropping its duplicate must not block the pending tool-result response.
    if (decision.messages.length > 0 && admitted.length === 0) {
      const events = sessionOwnEvents(payload.agent.session)
      let continuing = false
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i]!
        if (event.type === 'step/start' && event.data.turn === payload.turn) { continuing = true; break }
        if (event.type === 'turn/start') break
      }
      if (!continuing) return { kind: 'reject' }
    }
    return { ...decision, messages: admitted }
  })
}
