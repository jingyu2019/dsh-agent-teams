/**
 * Durable AgentTeams state types.
 *
 * A team is one directory under the state root holding `team.json` plus an
 * `inbox/` of per-agent JSONL mailboxes. Members are continuable subagents
 * whose durable child session ids are recorded in the team file, so a team
 * survives harness restarts.
 * @module dsh-agent-teams/types
 */

import type { MemberToolFilter } from './tool-policies.ts'

/** Task lifecycle statuses in progression order. */
export type TaskStatus =
  | 'pending'
  | 'claimed'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** Statuses after which a task can no longer be claimed or worked on. */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['completed', 'failed', 'cancelled']

/** Structured quality-gate kind. Absent / unknown values are treated as `work`. */
export type TaskKind =
  | 'requirements'
  | 'implementation'
  | 'verification'
  | 'review'
  | 'repair'
  | 'integration'
  | 'work'

export const TASK_KINDS: readonly TaskKind[] = [
  'requirements',
  'implementation',
  'verification',
  'review',
  'repair',
  'integration',
  'work',
]

/** Review / requirements conclusion. Only `pass` may complete those kinds. */
export type ReviewVerdict = 'pass' | 'needs_revision' | 'reject'

export const REVIEW_VERDICTS: readonly ReviewVerdict[] = ['pass', 'needs_revision', 'reject']

/** Finding severity used by review / requirements output. */
export type FindingSeverity = 'low' | 'medium' | 'high' | 'blocker'

export const FINDING_SEVERITIES: readonly FindingSeverity[] = ['low', 'medium', 'high', 'blocker']

/** One structured review finding. */
export interface ReviewFinding {
  /** Stable id, for example `SEC-001`. */
  id: string
  severity: FindingSeverity
  file?: string
  line?: number
  problem: string
  requiredFix: string
  resolved?: boolean
}

/** One acceptance criterion result recorded at completion. */
export interface AcceptanceResult {
  criterion: string
  status: 'passed' | 'failed'
  evidence?: string
}

/** One verification command result recorded at completion. */
export interface CommandResult {
  command: string
  status: 'passed' | 'failed'
  exitCode?: number
  evidence?: string
}

/**
 * Identity of one workspace path at one instant. A verdict is evidence about a
 * revision, so recording the bytes it judged (not only the task id) lets the
 * delivery check refuse to advertise a revision no review ever saw.
 */
export interface ArtifactDigest {
  /** Workspace-relative POSIX path. */
  path: string
  /** Whether a regular file existed when the digest was taken. */
  present: boolean
  /** Lowercase hex sha256 of the file bytes; absent unless the file was read. */
  sha256?: string
  /** File size in bytes; absent unless the file was read. */
  size?: number
  /** File mtime in epoch ms; lets a legacy record detect a later edit. */
  mtimeMs?: number
  /**
   * The path exists but could not be read or safely resolved (permissions,
   * symlink escaping the workspace, I/O error). Never conflated with "absent":
   * unreadable bytes cannot be claimed as unchanged.
   */
  unreadable?: boolean
  /** Why the path could not be read, when `unreadable` is set. */
  reason?: string
}

/**
 * A declared scope that could not be fully enumerated (file cap reached,
 * unreadable directory, path that is not workspace-relative). Recorded so a
 * partial artifact list is never mistaken for complete coverage.
 */
export interface ArtifactScopeGap {
  /** The pattern or path that could not be fully resolved. */
  pattern: string
  reason: string
}

/** One set of artifact digests captured at a single instant. */
export interface ArtifactSnapshot {
  /** Epoch ms when these bytes were read. */
  at: number
  artifacts: ArtifactDigest[]
  /** Present when the recorded coverage is known to be incomplete. */
  gaps?: ArtifactScopeGap[]
}

/** Profile / team review-loop limits. */
export interface ReviewPolicy {
  requirementsMinRounds?: number
  requirementsMaxRounds?: number
  codeMaxRounds?: number
  maxRepairAttempts?: number
  requiredReviewers?: string[]
}

