import type { ArtifactRootConfig, MessageAttachment } from './types.ts';
export declare const ATTACHMENT_MAX_FILES = 5;
export declare const ATTACHMENT_MAX_BYTES: number;
export declare const ATTACHMENT_MAX_TOTAL_BYTES: number;
export declare const ATTACHMENT_BASE = "/plugins/dsh-agent-teams/attachment/";
export declare class AttachmentError extends Error {
}
/** Copy one allowed source into the team's content-addressed attachment store. */
export declare function copyAttachment(input: {
    workspace: string;
    stateRoot: string;
    teamId: string;
    sourcePath: string;
    allowedScopes: readonly string[];
    artifactRoots?: readonly ArtifactRootConfig[];
}): Promise<MessageAttachment>;
/** Copy a bounded ordered set; all-or-nothing before the message is written. */
export declare function copyAttachments(input: {
    workspace: string;
    stateRoot: string;
    teamId: string;
    paths: readonly string[];
    allowedScopes: readonly string[];
    artifactRoots?: readonly ArtifactRootConfig[];
}): Promise<MessageAttachment[]>;
export declare function attachmentUrl(teamId: string, attachment: Pick<MessageAttachment, 'storageRef'>): string;
export declare function readAttachment(stateRoot: string, teamId: string, file: string): Promise<Buffer | undefined>;
