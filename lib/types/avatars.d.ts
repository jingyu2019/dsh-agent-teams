import type { AvatarRef, TeamMember, TeamState } from './types.ts';
export declare const AVATAR_MAX_BYTES: number;
export declare const AVATAR_BASE = "/plugins/dsh-agent-teams/avatar/";
export type AvatarExtension = 'png' | 'jpg' | 'webp';
export interface RasterAvatar {
    bytes: Buffer;
    ext: AvatarExtension;
    mime: 'image/png' | 'image/jpeg' | 'image/webp';
    sha256: string;
}
/** Accept only raster signatures we can safely serve inline. */
export declare function parseRasterAvatar(data: Buffer): RasterAvatar | undefined;
export declare function managedAvatarFile(teamId: string, ref: Extract<AvatarRef, {
    kind: 'managed';
}>): string;
export declare function avatarUrl(teamId: string, ref: AvatarRef | undefined): string | undefined;
export declare function memberAvatarRef(state: TeamState, member: Pick<TeamMember, 'name' | 'role'>): AvatarRef | undefined;
/** Persist a validated raster and return its durable reference. */
export declare function storeManagedAvatar(stateRoot: string, teamId: string, avatar: RasterAvatar): Promise<Extract<AvatarRef, {
    kind: 'managed';
}>>;
/** Read one managed avatar after its reference has been authorized by the caller. */
export declare function readManagedAvatar(stateRoot: string, teamId: string, ref: Extract<AvatarRef, {
    kind: 'managed';
}>): Promise<{
    bytes: Buffer;
    mime: string;
} | undefined>;
