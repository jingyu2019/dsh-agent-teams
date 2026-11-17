/**
 * The `agent_teams_*` model-facing tools.
 *
 * The captain (the agent that created the team) orchestrates: members are
 * continuable subagents it spawns and wakes. Members share the same tools and
 * drive their own task state, mirroring the Claude Code AgentTeams flow:
 * create team → add members → create tasks with dependencies → claim/assign →
 * work → report → status → delete.
 * @module dsh-agent-teams/tools
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import { type MemberToolPolicy } from './tool-policies.ts';
import type { ArtifactRootConfig, ArtifactSnapshot, MessageIdempotencyRecord } from './types.ts';
import { type MemberRuntimeConfig } from './members.ts';
import { type ActivationLease, type TeamMember, type TeamMessage, type TeamState, type TeamTask } from './types.ts';
import { type TeamScheduler } from './scheduler.ts';
import { type SkillBindingConfig } from './profiles.ts';
export { steerCaptainReport } from './members.ts';
/** Resolved plugin config consumed by the tools. */
export interface ToolsConfig {
    /** State directory name under the captain's workspace. */
    stateDir: string;
    /** Member subagent provider name. */
    memberProvider: string;
    /** Optional member model override. */
    memberModel?: string;
    /** Optional member LLM provider, paired with `memberModel` (issue #189). */
    memberLlmProvider?: string;
    /** Prompt injected into member personas and assignments. */
    executionPrompt?: string;
    /** Plugin fallback route. */
    fallback?: import('./profiles.ts').TeamModelFallbackConfig;
    /** Ordered additional member routes. */
    fallbacks?: import('./profiles.ts').TeamModelFallbackConfig[];
    /** Member delegation depth cap. */
    memberMaxDepth?: number;
    /** Team size cap (members). */
    maxMembers: number;
    /** Global cap on simultaneous activation permits (defaults to maxMembers). */
    maxConcurrentWorkers?: number;
    /** Sparse probe cadence; zero/absent disables probes. */
    probeIntervalMs?: number;
    /** Whether prompts may explicitly permit several AgentTeams calls per response. */
    parallelToolCalls?: boolean;
    /** Stable core/captain tool surface for token-sensitive sessions (#96). */
    toolSurface?: 'full' | 'core';
    /** Named team profiles from the active DSH profile. */
    profiles: Record<string, import('./profiles.ts').TeamProfileConfig>;
    /** Owner-declared reusable member tool policies, keyed by policy id (#59). */
    toolPolicies: Record<string, MemberToolPolicy>;
    /** Owner-declared skill snippets selected by id (#244). */
    skills?: Record<string, SkillBindingConfig>;
    /** Owner-configured local roots for captain attachments (#70). */
    artifactRoots?: ArtifactRootConfig[];
    /** Opt-in immutable global agent preset library (#315). */
    agentLibrary?: {
        enabled: boolean;
    };
    /** Opt-in member-lane worktree isolation (#287). */
    worktrees?: import('./worktrees.ts').WorktreeConfig;
}
/** Browser/UI mutations allowed while a plan is waiting for approval. */
export type StagedPlanMutation = {
    action: 'update_member';
    memberName: string;
    /** Staged-only replacement display name; all staged references move atomically. */
    newName?: string;
    role?: string | null;
    provider: string;
    model: string;
    reasoningEffort?: string | null;
    executionPrompt?: string | null;
    /** Selected tool-policy id; an empty string clears it back to no policy. */
    toolPolicy?: string;
} | {
    action: 'update_task';
    taskId: string;
    subject: string;
    description?: string | null;
    assignee?: string | null;
    dependencies: string[];
    /** Optional optimistic lock: refuse the edit when the task moved on. */
    expectedRevision?: number;
    /** Send this task into a fresh member conversation when it is dispatched. */
    freshContext?: boolean;
} | {
    action: 'add_task';
    subject: string;
    description?: string | null;
    assignee?: string | null;
    dependencies: string[];
} | {
    action: 'remove_task';
    taskId: string;
} | {
    action: 'remove_member';
    memberName: string;
};
/** Browser-authored staged team inputs (#279). Every member/task is persisted before approval. */
export interface ManualStagedTeamInput {
    name: string;
    description?: string;
    members: Array<{
        name: string;
        role?: string;
        provider?: string;
        model?: string;
        reasoning_effort?: string;
        executionPrompt?: string;
        tool_policy?: string;
        skills?: string[];
        preset_id?: string;
    }>;
    tasks?: Array<{
        subject: string;
        description?: string;
        assignee?: string;
        dependencies?: string[];
    }>;
}
/** One member route change requested by a tool call or the activity panel. */
export interface MemberRouteInput {
    readonly memberName: string;
    readonly provider?: string;
    readonly model?: string;
    readonly reasoningEffort?: string;
}
/** The route a member will use on its next turn. */
export interface MemberRouteResult {
    readonly member_name: string;
    readonly provider: string;
    readonly model: string;
    readonly reasoning_effort?: string;
}
/** Runtime bridge shared by model-facing tools and the Web staging surface. */
export interface AgentTeamsRuntime {
    isPendingMember(agent: Agent): boolean;
    updateStagedPlan(captain: Agent, teamId: string, mutation: StagedPlanMutation, signal?: AbortSignal): Promise<TeamState>;
    updateStagedPlanBatch(captain: Agent, teamId: string, mutations: readonly StagedPlanMutation[], signal?: AbortSignal): Promise<TeamState>;
    createStagedTeam(captain: Agent, input: ManualStagedTeamInput, signal?: AbortSignal): Promise<TeamState>;
    approveStagedTeam(captain: Agent, teamId: string, signal?: AbortSignal): Promise<{
        teamId: string;
        members: number;
        tasks: number;
    }>;
    continueStagedPlanning(captain: Agent, teamId: string): Promise<{
        teamId: string;
        alreadyWaiting: boolean;
    }>;
    discardStagedTeam(captain: Agent, teamId: string): Promise<{
        teamId: string;
    }>;
    /** Change one idle running-team member's primary route (tool + panel share this). */
    updateMemberRoute(captain: Agent, teamId: string, input: MemberRouteInput, signal?: AbortSignal): Promise<MemberRouteResult>;
    memoryDiagnostics(): ReturnType<TeamScheduler['diagnostics']> & {
        ancestryCache: number;
    };
}
/**
 * Replace one member's child context while its team lock is held. The tool and
 * the automatic dead-session recovery share this single path so the guard set
 * (running member, open attempt, active activation) can never drift into a
 * looser copy: a refusal is the caller's failure, never something to route
 * around.
 * @param input - freshly read team state, state root, member name and the
 *   timeline reason to record (omitted for an explicit captain reset).
 * @returns the tool-facing result; `reset` is false when there was no context.
 */
