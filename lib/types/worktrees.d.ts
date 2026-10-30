import type { WorktreeLane } from './types.ts';
export interface WorktreeConfig {
    enabled: boolean;
    root?: string;
    baseRef?: string;
}
/** Create one lane before the member's first child start. */
export declare function createWorktreeLane(input: {
    teamId: string;
    memberId: string;
    workspace: string;
    root: string;
    baseRef?: string;
}): Promise<WorktreeLane>;
/** Capture final commit, dirty flag and changed paths; never mutates the lane. */
export declare function captureLaneState(lane: WorktreeLane): Promise<{
    commit: string;
    dirty: boolean;
    changedPaths: string[];
}>;
/** Archive/cancel defaults to preservation; cleanup/integration are separate gates. */
export declare function preserveLane(lane: WorktreeLane): void;