/** One captain-only contract amendment recorded on a quality task. */
export interface TaskRevision {
  /** Epoch ms when the amendment was applied. */
  at: number
  /** Identity that applied it (`captain`). */
  by: string
  /** Why the previous contract was wrong; kept for the audit trail. */
  reason: string
  /** Amended contract field names (`objective`, `acceptance`, …). */
  fields: string[]
  /** Previous values of the amended fields; fields absent before are omitted. */
  previous: Record<string, unknown>
}

/** Append-only observations; never replace the terminal verdict or unlock a gate. */
export interface TaskEvidence {
  at: number
  by: string
  attempt: number
  attemptId?: string
  note?: string
  acceptanceResults?: AcceptanceResult[]
  commandsRun?: CommandResult[]
}

/** One task of a team's task list. */
export interface TeamTask {
  /** Stable task id from the profile template; absent for ad-hoc tasks. */
  profileSeedId?: string
  /** Stable task id within the team (`t1`, `t2`, …). */
  id: string
  /** Brief title for the task. */
  subject: string
  /** What needs to be done. */
  description?: string
  status: TaskStatus
  /** Member name (or `captain`) the task is assigned to; unassigned tasks await a claim. */
  assignee?: string
  /** Task ids that must reach `completed` before this task can be claimed. */
  dependencies: string[]
  /** The worker's written result, set when the task completes or fails. */
  output?: string
  /** Monotonic execution generation. Reassignment/retry invalidates every older attempt. */
  attempt?: number
  /** Capability for the current claimed/in-progress attempt. Members must present it when updating. */
  attemptId?: string
  /** Opaque generation for a revocation/handoff that has not started its next attempt yet. */
  handoffId?: string
  /** Previous activation retained until a handoff drain succeeds (retryable). */
  handoffFromMemberId?: string
  /** A handoff is quiescing the old owner; the scheduler must not dispatch it yet. */
  reassigning?: boolean
  /** Exact member identity/generation bound to the current attempt. */
  attemptMemberId?: string
  attemptGeneration?: number
  attemptActivationId?: string
  attemptActivationEpoch?: number
  /** Exact completed activation awaiting a captain decision. */
  parking?: TaskParking
  /** Durable ordered route state for this task attempt (issue #76). */
  attemptRoute?: RouteCursor
  /** Durable sparse probe for this exact attempt; absent while probes are disabled. */
  probe?: TaskProbe
  /** Quality-gate kind. Missing values are treated as `work`. */
  kind?: TaskKind
  /** Review / requirements / repair loop index, 1-based when present. */
  round?: number
  verdict?: ReviewVerdict
  findings?: ReviewFinding[]
  objective?: string
  inScope?: string[]
  outOfScope?: string[]
  acceptance?: string[]
  verify?: string[]
  deliverables?: string[]
  nonGoals?: string[]
  changedPaths?: string[]
  acceptanceResults?: AcceptanceResult[]
  commandsRun?: CommandResult[]
  /** Supplemental observations, attributed to their original execution generation. */
  supplementalEvidence?: TaskEvidence[]
  reviewedTaskId?: string
  /** Execution generation of the reviewed task at the moment of judgment. */
  reviewedAttempt?: number
  /**
   * Bytes this verdict judged, read from the workspace when the gate closed.
   * A later edit, deletion or re-attempt invalidates the verdict.
   */
  reviewedArtifacts?: ArtifactDigest[]
  /** Scope of that verdict that could not be fully enumerated, if any. */
  reviewedGaps?: ArtifactScopeGap[]
  /**
   * Scope patterns the verdict bound (e.g. `lib/`). A file that appears under
   * one of them later was never reviewed, so the verdict must not claim it.
   */
  reviewedScope?: string[]
  /**
   * Drift observed while this verdict was being formed (the workspace changed
   * between claim and close). The verdict cannot be read as binding a stable
   * revision.
   */
  reviewedDuringDrift?: string[]
  /**
   * Workspace snapshot taken when this verdict's attempt started, so a close
   * can tell whether it judged a revision that was changing underneath it.
   */
  verdictStartSnapshot?: ArtifactSnapshot
  /**
   * Workspace snapshot an auto-generated contract (acceptance / inScope /
   * verify) was derived from. When a cited artifact changes underneath it the
   * work order is marked stale instead of being read as authoritative.
   */
  contractSnapshot?: ArtifactSnapshot
  /** Repair source: the implementation / previous successful artifact. */
  sourceTaskId?: string
  /**
   * The failed gate task(s) whose findings this repair fixes. Recorded as an
   * explicit causal edge because `dependencies` cannot carry it: a failed task
   * never reaches `completed`, so a dependency on it would make the repair
   * permanently unclaimable. Delivery reads this to tell a closed loop from
   * genuinely unresolved work (issue #175A).
   */
  findingSourceTaskIds?: string[]
  sourceFindingIds?: string[]
  /** User-constraint / goal items this task claims to cover. */
  coverageOf?: string[]
  /** Captain-only contract amendments, oldest first (see amendTaskContract). */
  revisions?: TaskRevision[]
  createdAt: number
  updatedAt: number
}

