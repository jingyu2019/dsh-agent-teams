/**
 * Team activity snapshot assembly for the activity panel.
 *
 * Server-side assembly mirrors the Claude Code desktop teamWatcher: read the
 * durable team files (the truth source) and enrich with live subagent
 * activity, so the panel always reflects the on-disk state even when a model
 * skipped a tool "ritual" (e.g. not calling update_task on completion).
 * @module dsh-agent-teams/snapshot
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { memberActivity } from "./members.js";
import { canDeclareDelivery, describeQualityLoop, verdictAuditNotes } from "./quality-gates.js";
import { auditTeamWorkspace } from "./workspace-audit.js";
import { avatarUrl, memberAvatarRef } from "./avatars.js";
import { attachmentUrl } from "./attachments.js";
import { CAPTAIN_KEY, listArchivedTeamIds, readArchivedTeam, readUnreadMailbox, readTeam, taskDepthsById, taskVisualState, } from "./state.js";
/** Durable timeline entries carried by a snapshot; the panel renders the newest 50. */
export const SNAPSHOT_TIMELINE_LIMIT = 50;
/** The current task of a member: its first unfinished owned task. */
function currentTaskOf(memberName, tasks) {
    for (const task of tasks) {
        if (task.status === 'in_progress' && task.assignee === memberName)
            return task.id;
    }
    return '';
}
/** Compact `provider/model` route for the activity panel, or just the model. */
export function memberModelRoute(member) {
    if (member === undefined)
        return '';
    const provider = member.provider?.trim() ?? '';
    const model = member.model?.trim() ?? '';
    if (provider !== '' && model !== '')
        return `${provider}/${model}`;
    return model;
}
/**
 * Assemble one team snapshot from its durable files plus live activity.
 * @param ctx - the plugin context (injects `subagents`, used for activity).
 * @param stateRoot - resolved absolute state root of the owning workspace.
 * @param workspace - display name of the owning workspace.
 * @param state - the durable team record.
 * @returns the panel snapshot.
 */