export declare function resetMemberContextLocked(input: {
    readonly team: TeamState;
    readonly stateRoot: string;
    readonly memberName: string;
    readonly reason?: string;
}): Promise<{
    member_name: string;
    reset: boolean;
    previous_member_id?: string;
}>;
/** Timeline reason recorded when a refused delivery resets a member automatically. */
export declare const AUTO_RESET_REASON = "automatic recovery: the member session was gone";
/** Why a refused delivery happened, as far as the plugin can tell it apart. */
export type DeliveryFailureCause = 'retired' | 'lost-session';
/** What {@link recoverLostSessionDelivery} did with one refused delivery. */
export interface DeadSessionRecoveryOutcome {
    readonly accepted: boolean;
    /** Whether the second delivery ran; false when the guarded reset refused. */
    readonly retried: boolean;
    /** Annotated reason to record when the reset itself was refused. */
    readonly deliveryFailure?: string;
}
/**
 * Retry one refused delivery after automatically resetting the member context.
 * A retired member was stopped by a human and stays refused with its existing
 * wording. Any other refusal is retried exactly once through the caller's
 * guarded reset; when that guard refuses, its own message becomes the recorded
 * reason instead of being bypassed.
 * @param input - the failed cause, its reason, and the two injected operations.
 * @returns the outcome; the caller owns durable failure recording.
 */
export declare function recoverLostSessionDelivery(input: {
    readonly cause: DeliveryFailureCause;
    readonly failure: string;
    readonly reset: () => Promise<unknown>;
    readonly retry: () => Promise<boolean>;
}): Promise<DeadSessionRecoveryOutcome>;
/** Why an automatic dispatch-path reset could not run, as far as it can be told apart. */
export type DispatchResetRefusal = 'retired' | 'open-attempt' | 'session-alive';
/**
 * Why a dead-session dispatch refused to reset the member. Each cause names its
 * own exit: a retired member must not be resurrected, an attempt that could not
 * be reclaimed has to be closed by hand, and a live session needs no reset.
 * @param memberName - the member whose turn never started.
 * @param reason - which refusal happened.
 * @returns the captain-facing explanation.
 */