/** Honest host-owned context lifecycle capability for one durable member. */
export type ContextLifecycleState = 'observed' | 'unavailable' | 'unproven'

/** Host composition marker used to distinguish explicit minimal builds. */
export type ContextLifecycleComposition = 'standard' | 'minimal' | 'unknown'

/** Host-owned context compaction observation. AgentTeams never fabricates a compactor. */
export interface ContextLifecycleCapability {
  state: ContextLifecycleState
  hostVersion?: string
  composition?: ContextLifecycleComposition
  observedEvent?: 'compaction/start' | 'compaction/end'
  observedAt?: number
  lastCompactionError?: string
  source: 'session-event' | 'verified-matrix' | 'none'
  notes?: string
  /** Exact child/session identity that produced the last observed event. */
  memberId?: string
  memberGeneration?: number
  activationId?: string
  activationEpoch?: number
  /** `compaction/prune` is observed but is never proof of a successful compaction. */
  lastEvent?: 'compaction/start' | 'compaction/end' | 'compaction/end.error' | 'compaction/prune'
  pruneObservedAt?: number
}

/** Durable sparse probe bound to one task activation/attempt. */
export interface TaskProbe {
  activationId: string
  memberGeneration: number
  activationEpoch: number
  attemptId: string
  nextProbeAt: number
  probeCount: number
  armedAt: number
  lastProbeAt?: number
  /** What the last due probe did; ledger-only is mandatory for a parked attempt. */
  lastProbeAction?: 'silent-kick' | 'ledger-only'
}

/** Why one managed subagent activation exists. */
export type ActivationPurpose = 'bootstrap' | 'task' | 'mailbox'

/** Durable state of one managed activation. */
export type ActivationState =
  | 'pending'
  | 'started'
  | 'ended'
  | 'rejected'
  | 'recovering'
  | 'orphaned'
  | 'released'

/** Canonical terminal reasons exposed by the subagent lifecycle. */
export type ActivationStopReason = 'completed' | 'max-tokens' | 'aborted' | 'error' | 'refusal' | 'unknown'

/** One exact managed activation and its durable settlement authority. */
export interface ActivationLease {
  activationId: string
  /** Whether this lease came from a managed startActivation host. */
  managed?: boolean
  dispatchToken: string
  teamId: string
  memberId: string
  memberGeneration: number
  activationEpoch: number
  purpose: ActivationPurpose
  taskId?: string
  attempt?: number
  attemptId?: string
  hostRunId?: string
  hostMessageId?: string
  /** Inclusive half-open session-log offset captured before host delivery. */
  preDispatchSessionSeq: number
  startObserved: boolean
  /** Epoch ms when an unmanaged host's live Agent was first observed running for this lease. */
  runningObservedAt?: number
  endObserved: boolean
  settlementApplied?: boolean
  promptCommittedAt?: number
  turnStartObservedSeq?: number
  turnEndObserved?: { reason: string; seq?: number }
  recoveryDecision?: 'none' | 'rolled_back' | 'synthesized_end' | 'orphaned_parked'
  state: ActivationState
  permitHeld: boolean
  createdAt: number
  startedAt?: number
  endedAt?: number
  releasedAt?: number
  stopReason?: ActivationStopReason
  lastAssistantMessage?: string
  diagnostic?: string
}