export async function assembleTeamSnapshot(ctx, stateRoot, workspace, state, options = {}) {
    const tasks = state.tasks;
    const depths = taskDepthsById(tasks);
    const roster = options.includeRemoved === true
        ? state.members
        : state.members.filter((member) => member.status !== 'removed');
    const activity = options.historic === true
        ? new Map()
        : memberActivity(ctx, roster.map((member) => member.id));
    const unreadByMember = new Map();
    for (const member of roster) {
        try {
            unreadByMember.set(member.name, (await readUnreadMailbox(stateRoot, state.id, member.name)).length);
        }
        catch (error) {
            ctx.logger.warn(`agent-teams: mailbox read failed for ${member.name}: ${String(error)}`);
            unreadByMember.set(member.name, 0);
        }
    }
    const members = roster.map((member) => {
        const owned = tasks.filter((task) => task.assignee === member.name);
        const done = owned.filter((task) => task.status === 'completed').length;
        return {
            id: member.id,
            name: member.name,
            role: member.role ?? '',
            provider: member.provider?.trim() ?? '',
            model: member.model?.trim() ?? '',
            reasoningEffort: member.reasoningEffort?.trim() ?? '',
            // Only the staged plan editor renders member prompts. Running and
            // archived teams must not carry every long execution prompt on each poll.
            executionPrompt: state.phase === 'staged' ? member.executionPrompt ?? '' : '',
            ...avatarUrl(state.id, memberAvatarRef(state, member)) === undefined ? {} : { avatarUrl: avatarUrl(state.id, memberAvatarRef(state, member)) },
            status: member.status,
            activity: options.historic === true
                ? 'idle'
                : member.id !== ''
                    ? (activity.get(member.id) === 'running'
                        ? 'working'
                        : activity.get(member.id) === 'idle' || activity.get(member.id) === 'ready'
                            ? 'idle'
                            : 'unknown')
                    : 'idle',
            progress: owned.length === 0 ? 0 : Math.round((done / owned.length) * 100),
            done,
            total: owned.length,
            currentTask: currentTaskOf(member.name, tasks),
            unread: unreadByMember.get(member.name) ?? 0,
        };
    });
    const captainInbox = await readUnreadMailbox(stateRoot, state.id, CAPTAIN_KEY);
    // The panel must reach the same delivery conclusion as the status tool, so
    // it reads the same current bytes instead of trusting task records alone.
    const audit = options.workspacePath === undefined ? undefined : auditTeamWorkspace(options.workspacePath, state);
    const deliveryCheck = audit === undefined ? canDeclareDelivery(state) : canDeclareDelivery(state, audit);
    const loop = audit === undefined ? describeQualityLoop(state) : describeQualityLoop(state, audit);
    const staleById = new Map();
    if (audit !== undefined) {
        for (const note of verdictAuditNotes(state, audit)) {
            staleById.set(note.taskId, [...staleById.get(note.taskId) ?? [], note.message]);
        }
    }
    return {
        workspace,
        teamId: state.id,
        name: state.name,
        ...state.description !== undefined ? { description: state.description } : {},
        captainSessionId: state.captainSessionId,
        phase: state.phase ?? 'running',
        ...state.phase === 'staged'
            ? { planReviewState: state.planReviewState ?? 'awaiting_review' }
            : {},
        ...state.halted === true ? { halted: true } : {},
        ...audit === undefined ? {} : {
            loopState: loop.state,
            deliverable: loop.deliverable,
            delivery: { ok: deliveryCheck.ok, blockers: [...deliveryCheck.blockers], warnings: [...deliveryCheck.warnings] },
        },
        members,
        tasks: tasks.map((task) => ({
            id: task.id,
            subject: task.subject,
            // Task descriptions exist for the staging editor; a running board only
            // needs the subject and state, so long briefs stay off the wire.
            ...state.phase === 'staged' ? { description: task.description ?? '' } : {},
            status: task.status,
            state: taskVisualState(task.status, task.dependencies, tasks),
            assignee: task.assignee ?? '',
            model: memberModelRoute(roster.find((member) => member.name === task.assignee)),
            dependencies: task.dependencies,
            depth: depths.get(task.id) ?? 0,
            ...task.kind === undefined ? {} : { kind: task.kind },
            ...task.round === undefined ? {} : { round: task.round },
            ...task.verdict === undefined ? {} : { verdict: task.verdict },
            ...staleById.get(task.id) === undefined ? {} : { verdictStale: staleById.get(task.id).join('; ') },
            updatedAt: task.updatedAt,
        })),
        messageCount: captainInbox.length
            + members.reduce((count, member) => count + member.unread, 0),
        captainInbox: captainInbox.slice(-5).map((message) => ({
            from: message.from,
            content: message.content,
            ...message.attachments === undefined || message.attachments.length === 0 ? {} : {
                attachments: message.attachments.map(attachment => ({
                    name: attachment.name,
                    mime: attachment.mime,
                    bytes: attachment.bytes,
                    url: attachmentUrl(state.id, attachment),
                })),
            },
        })),
        timeline: (state.timeline ?? []).slice(-SNAPSHOT_TIMELINE_LIMIT),
    };
}
/**
 * Collect every team under the given workspace state roots.
 * @param ctx - the plugin context.
 * @param roots - `{ workspace, stateRoot }` pairs (resolved absolute roots).
 * @returns the snapshots in stable order (workspace, then team id).
 */
