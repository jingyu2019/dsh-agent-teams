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
/** Merge one clean lane branch into the repository's current branch. */
export declare function integrateLane(lane: WorktreeLane): Promise<string>;
/** Remove one clean, already-integrated lane without force or pruning. */
export declare function cleanupLane(lane: WorktreeLane): Promise<void>;
/** Archive/cancel defaults to preservation; cleanup/integration are separate gates. */
export declare function preserveLane(lane: WorktreeLane): void;