/** Durable captain notification outbox entry for parking/failure notices. */
export interface NotificationLedgerEntry {
  id: string
  messageId: string
  teamId: string
  memberId: string
  memberGeneration: number
  activationId: string
  taskId?: string
  attemptId?: string
  kind: 'parked' | 'failed' | 'settlement_unknown'
  content: string
  state: 'pending' | 'appended' | 'delivered' | 'read' | 'superseded'
  noticeDueAt: number
  createdAt: number
  appendedAt?: number
  deliveredAt?: number
}

/** Durable parking marker on an open task whose exact activation ended. */
export interface TaskParking {
  memberId: string
  memberGeneration: number
  activationId: string
  activationEpoch: number
  attemptId: string
  noticeDueAt: number
  noticeKey: string
}

/** Failure classes used by the durable per-attempt route cursor. */
export type RouteFailureClass = 'transient' | 'permanent' | 'unknown' | 'budget'

/** Per-attempt ordered fallback/cooldown state; never shared across attempts. */
export interface RouteCursor {
  routeGeneration: number
  currentRouteIndex: number
  routeAttempts: number[]
  cooldowns: Array<{ routeIndex: number; until: number; reason: string }>
  state: 'ready' | 'waiting' | 'exhausted'
  nextActionAt?: number
  lastFailure?: {
    activationId: string
    hostRunId: string
    code: string
    class: RouteFailureClass
    at: number
  }
}

/** Member lifecycle status. */
export type MemberStatus = 'idle' | 'working' | 'removed'

/** One team member: a continuable subagent plus its team-side record. */
export interface TeamMember {
  /** Durable continuable subagent session id (empty until spawned). */
  id: string
  /** Unique display name inside the team. */
  name: string
  /** Role description, e.g. `researcher`, `engineer`, `reviewer`. */
  role?: string
  /** Resolved LLM provider route captured when this member was created. */
  provider?: string
  /** Resolved model captured when this member was created. */
  model?: string
  /** Resolved reasoning effort captured from the captain or target model default. */
  reasoningEffort?: string
  /** Prompt specific to this member's execution turns. */
  executionPrompt?: string
  /** Configured second-choice route. */
  fallback?: TeamModelFallback
  /** Ordered additional routes after the primary; legacy `fallback` is route 1. */
  fallbacks?: TeamModelFallback[]
  /** Active route after fallback, without changing the primary descriptor route. */
  activeProvider?: string
  activeModel?: string
  /** Whether the fallback route is currently active. */
  fallbackActive?: boolean
  /**
   * Owner-declared tool-policy id this member selected (`#59`), absent for a
   * member without a policy (the unchanged default behavior). The Captain
   * model may only select a configured id; it never submits raw tool lists.
   */
  toolPolicy?: string
  /**
   * The immutable effective tool filter resolved when the member was created
   * and handed to the child's `toolFilter`. `team.json` keeps it for audit,
   * status, and recovery diagnostics; the continuable descriptor remains the
   * authority that reapplies the filter to a cold-resumed child.
   */
  toolFilter?: MemberToolFilter
  /** Exact child-scoped setup restored on hosts with managed activations. */
  runtimeSetup?: { persona: string; toolFilter: MemberToolFilter }
  joinedAt: number
  status: MemberStatus
  /** Monotonic execution generation; legacy members normalize to 1 in memory. */
  generation?: number
  /** Latest exact activation assigned to this member. */
  currentActivationId?: string
  /** Last host-owned compaction observation for this child session. */
  contextLifecycle?: ContextLifecycleCapability
  lastActivationEpoch?: number
  /** Execution admission is closed while a failed/pending handoff is drained. */
  stopping?: boolean
  /**
   * Last member-start failure, recorded so the captain can see why a member
   * never acquired a session instead of observing an unexplained `unspawned`
   * member. Cleared by the next successful start.
   */
  spawnError?: string
  /** Owner-declared skill ids selected for this member, in stable order (#244). */
  skills?: string[]
  /** SHA-256 of the exact resolved owner skill prompt frozen at member creation. */
  skillPromptSha256?: string
}

