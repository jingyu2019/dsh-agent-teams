/** Safe, local-only mailbox attachments with scope and TOCTOU checks. */
import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, join, posix } from 'node:path'
import { isDefaultExcludedPath, pathMatchesScope } from './quality-gates.ts'
import type { ArtifactRootConfig, MessageAttachment } from './types.ts'

export const ATTACHMENT_MAX_FILES = 5
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024
export const ATTACHMENT_MAX_TOTAL_BYTES = 25 * 1024 * 1024
export const ATTACHMENT_BASE = '/plugins/dsh-agent-teams/attachment/'

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8',
  json: 'application/json', csv: 'text/csv; charset=utf-8',
  pdf: 'application/pdf', zip: 'application/zip',
}

export class AttachmentError extends Error {}

function fail(message: string): never { throw new AttachmentError(message) }

function normalizedRelative(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/')
  if (normalized === '' || normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized) || normalized.includes('\0')) {
    fail('attachment path must be a normalized workspace-relative path')
  }
  const parts = normalized.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) fail('attachment path contains an invalid segment')
  return parts.join('/')
}

function within(root: string, candidate: string): boolean {
  const prefix = root.endsWith('/') ? root : `${root}/`
  return candidate === root || candidate.startsWith(prefix)
}

async function assertNoSymlinkComponents(root: string, relative: string): Promise<void> {
  let cursor = root
  for (const part of relative.split('/')) {
    cursor = join(cursor, part)
    const stat = await lstat(cursor)
    if (stat.isSymbolicLink()) fail('attachment path must not contain symlinks')
  }
}

function detectMime(relative: string, bytes: Buffer): string {
  const ext = posix.extname(relative).slice(1).toLowerCase()
  const declared = MIME_BY_EXT[ext]
  if (declared === undefined) fail(`attachment type ".${ext}" is not allowed`)
  if (ext === 'png' && !(bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))) fail('PNG signature does not match its extension')
  if ((ext === 'jpg' || ext === 'jpeg') && !(bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) fail('JPEG signature does not match its extension')
  if (ext === 'webp' && !(bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP')) fail('WebP signature does not match its extension')
  if (ext === 'pdf' && !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) fail('PDF signature does not match its extension')
  if (ext === 'zip' && !(bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)) fail('ZIP signature does not match its extension')
  if (['txt', 'md', 'json', 'csv'].includes(ext)) {
    if (bytes.includes(0)) fail('text attachment contains NUL bytes')
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { fail('text attachment is not valid UTF-8') }
  }
  return declared
}

function sourceHash(workspace: string): string {
  return createHash('sha256').update(workspace).digest('hex')
}

/** Copy one allowed source into the team's content-addressed attachment store. */
export async function copyAttachment(input: {
  workspace: string
  stateRoot: string
  teamId: string
  sourcePath: string
  allowedScopes: readonly string[]
  artifactRoots?: readonly ArtifactRootConfig[]
}): Promise<MessageAttachment> {
  const relative = normalizedRelative(input.sourcePath)
  if (isDefaultExcludedPath(relative)) fail('attachment path is excluded from delivery')
  const workspaceRoot = await realpath(input.workspace)
  const memberAllowed = input.allowedScopes.some(scope => pathMatchesScope(relative, scope))
  let root = workspaceRoot
  if (!memberAllowed) {
    const roots = (input.artifactRoots ?? []).filter(root => root.allowRead && (root.allowTeamIds === undefined || root.allowTeamIds.includes(input.teamId)))
    let found: string | undefined
    for (const artifactRoot of roots) {
      try {
        const canonical = await realpath(artifactRoot.path)
        if (within(canonical, await realpath(join(artifactRoot.path, relative)))) { found = canonical; break }
      } catch {}
    }
    if (found === undefined) fail('attachment is outside the current task scope and owner artifact roots')
    root = found
  }
  const candidate = join(root, relative)
  await assertNoSymlinkComponents(root, relative)
  const before = await lstat(candidate)
  if (!before.isFile() || before.isSymbolicLink()) fail('attachment must be a regular file')
  if (!Number.isSafeInteger(before.nlink) || before.nlink !== 1) fail('attachment hard links are not allowed')
  if (before.size > ATTACHMENT_MAX_BYTES) fail('attachment exceeds the 10 MiB per-file limit')
  const canonical = await realpath(candidate)
  if (!within(root, canonical)) fail('attachment real path escapes its allowed root')
  const stateRootReal = await realpath(input.stateRoot).catch(() => undefined)
  if (stateRootReal !== undefined && within(stateRootReal, canonical)) fail('attachment path is excluded from delivery')
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
  const handle = await open(candidate, fsConstants.O_RDONLY | noFollow)
  try {
    const after = await handle.stat()
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) fail('attachment changed while it was being opened')
    if (!Number.isSafeInteger(after.nlink) || after.nlink !== 1) fail('attachment hard-link state is unavailable or unsafe')
    const bytes = await handle.readFile()
    if (bytes.length !== before.size || bytes.length > ATTACHMENT_MAX_BYTES) fail('attachment size changed while it was being read')
    const mime = detectMime(relative, bytes)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const ext = posix.extname(relative).slice(1).toLowerCase().replace(/^jpeg$/u, 'jpg')
    const storageRef = `attachments/${sha256}.${ext}` as const
    const dir = join(input.stateRoot, input.teamId, 'attachments')
    await mkdir(dir, { recursive: true })
    const path = join(dir, basename(storageRef))
    try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }) } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST')) throw error
    }
    return {
      id: `att-${randomUUID()}`,
      name: basename(relative),
      mime,
      bytes: bytes.length,
      sha256,
      storageRef,
      source: {
        workspaceId: sourceHash(input.workspace),
        sourcePath: relative,
        sourceRealpathHash: createHash('sha256').update(canonical).digest('hex'),
        device: String(before.dev),
        inode: String(before.ino),
        size: before.size,
        mtimeMs: before.mtimeMs,
        sha256,
      },
    }
  } finally {
    await handle.close()
  }
}

/** Copy a bounded ordered set; all-or-nothing before the message is written. */
export async function copyAttachments(input: {
  workspace: string
  stateRoot: string
  teamId: string
  paths: readonly string[]
  allowedScopes: readonly string[]
  artifactRoots?: readonly ArtifactRootConfig[]
}): Promise<MessageAttachment[]> {
  if (input.paths.length === 0) return []
  if (input.paths.length > ATTACHMENT_MAX_FILES) fail('at most 5 attachments are allowed')
  const seen = new Set<string>()
  const out: MessageAttachment[] = []
  let total = 0
  for (const path of input.paths) {
    const normalized = normalizedRelative(path)
    if (seen.has(normalized)) fail(`duplicate attachment "${normalized}"`)
    seen.add(normalized)
    const attachment = await copyAttachment({ ...input, sourcePath: normalized })
    total += attachment.bytes
    if (total > ATTACHMENT_MAX_TOTAL_BYTES) fail('attachments exceed the 25 MiB total limit')
    out.push(attachment)
  }
  return out
}

export function attachmentUrl(teamId: string, attachment: Pick<MessageAttachment, 'storageRef'>): string {
  return `${ATTACHMENT_BASE}${encodeURIComponent(teamId)}/${basename(attachment.storageRef)}`
}

export async function readAttachment(stateRoot: string, teamId: string, file: string): Promise<Buffer | undefined> {
  if (!/^[0-9a-f]{64}\.(?:png|jpg|jpeg|webp|txt|md|json|csv|pdf|zip)$/u.test(file)) return undefined
  try { return await readFile(join(stateRoot, teamId, 'attachments', file)) } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
