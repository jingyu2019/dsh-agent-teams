/** Persisted AgentTeams panel scale. `host` keeps the shell's native size. */
export type AgentTeamsUiScale = 'host' | '100' | '125' | '150';
export declare const AGENT_TEAMS_UI_SCALE_STORAGE_KEY = "dsh-agent-teams.ui-scale";
export declare const AGENT_TEAMS_UI_SCALE_VALUES: readonly AgentTeamsUiScale[];
/** Parse a stored preference without trusting arbitrary localStorage data. */
export declare function parseAgentTeamsUiScale(value: string | null): AgentTeamsUiScale;
/** CSS multiplier consumed by the panel's single font-scale variable. */
export declare function agentTeamsUiScaleFactor(scale: AgentTeamsUiScale): string;