/** One mailbox message. */
export interface TeamMessage {
  id: string
  /** `captain` or a member name. */
  from: string
  /** `captain` or a member name. */
  to: string
  content: string
  ts: number
  /** Process-local delivery lease; prevents fallback and direct delivery racing. */
  deliveryClaimedAt?: number
  /** Set after the durable message was accepted by the recipient's live Harness inbox. */
  deliveredAt?: number
  /** Set once the recipient has consumed or been shown the durable fallback. */
  readAt?: number
  /** Guidance is scoped to the recipient's execution generation, when present. */
  taskId?: string
  attemptId?: string
  /** Source execution generation, independent of the recipient guidance generation. */
  sourceTaskId?: string
  sourceAttemptId?: string
  sourceTaskStatus?: TaskStatus
  /** Cancelled delivery is retained for audit but must not wake the recipient. */
  discardedAt?: number
  /** Omitted means progress; only an exact final can suppress native settlement. */
  reportKind?: 'progress' | 'final'
  /** Exact member generation/activation that authored a task report. */
  sourceMemberId?: string
  sourceMemberGeneration?: number
  sourceActivationId?: string
  sourceActivationEpoch?: number
}

/** Snapshot of the named profile used to seed a team. */
export interface TeamModelFallback {
  provider: string
  model: string
}

export interface TeamProfileSnapshot {
  name: string
  description?: string
  protocol?: string
  executionPrompt?: string
  fallback?: TeamModelFallback
  /** Ordered additional routes after the primary; legacy `fallback` is route 1. */
  fallbacks?: TeamModelFallback[]
  /** Frozen planning mode: captain plans the graph; seed keeps template tasks. */
  taskPlanning?: 'captain' | 'seed'
  /** Frozen review-loop policy from the creating profile. */
  reviewPolicy?: ReviewPolicy
}

/** The full durable team record. */
export interface TeamState {
  /** Original team name. */
  name: string
  /** Sanitized directory id; the team's stable identity. */
  id: string
  /** Team purpose/goal. */
  description?: string
  /** Immutable named profile snapshot, when created from a profile. */
  profile?: TeamProfileSnapshot
  /** Session id of the captain agent that owns this team. */
  captainSessionId: string
  createdAt: number
  /** Teammates only; the captain is implicit (the owning session). */
  members: TeamMember[]
  tasks: TeamTask[]
  /** Monotonic task id counter. */
  taskSeq: number
  /**
   * Two-phase execution lifecycle. Missing means `running` for durable
   * compatibility with teams created before staging existed.
   */
  phase?: 'staged' | 'running'
  /**
   * Human-facing review sub-state while `phase` is `staged`. Missing staged
   * records are treated as `awaiting_review` for backward compatibility.
   * `awaiting_feedback` means the user returned to chat and the Captain must
   * ask what should change before editing this same draft.
   */
  planReviewState?: 'awaiting_review' | 'awaiting_feedback'
  /** Timestamp written only after a staged plan is explicitly approved. */
  approvedAt?: number
  /**
   * Human halt from the captain chat. The team remains on disk, members stay
   * available, and unfinished work is cancelled until the captain resumes.
   */
  halted?: boolean
  /** Timestamp of the latest human halt, when present. */
  haltedAt?: number
  /** Review-loop policy snapshot copied from the creating profile, when present. */
  reviewPolicy?: ReviewPolicy
  /** Set when an automatic review/repair loop hits its configured ceiling. */
  escalated?: boolean
  /** Monotonic activation epoch allocator. */
  activationSeq?: number
  /** Active plus bounded recent exact activation leases. */
  activations?: ActivationLease[]
  /** Monotonic notification outbox sequence. */
  notificationSeq?: number
  /** Durable parking/failure notice outbox. */
  notifications?: NotificationLedgerEntry[]
  /** Durable deterministic collect/join barriers (#195), bounded by recent use. */
  joinBarriers?: JoinBarrier[]
}

/** One durable collect barrier: the ordered tasks and delivery dedupe identity. */
export interface JoinBarrier {
  /** Stable identity derived from the ordered task ids. */
  key: string
  taskIds: string[]
  digest: 'none' | 'extractive'
  /** True when the ids were captured because collect omitted task_ids. */
  allTasks?: boolean
  notifiedAt?: number
  messageId?: string
}
