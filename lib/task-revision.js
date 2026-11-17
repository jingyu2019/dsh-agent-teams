/** The task's scalar revision; legacy records without one read as 1. */
export function taskRevision(task) {
    const value = task.revision;
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : 1;
}
/**
 * Advance the optimistic-lock version. Every durable rewrite of a task's
 * contract, status or assignee must go through this single helper, so no tool,
 * scheduler path or captain proxy write can leave the version behind.
 * @param task - the mutable task record.
 * @returns the new revision.
 */
export function bumpTaskRevision(task) {
    task.revision = taskRevision(task) + 1;
    return task.revision;
}
/**
 * Validate a caller-supplied `expected_revision` against the current record.
 * @param task - the freshly read task.
 * @param expected - the value the caller based its change on, if any.
 * @returns the actionable conflict message, or undefined when the change may proceed.
 */
export function expectedRevisionError(task, expected) {
    if (expected === undefined)
        return undefined;
    const current = taskRevision(task);
    if (current === expected)
        return undefined;
    return `task "${task.id}" was changed by someone else: you based this change on revision ${expected}, but it is now at revision ${current}. Read the current task with agent_teams_status, then retry with expected_revision: ${current}.`;
}
/** Whether a caller-supplied expected revision is a usable lock value. */
export function isExpectedRevision(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}