export declare function dispatchResetFailure(memberName: string, reason: DispatchResetRefusal): string;
/** What {@link reclaimDeadSessionDelivery} cleared before an automatic reset. */
export interface DeadSessionReclaim {
    /** Task ids whose open attempt was closed as failed. */
    readonly closedAttempts: readonly string[];
    /** Activation ids whose lease was ended without a host settlement. */
    readonly releasedLeases: readonly string[];
    /** The member was retired by a human, so nothing was touched. */
    readonly retired: boolean;
    /** The child session is alive, so nothing was touched. */
    readonly live: boolean;
    /** Open attempts still owned afterwards; a positive count refuses the reset. */
    readonly remainingOpenAttempts: number;
    /** Active leases still held afterwards; a positive count refuses the reset. */
    readonly activeLeases: number;
}
/**
 * Clear the wreckage a dead child session leaves behind on the dispatch path
 * before the shared reset can run: the member's open attempt is closed as failed
 * with the delivery failure as its output, and the lease it holds is ended with
 * its permit released. This is a cleanup, not a loosened guard — a member that
 * still owns anything open after this refuses the reset exactly as before.
 * @param input - fresh team state (mutated in place), state root, member name,
 *   the delivery failure to record, and whether the host still reports the child
 *   session as running (a live session is never reclaimed).
 * @returns what was cleared and what is still open.
 */
export declare function reclaimDeadSessionDelivery(input: {
    readonly team: TeamState;
    readonly stateRoot: string;
    readonly memberName: string;
    readonly failure: string;
    readonly sessionRunning?: boolean;
}): Promise<DeadSessionReclaim>;
/**
 * Consecutive member-start failures tolerated before dispatch pauses for that
 * member. The scheduler treats a rejected dispatch as "not now" and retries, so
 * without a bound a permanently broken member retries every pass and inflates
 * its attempt counter with no visible cause (#350).
 */
export declare function memberSpawnFailureLimit(): number;
/**
 * Whether dispatch must pause for a member that keeps failing to start. The
 * scheduler treats a rejected dispatch as "not now" and retries, so an unbounded
 * member spins forever and inflates its attempt counter (#350).
 */
export declare function memberDispatchPaused(spawnFailures: number | undefined, limit?: number): boolean;
/**
 * Why a delivery to a retired member was refused. The host folds every terminal
 * session state into one `NOT_RESUMABLE` code, so the plugin names the cause it
 * owns instead of letting both collapse into one message.
 */
export declare function retiredMemberDeliveryFailure(memberName: string): string;
/**
 * Why a delivery to a member without a resumable session was refused.
 * @param spawnError - why starting the member failed earlier, if it did.
 * @param hostError - the host's own refusal text for this delivery. It carries
 *   the real cause behind the folded `NOT_RESUMABLE` code, so it is recorded
 *   with the reason instead of only being logged.
 */
export declare function lostSessionDeliveryFailure(memberName: string, spawnError: string | undefined, hostError?: string): string;
/**
 * Why a member route change was refused because the team is not running yet.
 *
 * A route edit only makes sense against a live roster: staged members are still
 * being planned (the staged editor owns them) and a halted team has frozen
 * dispatch. Both messages name the exit instead of leaving the caller to guess.
 */
export declare function memberRouteNotRunningFailure(teamName: string, state: 'staged' | 'halted'): string;
/**
 * Why a member route change was refused while the member still owns an open
 * task. The route would otherwise change mid-attempt, and the attempt's model
 * would disagree with the record it reports against.
 */
export declare function memberRouteOpenAttemptFailure(memberName: string, taskId: string): string;
/**
 * Why a member route change was refused while the member is running a turn.
 * A live turn already resolved its model, so the new route could only apply to
 * the next turn; changing it under the turn would make the badge lie.
 */
export declare function memberRouteBusyFailure(memberName: string): string;
/**
 * Whether a member record proves that a child session actually started.
 *
 * `member.id` is the *reserved* child id: the scheduler writes it before asking
 * the host to start the session (#350), so a non-empty id is not evidence. The
 * activation lease is: `pending` with no start/running observation means the
 * host never got as far as a session. `rejected` is the same story one step
 * further along — the dispatch was refused, so that lease proves the opposite of
 * a start. Counting it as evidence is what let a member replay "no resumable
 * session" forever with no `spawnError` recorded and the breaker never tripping.
 * Without any lease for the member the id predates managed activations, and the
 * strict reading is kept.
 */
export declare function startedSessionEvidence(team: {
    activations?: ActivationLease[];
}, member: TeamMember): boolean;
export declare function requireStagedTeam(team: TeamState, operation: string): void;
/** Public schema guidance shared by every tool-policy selection surface. */
export declare const TOOL_POLICY_DESCRIPTION = "Optional owner-declared tool-policy id. Omit when no policy is needed. Never invent an id; an unknown non-empty id is rejected atomically.";
/**
 * Declared shape of one `agent_teams_create` `plan.members[]` entry. Exported
 * as a module constant so tests can assert the schema itself: a field missing
 * here is silently dropped before validation (upstream #352 lost
 * `executionPrompt` that way), which no source-text grep can catch.
 */
