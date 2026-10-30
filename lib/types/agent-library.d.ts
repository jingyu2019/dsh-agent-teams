import type { AgentPresetV1 } from './types.ts';
export declare const AGENT_LIBRARY_FILE = "agent-library.json";
export declare const AGENT_LIBRARY_MAX_PRESETS = 100;
interface AgentLibraryV1 {
    schemaVersion: 1;
    presets: AgentPresetV1[];
}
export declare function loadAgentLibrary(stateRoot: string): Promise<AgentLibraryV1>;
export interface AgentPresetInput {
    id?: string;
    name: string;
    role: string;
    provider?: string;
    model?: string;
    reasoningEffort?: string;
    executionPrompt: string;
    skillIds: string[];
    toolPolicy?: string;
    avatar?: AgentPresetV1['avatar'];
}
/** Create or update one revision; updates never mutate Teams that copied an older revision. */
export declare function saveAgentPreset(stateRoot: string, input: AgentPresetInput): Promise<AgentPresetV1>;
export declare function deleteAgentPreset(stateRoot: string, id: string): Promise<boolean>;
export {};
