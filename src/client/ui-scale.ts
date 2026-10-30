/** Persisted AgentTeams panel scale. `host` keeps the shell's native size. */
export type AgentTeamsUiScale = 'host' | '100' | '125' | '150'

export const AGENT_TEAMS_UI_SCALE_STORAGE_KEY = 'dsh-agent-teams.ui-scale'
export const AGENT_TEAMS_UI_SCALE_VALUES: readonly AgentTeamsUiScale[] = ['host', '100', '125', '150']

/** Parse a stored preference without trusting arbitrary localStorage data. */
export function parseAgentTeamsUiScale(value: string | null): AgentTeamsUiScale {
  return value === '100' || value === '125' || value === '150' ? value : 'host'
}

/** CSS multiplier consumed by the panel's single font-scale variable. */
export function agentTeamsUiScaleFactor(scale: AgentTeamsUiScale): string {
  return scale === 'host' ? '1' : String(Number(scale) / 100)
}
