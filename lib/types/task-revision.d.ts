/** Optimistic-lock version shared by every task rewrite path (#P0-4). */
import type { TeamTask } from './types.ts';
/** The task's scalar revision; legacy records without one read as 1. */
export declare function taskRevision(task: Pick<TeamTask, 'revision'>): number;
/**
 * Advance the optimistic-lock version. Every durable rewrite of a task's
 * contract, status or assignee must go through this single helper, so no tool,
 * scheduler path or captain proxy write can leave the version behind.
 * @param task - the mutable task record.
 * @returns the new revision.
 */
export declare function bumpTaskRevision(task: TeamTask): number;
/**
 * Validate a caller-supplied `expected_revision` against the current record.
 * @param task - the freshly read task.
 * @param expected - the value the caller based its change on, if any.
 * @returns the actionable conflict message, or undefined when the change may proceed.
 */
export declare function expectedRevisionError(task: TeamTask, expected: number | undefined): string | undefined;
/** Whether a caller-supplied expected revision is a usable lock value. */
export declare function isExpectedRevision(value: unknown): value is number;
