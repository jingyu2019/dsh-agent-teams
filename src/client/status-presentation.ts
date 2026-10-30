/**
 * Semantic agent-status presentation shared by every AgentTeams role.
 *
 * Lifecycle aggregation is pure and deliberately knows nothing about artwork,
 * member names, or role labels. Renderers consume this stable model so custom
 * visuals can replace the default indicator without changing status meaning.
 * @module dsh-agent-teams/client/status-presentation
 */
import { createElement, type ReactNode } from 'react'
import type { AgentTeamsLocaleKey, AgentTeamsTranslate } from './locales.ts'

/** Member lifecycle expressed without raw tool-call or artwork details. */
export type SemanticAgentStatus =
  | 'idle'
  | 'working'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown'

/** Motion requested by a semantic status. Accessibility may suppress it. */
export type StatusMotion = 'none' | 'pulse'

/** Non-color tone used by status renderers. */
export type StatusTone = 'neutral' | 'active' | 'success' | 'danger'

/** Renderer-independent semantic presentation for one agent status. */
export interface StatusPresentation {
  readonly semantic: SemanticAgentStatus
  readonly labelKey: AgentTeamsLocaleKey
  readonly ariaLabelKey: AgentTeamsLocaleKey
  readonly motion: StatusMotion
  readonly tone: StatusTone
}

/** Deterministic lifecycle order used by tests and future themes. */
export const STATUS_ORDER = [
  'idle',
  'working',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'unknown',
] as const satisfies readonly SemanticAgentStatus[]

/** Complete status-to-presentation mapping. */
export const STATUS_PRESENTATIONS = {
  idle: {
    semantic: 'idle',
    labelKey: 'agent.status.idle',
    ariaLabelKey: 'agent.status.idle.aria',
    motion: 'none',
    tone: 'neutral',
  },
  working: {
    semantic: 'working',
    labelKey: 'agent.status.working',
    ariaLabelKey: 'agent.status.working.aria',
    motion: 'pulse',
    tone: 'active',
  },
  waiting: {
    semantic: 'waiting',
    labelKey: 'agent.status.waiting',
    ariaLabelKey: 'agent.status.waiting.aria',
    motion: 'none',
    tone: 'neutral',
  },
  completed: {
    semantic: 'completed',
    labelKey: 'agent.status.completed',
    ariaLabelKey: 'agent.status.completed.aria',
    motion: 'none',
    tone: 'success',
  },
  failed: {
    semantic: 'failed',
    labelKey: 'agent.status.failed',
    ariaLabelKey: 'agent.status.failed.aria',
    motion: 'none',
    tone: 'danger',
  },
  cancelled: {
    semantic: 'cancelled',
    labelKey: 'agent.status.cancelled',
    ariaLabelKey: 'agent.status.cancelled.aria',
    motion: 'none',
    tone: 'neutral',
  },
  unknown: {
    semantic: 'unknown',
    labelKey: 'agent.status.unknown',
    ariaLabelKey: 'agent.status.unknown.aria',
    motion: 'none',
    tone: 'neutral',
  },
} as const satisfies Record<SemanticAgentStatus, StatusPresentation>

/** Minimal member fields needed to derive lifecycle meaning. */
export interface SemanticMemberStatusInput {
  readonly name: string
  readonly activity?: string
  readonly status?: string
}

/** Minimal task fields needed to aggregate a member's lifecycle. */
export interface SemanticStatusTask {
  readonly assignee: string
  readonly status: string
  readonly state?: string
}

/** Team-level context that intentionally overrides member-local idle state. */
export interface SemanticStatusContext {
  readonly phase?: 'staged' | 'running'
  readonly halted?: boolean
  readonly discarded?: boolean
}

const ACTIVE_TASK_STATUSES = new Set(['pending', 'claimed', 'in_progress'])
const ACTIVE_TASK_STATES = new Set(['open', 'claimed', 'running', 'blocked'])
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled'])

/**
 * Aggregate member/task lifecycle into the stable semantic model.
 *
 * Working is the strongest live signal even when a stale task snapshot still
 * names a terminal state. A stopped/discarded team is cancelled before member
 * detail is considered. Otherwise failed and cancelled terminal sets stay
 * visible instead of collapsing into a generic "settled" state.
 */
