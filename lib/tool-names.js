/** Stable business API names; exposure changes never rename these operations. */
export const TEAM_TOOL_NAMES = [
    'agent_teams_create', 'agent_teams_invoke_profile', 'agent_teams_approve', 'agent_teams_edit_plan',
    'agent_teams_add_member', 'agent_teams_update_member_route', 'agent_teams_remove_member', 'agent_teams_create_task',
    'agent_teams_reassign_task', 'agent_teams_claim_task', 'agent_teams_update_task',
    'agent_teams_amend_task',
    'agent_teams_send_message', 'agent_teams_status', 'agent_teams_collect', 'agent_teams_resume', 'agent_teams_delete',
    'agent_teams_list_agent_presets', 'agent_teams_save_agent_preset', 'agent_teams_delete_agent_preset',
    'agent_teams_worktree',
];
export const MEMBER_TOOL_NAMES = [
    'agent_teams_claim_task', 'agent_teams_update_task', 'agent_teams_send_message', 'agent_teams_status',
];
export const CAPTAIN_TOOL_NAMES = TEAM_TOOL_NAMES.filter(name => !MEMBER_TOOL_NAMES.includes(name));