export async function collectTeamsActivity(ctx, roots) {
    const snapshots = [];
    for (const root of roots) {
        let entries;
        try {
            entries = await readdir(root.stateRoot, { withFileTypes: true });
        }
        catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
                continue;
            }
            throw error;
        }
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            try {
                const state = await readTeam(root.stateRoot, entry.name);
                if (state === undefined)
                    continue;
                snapshots.push(await assembleTeamSnapshot(ctx, root.stateRoot, root.workspace, state, {
                    ...root.workspacePath === undefined ? {} : { workspacePath: root.workspacePath },
                }));
            }
            catch {
                ctx.logger.warn(`agent-teams: skipped unreadable team state "${entry.name}" in workspace "${root.workspace}"`);
            }
        }
    }
    return snapshots;
}
/** Bound on cached archived snapshots; oldest entries are evicted first. */
export const ARCHIVED_SNAPSHOT_CACHE_LIMIT = 256;
// Archives are immutable after `archiveTeamDir` moves them, so a snapshot can
// be reused until team.json changes. Keyed by state root + team id, with the
// display workspace name folded into the stamp because it is part of the payload.
const archivedSnapshotCache = new Map();
/** Clear the archived snapshot cache (tests and explicit reloads). */
export function clearArchivedSnapshotCache() {
    archivedSnapshotCache.clear();
}
/** Number of archived snapshots currently cached. */
export function archivedSnapshotCacheSize() {
    return archivedSnapshotCache.size;
}
function cacheArchivedSnapshot(key, entry) {
    archivedSnapshotCache.delete(key);
    archivedSnapshotCache.set(key, entry);
    while (archivedSnapshotCache.size > ARCHIVED_SNAPSHOT_CACHE_LIMIT) {
        const oldest = archivedSnapshotCache.keys().next();
        if (oldest.done === true)
            break;
        archivedSnapshotCache.delete(oldest.value);
    }
}
async function archivedTeamStamp(stateRoot, teamId, workspace) {
    try {
        const info = await stat(join(stateRoot, 'archive', teamId, 'team.json'));
        return `${info.mtimeMs}:${info.size}:${workspace}`;
    }
    catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
            return undefined;
        throw error;
    }
}
/**
 * Collect every archived team under the given workspace state roots (the
 * `archive/` subdirectory of each state root). Used by the historic panel
 * path to restore full team detail after deletion.
 *
 * Archived teams never change after their directory is moved, so each full
 * snapshot is cached by `team.json` mtime+size. Repeat polling therefore only
 * lists directories and stats one file per archive instead of re-reading the
 * team record and every member mailbox.
 * @param ctx - the plugin context.
 * @param roots - `{ workspace, stateRoot }` pairs.
 * @returns the archived snapshots in stable order.
 */
export async function collectArchivedTeamsActivity(ctx, roots) {
    const snapshots = [];
    const liveKeys = new Set();
    for (const root of roots) {
        for (const teamId of await listArchivedTeamIds(root.stateRoot)) {
            const key = `${root.stateRoot}\u0000${teamId}`;
            liveKeys.add(key);
            try {
                const stamp = await archivedTeamStamp(root.stateRoot, teamId, root.workspace);
                if (stamp === undefined) {
                    archivedSnapshotCache.delete(key);
                    continue;
                }
                const cached = archivedSnapshotCache.get(key);
                if (cached !== undefined && cached.stamp === stamp) {
                    snapshots.push(cached.snapshot);
                    continue;
                }
                const state = await readArchivedTeam(root.stateRoot, teamId);
                if (state === undefined) {
                    archivedSnapshotCache.delete(key);
                    continue;
                }
                const snapshot = await assembleTeamSnapshot(ctx, join(root.stateRoot, 'archive'), root.workspace, state, { includeRemoved: true, historic: true });
                cacheArchivedSnapshot(key, { stamp, snapshot });
                snapshots.push(snapshot);
            }
            catch {
                archivedSnapshotCache.delete(key);
                ctx.logger.warn(`agent-teams: skipped unreadable archived team "${teamId}" in workspace "${root.workspace}"`);
            }
        }
    }
    // Deleted or moved archives must not stay resident forever.
    for (const key of [...archivedSnapshotCache.keys()]) {
        if (!liveKeys.has(key))
            archivedSnapshotCache.delete(key);
    }
    return snapshots;
}
