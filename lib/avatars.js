/** Local-only avatar validation, content-addressed storage and URL projection. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_BASE = '/plugins/dsh-agent-teams/avatar/';
/** Accept only raster signatures we can safely serve inline. */
export function parseRasterAvatar(data) {
    if (data.length === 0 || data.length > AVATAR_MAX_BYTES)
        return undefined;
    let ext;
    let mime;
    if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        ext = 'png';
        mime = 'image/png';
    }
    else if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
        ext = 'jpg';
        mime = 'image/jpeg';
    }
    else if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') {
        ext = 'webp';
        mime = 'image/webp';
    }
    else {
        return undefined;
    }
    return { bytes: data, ext, mime, sha256: createHash('sha256').update(data).digest('hex') };
}
export function managedAvatarFile(teamId, ref) {
    return join(teamId, 'avatars', `${ref.sha256}.${ref.ext}`);
}
export function avatarUrl(teamId, ref) {
    return ref?.kind === 'managed' ? `${AVATAR_BASE}${encodeURIComponent(teamId)}/${ref.sha256}.${ref.ext}` : undefined;
}
export function memberAvatarRef(state, member) {
    const memberRef = state.memberAvatars?.[member.name];
    if (memberRef !== undefined)
        return memberRef;
    const role = member.role?.trim();
    return role === undefined || role === '' ? undefined : state.roleAvatars?.[role];
}
/** Persist a validated raster and return its durable reference. */
export async function storeManagedAvatar(stateRoot, teamId, avatar) {
    const dir = join(stateRoot, teamId, 'avatars');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${avatar.sha256}.${avatar.ext}`);
    try {
        await writeFile(path, avatar.bytes, { flag: 'wx', mode: 0o600 });
    }
    catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
            throw error;
    }
    return { kind: 'managed', sha256: avatar.sha256, ext: avatar.ext };
}
/** Read one managed avatar after its reference has been authorized by the caller. */
export async function readManagedAvatar(stateRoot, teamId, ref) {
    try {
        const bytes = await readFile(join(stateRoot, managedAvatarFile(teamId, ref)));
        return { bytes, mime: ref.ext === 'png' ? 'image/png' : ref.ext === 'jpg' ? 'image/jpeg' : 'image/webp' };
    }
    catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
            return undefined;
        throw error;
    }
}