export function semanticAgentStatus(
  member: SemanticMemberStatusInput,
  tasks: readonly SemanticStatusTask[],
  context: SemanticStatusContext = {},
): SemanticAgentStatus {
  if (context.halted === true || context.discarded === true) return 'cancelled'
  if (member.activity === 'working' || member.status === 'working') return 'working'
  if (context.phase === 'staged') return 'waiting'
  if (member.status === 'removed') return 'cancelled'

  const owned = tasks.filter(task => task.assignee === member.name)
  if (owned.some(task => task.status === 'failed')) return 'failed'
  if (owned.some(task => ACTIVE_TASK_STATUSES.has(task.status)
    || (task.state !== undefined && ACTIVE_TASK_STATES.has(task.state)))) return 'waiting'
  if (owned.length > 0 && owned.every(task => task.status === 'completed')) return 'completed'
  if (owned.length > 0 && owned.every(task => TERMINAL_TASK_STATUSES.has(task.status))) {
    return owned.some(task => task.status === 'cancelled') ? 'cancelled' : 'completed'
  }
  if (owned.length > 0) return 'unknown'
  if (member.activity === 'idle' || member.status === 'idle') return 'idle'
  return 'unknown'
}

/** Resolve the immutable presentation mapped to one semantic status. */
export function statusPresentation(semantic: SemanticAgentStatus): StatusPresentation {
  return STATUS_PRESENTATIONS[semantic]
}

/** Runtime motion state after visibility, accessibility, and mount lifecycle. */
export type StatusMotionState = 'none' | 'running' | 'paused' | 'stopped'

/** Browser-independent inputs for motion lifecycle decisions. */
export interface StatusMotionEnvironment {
  readonly mounted: boolean
  readonly hidden: boolean
  readonly reducedMotion: boolean
}

/**
 * Decide whether a status animation may run.
 *
 * Hidden means the panel/tab is not visible; unmount is final and stops the
 * animation entirely. Reduced motion suppresses motion rather than merely
 * pausing it, so the text and glyph remain sufficient.
 */
export function statusMotionState(
  presentation: Pick<StatusPresentation, 'motion'>,
  environment: StatusMotionEnvironment,
): StatusMotionState {
  if (!environment.mounted) return 'stopped'
  if (presentation.motion === 'none') return 'none'
  if (environment.reducedMotion) return 'none'
  if (environment.hidden) return 'paused'
  return 'running'
}

/** Resolved inputs supplied to a status renderer for one mounted instance. */
export interface StatusRenderContext {
  readonly t: AgentTeamsTranslate
  readonly motionState: StatusMotionState
  readonly className?: string
  readonly textClassName?: string
}

/** Replaceable visual contract; lifecycle mapping never depends on it. */
export interface StatusRenderer {
  render(presentation: StatusPresentation, context: StatusRenderContext): ReactNode
}

/** Non-color glyphs keep every state distinguishable without animation. */
export const STATUS_GLYPHS = {
  idle: '○',
  working: '◉',
  waiting: '◷',
  completed: '✓',
  failed: '!',
  cancelled: '×',
  unknown: '?',
} as const satisfies Record<SemanticAgentStatus, string>

/**
 * Built-in renderer: stable text plus an explicit screen-reader label.
 *
 * The caller owns classes/DOM placement, while the semantic status, glyph,
 * accessible label, tone, and motion state stay renderer-independent.
 */
export const defaultStatusRenderer: StatusRenderer = {
  render(presentation, context) {
    return createElement(
      'span',
      {
        className: context.className,
        'data-status': presentation.semantic,
        'data-status-tone': presentation.tone,
        'data-motion': presentation.motion,
        'data-motion-state': context.motionState,
        role: 'img',
        'aria-label': context.t(presentation.ariaLabelKey),
      },
      createElement('span', { 'data-status-glyph': '', 'aria-hidden': true }, STATUS_GLYPHS[presentation.semantic]),
      createElement('span', { className: context.textClassName, 'data-status-label': '' }, context.t(presentation.labelKey)),
    )
  },
}
