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
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { type MemberStartResult } from './harness-compat.ts';
import type { ActivationLease, TeamTask } from './types.ts';
/** Per-dependency output cap in the assignment prompt. */
export declare const DEPENDENCY_OUTPUT_MAX_CHARS = 2000;
/** Combined dependency-output budget in the assignment prompt. */
export declare const DEPENDENCY_OUTPUTS_TOTAL_MAX_CHARS = 12000;
export interface DispatchRequest {
    readonly attemptId?: string;
    readonly activationId?: string;
    readonly dispatchToken?: string;
    readonly newChild: boolean;
    readonly reservedChildId: string;
}
export interface DispatchResult {
    readonly accepted: boolean;
    readonly receipt?: MemberStartResult;
}
export type MailboxActivationDecision = 'allocate' | 'reuse' | 'wait';
/** Decide whether a mailbox wake may start a new run for this child. */
export declare function mailboxActivationDecision(leases: readonly ActivationLease[], memberId: string, liveRunning: boolean): MailboxActivationDecision;
export interface SchedulerConfig {
    readonly stateDir: string;
    readonly executionPrompt?: string;
    /** Global cap on active activation permits; undefined preserves legacy unbounded scheduling. */
    readonly maxConcurrentWorkers?: number;
    /** Prompt-only opt-in for multiple AgentTeams calls in one response. */
    readonly parallelToolCalls?: boolean;
    readonly dispatch?: (captain: Agent, teamId: string, memberName: string, text: string, signal: AbortSignal, mode: 'queue' | 'steer', request?: DispatchRequest) => Promise<boolean | DispatchResult>;
}
/** Count permits that still pin a managed activation. */
export declare function activePermitCount(leases: readonly Pick<ActivationLease, 'permitHeld'>[]): number;
/** Whether one more activation may acquire a global permit. */
export declare function canAcquireActivationPermit(leases: readonly Pick<ActivationLease, 'permitHeld'>[], maxConcurrentWorkers: number | undefined): boolean;
/** Legacy hosts have no lifecycle lease ledger; open task rows are their permits. */
export declare function activeUnmanagedTaskCount(tasks: readonly Pick<TeamTask, 'status'>[]): number;
export declare function canAcquireUnmanagedPermit(tasks: readonly Pick<TeamTask, 'status'>[], maxConcurrentWorkers: number | undefined): boolean;
export interface TeamScheduler {
    /** Try to give every genuinely idle/ready member one unit of ready work. */
    kickTeam(workspace: string, teamId: string, captain?: Agent): Promise<void>;
    /** Try to flush fallback mail or give one member one ready task. */
    kickMember(workspace: string, teamId: string, memberName: string, captain?: Agent): Promise<void>;
}
/** One completed recursive dependency shown to the assignee. */
export interface DependencyOutput {
    readonly id: string;
    readonly subject: string;
    readonly profileSeedId?: string;
    readonly output?: string;
}
export interface DispatchTicket {
    readonly taskId: string;
    readonly memberName: string;
    readonly memberId: string;
    readonly attempt: number;
    readonly attemptId: string;
    readonly activationId: string;
    readonly dispatchToken: string;
    readonly newChild: boolean;
    readonly preDispatchSessionSeq: number;
    readonly previousAssignee?: string;
    /** True when this ticket rotates an unobserved durable open attempt. */
    readonly recoveredOwned: boolean;
    /** True when this ticket resumes a persisted route cursor without rotating the attempt. */
    readonly routeRetry: boolean;
    /** Original task generation, used to restore a failed automatic recovery. */
    readonly previousStatus?: 'claimed' | 'in_progress';
    readonly previousAttempt?: number;
    readonly previousAttemptId?: string;
    readonly previousResult?: Pick<TeamTask, 'output' | 'verdict' | 'findings' | 'changedPaths' | 'acceptanceResults' | 'commandsRun'>;
    readonly subject: string;
    readonly description?: string;
    readonly teamDescription?: string;
    readonly profileProtocol?: string;
    readonly profileSeedId?: string;
    readonly dependencyOutputs: readonly DependencyOutput[];
    readonly routeIndex?: number;
    readonly executionPrompt?: string;
    readonly kind?: string;
    readonly round?: number;
    readonly objective?: string;
    readonly inScope?: readonly string[];
    readonly outOfScope?: readonly string[];
    readonly acceptance?: readonly string[];
    readonly verify?: readonly string[];
    readonly reviewedTaskId?: string;
    readonly findingSourceTaskIds?: readonly string[];
}
/**
 * Recursively collect `status=completed` ancestors of `taskId` in topological
 * order (dependencies before dependents). Cycles stop that branch only.
 */
export declare function collectCompletedDependencyOutputs(tasks: readonly TeamTask[], taskId: string, warn?: (message: string) => void): DependencyOutput[];
/** Format completed-dependency outputs with per-item and total truncation. */
export declare function formatDependencyOutputs(items: readonly DependencyOutput[]): string;
export declare function assignmentPrompt(ticket: DispatchTicket, stateDir: string, teamId: string, workOrderWarnings?: readonly string[], parallelToolCalls?: boolean): string;
/** Install one scheduler and its member activity observer. */
export declare function installTeamScheduler(ctx: Context, config: SchedulerConfig): TeamScheduler;
