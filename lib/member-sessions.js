/**
 * Host-owned member session cleanup for `agent_teams_delete`.
 *
 * A member is a durable continuable subagent, so every generation of every
 * team leaves one host Session behind. Deleting a team archives the plugin's
 * own state but historically never touched those sessions, which inflates
 * `session/list` forever (issue #333).
 *
 * The cleanup is opt-in and fail-soft: a host without the registry surface, a
 * registry without `archiveSession`, or one rejected id never fails a team
 * deletion. Transcripts are archived, never deleted, and the host's own
 * `agent/pre-step` gate refuses model steps for archived sessions.
 */
/**
 * Archive the durable host sessions of the given member ids.
 * @param registry - the host workspace registry, when the profile has one.
 * @param memberIds - every durable member id in the ending team (may repeat).
 * @param log - bounded diagnostic sink; defaults to no output.
 */
export async function archiveMemberSessions(registry, memberIds, log = () => { }) {
    const ids = [...new Set(memberIds.filter(id => typeof id === 'string' && id.trim() !== ''))];
    if (ids.length === 0)
        return { archived: 0, skipped: 0, warnings: [] };
    if (registry === undefined || typeof registry.archiveSession !== 'function') {
        const warning = 'the host has no session archive surface; member sessions were left in place';
        log(`agent-teams: ${warning}`);
        return { archived: 0, skipped: ids.length, warnings: [warning] };
    }
    const warnings = [];
    let archived = 0;
    for (const id of ids) {
        try {
            // The archive write happens before stops are requested, so a still-running
            // member cannot reject the archive; provider stop failures are host-logged.
            await registry.archiveSession(id, { stopActivity: true });
            archived += 1;
        }
        catch (error) {
            warnings.push(`session ${id} could not be archived: ${error instanceof Error ? error.message : String(error)}`);
            if (warnings.length >= 5)
                break;
        }
    }
    for (const warning of warnings)
        log(`agent-teams: ${warning}`);
    return { archived, skipped: ids.length - archived, warnings };
}
