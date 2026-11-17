import type { AgentPresetV1 } from './types.ts';
export declare const AGENT_LIBRARY_FILE = "agent-library/presets.json";
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
/** Portable catalog layout: `agents/<name>/plugin.json` plus `instructions.md`. */
export declare const AGENT_CATALOG_MANIFEST = "plugin.json";
export declare const AGENT_CATALOG_INSTRUCTIONS = "instructions.md";
/** One non-fatal issue found while reading or writing a catalog. */
export interface AgentCatalogWarning {
    source: string;
    field: string;
    message: string;
}
/** One name already in the library; import refuses it unless told to overwrite. */
export interface AgentCatalogConflict {
    name: string;
    existingId: string;
    existingRevision: number;
}
/** One catalog entry that was not imported at all. */
export interface AgentCatalogSkip {
    source: string;
    reason: string;
}
export interface ImportAgentCatalogResult {
    imported: Array<{
        name: string;
        id: string;
        revision: number;
    }>;
    unchanged: string[];
    conflicts: AgentCatalogConflict[];
    skipped: AgentCatalogSkip[];
    warnings: AgentCatalogWarning[];
}
export interface ExportAgentCatalogResult {
    exported: Array<{
        name: string;
        directory: string;
    }>;
    warnings: AgentCatalogWarning[];
}
/**
 * Import a catalog directory (`agents/<name>/plugin.json` + `instructions.md`)
 * or one JSON file. Nothing in the catalog is executed; every entry is
 * validated field by field, and a broken entry is skipped with a reason while
 * the rest still import. Same-name presets are reported as conflicts unless
 * `overwrite` is true, and an identical overwrite leaves the revision alone.
 */
export declare function importAgentCatalog(stateRoot: string, source: string, options?: {
    overwrite?: boolean;
    validate?: (input: AgentPresetInput) => string | undefined;
}): Promise<ImportAgentCatalogResult>;
/**
 * Export presets into `agents/<name>/{plugin.json,instructions.md}` so the same
 * tree imports back without loss. Existing entries are never replaced unless
 * `overwrite` is true.
 */
export declare function exportAgentCatalog(stateRoot: string, target: string, options?: {
    overwrite?: boolean;
    presets?: readonly AgentPresetV1[];
}): Promise<ExportAgentCatalogResult>;
/** Resolve one preset by exact name, case-insensitively; the summon gesture's only layer. */
export declare function resolvePresetByName(presets: readonly AgentPresetV1[], name: string): AgentPresetV1 | undefined;
/** Load the library and resolve one preset by name. */
export declare function resolveAgentPresetByName(stateRoot: string, name: string): Promise<AgentPresetV1 | undefined>;
export {};
