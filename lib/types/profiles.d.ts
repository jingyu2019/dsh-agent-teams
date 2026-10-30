/**
 * Named team-profile templates: config types, normalization, invocation
 * parsing, and prompt rendering.
 *
 * Pure functions only — no I/O, no spawn. Runtime create/spawn stays in
 * `tools.ts`; this module only turns a config map + a profile name into a
 * validated, topologically ordered template (or parses `--profile` flags).
 *
 * @module dsh-agent-teams/profiles
 */
/** Hard cap on named profiles so the usage prompt cannot grow without bound. */
export declare const MAX_TEAM_PROFILES = 16;
/** Hard cap on seed tasks per profile. The software-delivery example has 13. */
export declare const MAX_PROFILE_TASKS = 32;
/** Protocol excerpt length in the usage / prompt listing. */
export declare const PROFILE_PROTOCOL_PROMPT_LIMIT = 240;
/** Hard cap on owner skills a single member may select. */
export declare const MAX_MEMBER_SKILLS = 8;
/** Hard cap on owner-declared skill entries. */
export declare const MAX_OWNER_SKILLS = 128;
/** One member row in a named team-profile template (unresolved). */
export interface TeamModelFallbackConfig {
    provider: string;
    model: string;
}
export interface TeamProfileMemberConfig {
    name: string;
    role?: string;
    provider?: string;
    model?: string;
    reasoning_effort?: string;
    executionPrompt?: string;
    fallback?: TeamModelFallbackConfig;
    /** Ordered additional routes after the primary, at most four. */
    fallbacks?: TeamModelFallbackConfig[];
    /**
     * Owner-declared tool-policy id this profile member selects (#59). The
     * profile only names a configured policy; it never carries raw tool lists.
     */
    tool_policy?: string;
    /** Owner-declared skill ids selected by reference; never raw prompt bundles (#244). */
    skills?: string[];
    /** Immutable global agent preset selected for this member (#315). */
    presetId?: string;
}
/** One owner-declared reusable skill snippet. */
export interface SkillBindingConfig {
    version: string;
    prompt: string;
    /** Optional owner-declared tool-policy id, never a raw tool/MCP list. */
    toolPolicy?: string;
}
/** A member's frozen owner-skill selection. */
export interface ResolvedMemberSkills {
    ids: string[];
    prompt: string;
    sha256: string;
    toolPolicy?: string;
}
/** One seed-task row in a named team-profile template (unresolved). */
export interface TeamProfileTaskConfig {
    id: string;
    subject: string;
    description?: string;
    assignee?: string;
    dependencies?: string[];
}
/** One named team-profile template from plugin config. */
export interface TeamProfileConfig {
    description?: string;
    protocol?: string;
    executionPrompt?: string;
    fallback?: TeamModelFallbackConfig;
    /** Ordered additional routes after the primary, at most four. */
    fallbacks?: TeamModelFallbackConfig[];
    members: TeamProfileMemberConfig[];
    /**
     * `captain` means the profile supplies people and guardrails only; the
     * Captain derives the task graph from the user's goal at runtime.
     * `seed` preserves a fixed template workflow for explicitly scripted teams.
     */
    taskPlanning?: 'captain' | 'seed';
    tasks?: TeamProfileTaskConfig[];
    reviewPolicy?: import('./types.ts').ReviewPolicy;
}
/** A profile member after trim / pairing / reserved-name checks. */
export interface NormalizedProfileMember {
    name: string;
    role?: string;
    provider?: string;
    model?: string;
    reasoningEffort?: string;
    executionPrompt?: string;
    fallback?: TeamModelFallbackConfig;
    fallbacks?: TeamModelFallbackConfig[];
    toolPolicy?: string;
    skills?: string[];
    presetId?: string;
}
/** A profile seed task after assignee canonicalization; `sourceIndex` is the YAML order. */
export interface NormalizedProfileTask {
    id: string;
    subject: string;
    description?: string;
    assignee?: string;
    dependencies: string[];
    sourceIndex: number;
}
/** A fully validated, topologically ordered team profile. */
export interface NormalizedTeamProfile {
    name: string;
    description?: string;
    protocol?: string;
    executionPrompt?: string;
    fallback?: TeamModelFallbackConfig;
    fallbacks?: TeamModelFallbackConfig[];
    taskPlanning: 'captain' | 'seed';
    members: NormalizedProfileMember[];
    tasks: NormalizedProfileTask[];
    reviewPolicy?: import('./types.ts').ReviewPolicy;
}
/** The goal + optional named profile extracted from a slash / gesture line. */
export interface AgentTeamsInvocation {
    goal: string;
    profile?: string;
}
/** One configured profile after key trim, for listing / lookup. */
export interface ListedTeamProfile {
    name: string;
    config: TeamProfileConfig;
}
/**
 * Validate the owner skill catalog once at config resolution. IDs are trimmed;
 * a blank/duplicate ID, blank version/prompt, or malformed tool-policy id
 * fails before any roster is persisted.
 */
export declare function normalizeSkillCatalog(skills: Record<string, SkillBindingConfig> | undefined | null): Record<string, SkillBindingConfig>;
/** Canonical prompt text for one member's selected owner skills. */
export declare function renderMemberSkillPrompt(ids: readonly string[], catalog: Record<string, SkillBindingConfig>): string;
/**
 * Resolve selected skill ids before persistence or child creation. Unknown,
 * blank, duplicate or over-limit ids fail atomically. Skill-provided tool
 * policies must agree with each other and with the member's explicit policy.
 */
export declare function resolveMemberSkills(catalog: Record<string, SkillBindingConfig>, selected: readonly string[] | undefined, memberToolPolicy?: string): ResolvedMemberSkills;
/**
 * Trim every profile key once, reject empty / colliding keys, and reject
 * more than {@link MAX_TEAM_PROFILES} entries. Does not validate profile
 * bodies — that belongs to {@link resolveTeamProfile}.
 */
export declare function listConfiguredProfiles(profiles: Record<string, TeamProfileConfig> | undefined | null): ListedTeamProfile[];
/**
 * Render the usage-prompt listing. One line per profile: name, member count,
 * task count, protocol excerpt (at most 240 characters). Returns `''` when
 * nothing is configured so callers can omit the capability entirely.
 */
export declare function formatProfilesForPrompt(profiles: Record<string, TeamProfileConfig> | undefined | null): string;
/**
 * Walk `rawInput` from the front and eat standalone profile flags. Only
 * `--profile <name>`, `--profile=<name>`, and `profile=<name>` count; the
 * first ordinary token stops the scan so a mid-sentence `profile=` stays in
 * the goal. A leading ordinary token is never treated as a profile name.
 *
 * `--profile "name"` strips one matching pair of quotes. Repeat flags and a
 * `--profile` with no name throw.
 */
export declare function parseProfileInvocation(rawInput: string): AgentTeamsInvocation;
/**
 * Normalize and pre-validate one named profile. Failures throw before any
 * caller should create a directory or spawn members.
 */
export declare function resolveTeamProfile(profiles: Record<string, TeamProfileConfig>, profileName: string, maxMembers: number): NormalizedTeamProfile;
/** Public lookup used by activation text and status rendering. */
export declare function resolveProfileTaskPlanning(config: TeamProfileConfig | undefined): 'captain' | 'seed';
