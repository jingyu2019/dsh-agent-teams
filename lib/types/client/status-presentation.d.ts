/**
 * Semantic agent-status presentation shared by every AgentTeams role.
 *
 * Lifecycle aggregation is pure and deliberately knows nothing about artwork,
 * member names, or role labels. Renderers consume this stable model so custom
 * visuals can replace the default indicator without changing status meaning.
 * @module dsh-agent-teams/client/status-presentation
 */
import { type ReactNode } from 'react';
import type { AgentTeamsLocaleKey, AgentTeamsTranslate } from './locales.ts';
/** Member lifecycle expressed without raw tool-call or artwork details. */
export type SemanticAgentStatus = 'idle' | 'working' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'unknown';
/** Motion requested by a semantic status. Accessibility may suppress it. */
export type StatusMotion = 'none' | 'pulse';
/** Non-color tone used by status renderers. */
export type StatusTone = 'neutral' | 'active' | 'success' | 'danger';
/** Renderer-independent semantic presentation for one agent status. */
export interface StatusPresentation {
    readonly semantic: SemanticAgentStatus;
    readonly labelKey: AgentTeamsLocaleKey;
    readonly ariaLabelKey: AgentTeamsLocaleKey;
    readonly motion: StatusMotion;
    readonly tone: StatusTone;
}
/** Deterministic lifecycle order used by tests and future themes. */
export declare const STATUS_ORDER: readonly ["idle", "working", "waiting", "completed", "failed", "cancelled", "unknown"];
/** Complete status-to-presentation mapping. */
export declare const STATUS_PRESENTATIONS: {
    readonly idle: {
        readonly semantic: "idle";
        readonly labelKey: "agent.status.idle";
        readonly ariaLabelKey: "agent.status.idle.aria";
        readonly motion: "none";
        readonly tone: "neutral";
    };
    readonly working: {
        readonly semantic: "working";
        readonly labelKey: "agent.status.working";
        readonly ariaLabelKey: "agent.status.working.aria";
        readonly motion: "pulse";
        readonly tone: "active";
    };
    readonly waiting: {
        readonly semantic: "waiting";
        readonly labelKey: "agent.status.waiting";
        readonly ariaLabelKey: "agent.status.waiting.aria";
        readonly motion: "none";
        readonly tone: "neutral";
    };
    readonly completed: {
        readonly semantic: "completed";
        readonly labelKey: "agent.status.completed";
        readonly ariaLabelKey: "agent.status.completed.aria";
        readonly motion: "none";
        readonly tone: "success";
    };
    readonly failed: {
        readonly semantic: "failed";
        readonly labelKey: "agent.status.failed";
        readonly ariaLabelKey: "agent.status.failed.aria";
        readonly motion: "none";
        readonly tone: "danger";
    };
    readonly cancelled: {
        readonly semantic: "cancelled";
        readonly labelKey: "agent.status.cancelled";
        readonly ariaLabelKey: "agent.status.cancelled.aria";
        readonly motion: "none";
        readonly tone: "neutral";
    };
    readonly unknown: {
        readonly semantic: "unknown";
        readonly labelKey: "agent.status.unknown";
        readonly ariaLabelKey: "agent.status.unknown.aria";
        readonly motion: "none";
        readonly tone: "neutral";
    };
};
/** Minimal member fields needed to derive lifecycle meaning. */
export interface SemanticMemberStatusInput {
    readonly name: string;
    readonly activity?: string;
    readonly status?: string;
}
/** Minimal task fields needed to aggregate a member's lifecycle. */
export interface SemanticStatusTask {
    readonly assignee: string;
    readonly status: string;
    readonly state?: string;
}
/** Team-level context that intentionally overrides member-local idle state. */
export interface SemanticStatusContext {
    readonly phase?: 'staged' | 'running';
    readonly halted?: boolean;
    readonly discarded?: boolean;
}
/**
 * Aggregate member/task lifecycle into the stable semantic model.
 *
 * Working is the strongest live signal even when a stale task snapshot still
 * names a terminal state. A stopped/discarded team is cancelled before member
 * detail is considered. Otherwise failed and cancelled terminal sets stay
 * visible instead of collapsing into a generic "settled" state.
 */
export declare function semanticAgentStatus(member: SemanticMemberStatusInput, tasks: readonly SemanticStatusTask[], context?: SemanticStatusContext): SemanticAgentStatus;
/** Resolve the immutable presentation mapped to one semantic status. */
export declare function statusPresentation(semantic: SemanticAgentStatus): StatusPresentation;
/** Runtime motion state after visibility, accessibility, and mount lifecycle. */
export type StatusMotionState = 'none' | 'running' | 'paused' | 'stopped';
/** Browser-independent inputs for motion lifecycle decisions. */
export interface StatusMotionEnvironment {
    readonly mounted: boolean;
    readonly hidden: boolean;
    readonly reducedMotion: boolean;
}
/**
 * Decide whether a status animation may run.
 *
 * Hidden means the panel/tab is not visible; unmount is final and stops the
 * animation entirely. Reduced motion suppresses motion rather than merely
 * pausing it, so the text and glyph remain sufficient.
 */
export declare function statusMotionState(presentation: Pick<StatusPresentation, 'motion'>, environment: StatusMotionEnvironment): StatusMotionState;
/** Resolved inputs supplied to a status renderer for one mounted instance. */
export interface StatusRenderContext {
    readonly t: AgentTeamsTranslate;
    readonly motionState: StatusMotionState;
    readonly className?: string;
    readonly textClassName?: string;
}
/** Replaceable visual contract; lifecycle mapping never depends on it. */
export interface StatusRenderer {
    render(presentation: StatusPresentation, context: StatusRenderContext): ReactNode;
}
/** Non-color glyphs keep every state distinguishable without animation. */
export declare const STATUS_GLYPHS: {
    readonly idle: "○";
    readonly working: "◉";
    readonly waiting: "◷";
    readonly completed: "✓";
    readonly failed: "!";
    readonly cancelled: "×";
    readonly unknown: "?";
};
/**
 * Built-in renderer: stable text plus an explicit screen-reader label.
 *
 * The caller owns classes/DOM placement, while the semantic status, glyph,
 * accessible label, tone, and motion state stay renderer-independent.
 */
export declare const defaultStatusRenderer: StatusRenderer;
