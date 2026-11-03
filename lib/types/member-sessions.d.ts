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
/** The tiny slice of the workspace registry this module needs. */
export interface MemberSessionArchive {
    archiveSession?(sessionId: string, options?: {
        stopActivity?: boolean;
    }): Promise<void>;
}
/** Result of one opt-in member-session archive pass. */
export interface MemberSessionArchiveResult {
    /** Distinct durable member ids that the host accepted. */
    readonly archived: number;
    /** Distinct member ids the host rejected or that had no archive surface. */
    readonly skipped: number;
    /** Bounded diagnostics; never contains prompts or credentials. */
    readonly warnings: readonly string[];
}
/**
 * Archive the durable host sessions of the given member ids.
 * @param registry - the host workspace registry, when the profile has one.
 * @param memberIds - every durable member id in the ending team (may repeat).
 * @param log - bounded diagnostic sink; defaults to no output.
 */
export declare function archiveMemberSessions(registry: MemberSessionArchive | undefined, memberIds: readonly string[], log?: (message: string) => void): Promise<MemberSessionArchiveResult>;