export declare const planMemberSchema: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly properties: {
        readonly name: {
            readonly type: "string";
            readonly required: true;
        };
        readonly role: {
            readonly type: "string";
        };
        readonly provider: {
            readonly type: "string";
        };
        readonly model: {
            readonly type: "string";
        };
        readonly reasoning_effort: {
            readonly type: "string";
        };
        readonly tool_policy: {
            readonly type: "string";
            readonly description: "Optional owner-declared tool-policy id. Omit when no policy is needed. Never invent an id; an unknown non-empty id is rejected atomically.";
        };
        readonly skills: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
            readonly description: "Optional owner-declared skill ids; unknown ids fail before persistence.";
        };
        readonly preset_id: {
            readonly type: "string";
            readonly description: "Optional immutable global agent preset id; its settings are copied into this plan member.";
        };
        readonly executionPrompt: {
            readonly type: "string";
            readonly description: "Optional member-specific execution prompt. It remains editable while staged.";
        };
    };
};
/**
 * Normalize a tool-policy selection from runtime input. Tool gateways may
 * materialize omitted optional strings as empty or whitespace-only values;
 * those mean "no policy". A non-string runtime value is also treated as
 * omitted because the public schema only accepts strings.
 */
export declare function optionalToolPolicyId(value: unknown): string | undefined;
/** Drop undefined values and duplicate strings while preserving first-seen order. */
export declare function orderedUniqueStrings(values: readonly (string | undefined)[]): string[];
export declare function haltTeamWork(input: {
    ctx: Context;
    stateRoot: string;
    teamId: string;
    captain: Agent;
    signal?: AbortSignal;
}): Promise<{
    teamName: string;
    captainSessionId: string;
    cancelledTasks: number;
    alreadyHalted: boolean;
}>;
/** Web approval has no tool result in the captain's conversation. */
export declare function stagedPlanApprovedContext(teamName: string): string;
/** Context queued after the human rejects a staged plan. */
export declare function stagedPlanDiscardContext(teamName: string): string;
/** Model-facing continuation that turns the review UI back into a conversation. */
export declare function stagedPlanFeedbackContext(teamName: string): string;
/**
 * How long one caller-declared send key keeps replaying its first delivery.
 * The record is pruned on the next keyed send, so the window is a bound, not a
 * promise that every key is remembered for the full day.
 */
export declare const MESSAGE_KEY_WINDOW_MS: number;
/** Idempotency records retained per team; the oldest expire first. */
export declare const MESSAGE_KEY_CAP = 512;
/**
 * Window in which the pair's messages are counted for the ping-pong ceiling:
 * long enough to catch a mutual reply loop, short enough to leave ordinary
 * long-running coordination legal.
 */
export declare const PINGPONG_WINDOW_MS: number;
/**
 * Messages one member↔captain pair may exchange inside {@link PINGPONG_WINDOW_MS}
 * before further sends are refused. Overridable through
 * `AGENT_TEAMS_PINGPONG_MESSAGE_LIMIT`.
 * @returns the positive configured limit, or 12.
 */
export declare function pingPongMessageLimit(): number;
/** The explicit refusal text for a suspected member↔captain message ping-pong. */
export declare function pingPongFailure(from: string, to: string, exchanged: number, limit?: number): string;
/**
 * The first delivery recorded for one caller-declared key inside its window.
 * @returns the live record, or undefined once it expired.
 */
export declare function findMessageKey(team: TeamState, from: string, to: string, key: string, now?: number): MessageIdempotencyRecord | undefined;
/**
 * Record one first delivery and drop expired records plus any earlier record
 * for the same key, so the retained map stays bounded.
 */
export declare function recordMessageKey(team: TeamState, record: MessageIdempotencyRecord, now?: number): void;
/** Count one pair's messages inside the ping-pong window, both directions. */
export declare function countPingPongMessages(messages: readonly TeamMessage[], from: string, to: string, now?: number): number;
/**
 * Register every `agent_teams_*` tool into the shared tools registry.
 * @param ctx - the plugin context (injects `tools`).
 * @param config - resolved tool config.
 */
export declare function registerAgentTeamsTools(ctx: Context, config: ToolsConfig): AgentTeamsRuntime;
export declare function applyQualityFollowUp(team: TeamState, closed: TeamTask, snapshotPaths?: (paths: readonly string[]) => ArtifactSnapshot, pathExists?: (path: string) => boolean): {
    created: TeamTask[];
    escalated: boolean;
    reason?: string;
    excludedFindings?: string[];
};
/** Build the scheduler config through one testable production seam. */
export declare function schedulerRuntimeConfig(config: ToolsConfig, dispatch: import('./scheduler.ts').SchedulerConfig['dispatch']): import('./scheduler.ts').SchedulerConfig;
/** Build the `memberRuntime` config handed to member helpers. */
export declare function memberRuntime(config: ToolsConfig): MemberRuntimeConfig;
/** Render the status snapshot as compact text for the model. */
export declare function renderStatus(value: JsonValue): string;
