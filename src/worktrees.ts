/** Opt-in member-lane Git worktree creation and capture (#287). */
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, lstat, realpath } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { WorktreeLane } from './types.ts'

const exec = promisify(execFile)

export interface WorktreeConfig {
  enabled: boolean
  root?: string
  baseRef?: string
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await exec('git', [...args], { cwd, maxBuffer: 4 * 1024 * 1024 })
  return stdout.trim()
}

function safeSegment(value: string, fallback: string): string {
  const normalized = value.normalize('NFC').trim().toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return normalized === '' ? fallback : normalized.slice(0, 48)
}

async function canonicalDirectory(path: string): Promise<string> {
  try {
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) throw new Error('worktree root must not be a symlink')
    if (!stat.isDirectory()) throw new Error('worktree root must be a directory')
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      await mkdir(path, { recursive: true })
    } else throw error
  }
  return realpath(path)
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`)
}

/** Create one lane before the member's first child start. */
export async function createWorktreeLane(input: {
  teamId: string
  memberId: string
  workspace: string
  root: string
  baseRef?: string
}): Promise<WorktreeLane> {
  const repoRoot = await realpath(await git(input.workspace, ['rev-parse', '--show-toplevel']))
  const laneRoot = await canonicalDirectory(input.root)
  if (inside(repoRoot, laneRoot)) throw new Error('worktree root must be outside the repository')
  const baseRef = input.baseRef?.trim() || 'HEAD'
  const baseCommit = await git(repoRoot, ['rev-parse', '--verify', `${baseRef}^{commit}`])
  const laneId = `lane-${randomUUID().slice(0, 12)}`
  const repoKey = `${safeSegment(basename(repoRoot), 'repo')}-${createHash('sha256').update(repoRoot).digest('hex').slice(0, 8)}`
  const worktreePath = join(laneRoot, safeSegment(input.teamId, 'team'), laneId, repoKey)
  const branch = `agent-teams/${safeSegment(input.teamId, 'team')}/${laneId}`
  const worktrees = await git(repoRoot, ['worktree', 'list', '--porcelain'])
  const activePaths = worktrees.split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length))
  if (activePaths.includes(worktreePath)) throw new Error(`worktree path is already registered: ${worktreePath}`)
  try { await git(repoRoot, ['rev-parse', '--verify', `refs/heads/${branch}`]); throw new Error(`worktree branch already exists: ${branch}`) }
  catch (error: unknown) { if (!(error instanceof Error && /Needed a single revision|unknown revision|ambiguous argument/iu.test(error.message))) throw error }
  await mkdir(join(worktreePath, '..'), { recursive: true })
  await git(repoRoot, ['worktree', 'add', '-b', branch, worktreePath, baseCommit])
  return {
    laneId,
    teamId: input.teamId,
    memberId: input.memberId,
    repoRoot,
    worktreePath: await realpath(worktreePath),
    branch,
    baseRef,
    state: 'ready',
    createdAt: Date.now(),
    commit: await git(worktreePath, ['rev-parse', 'HEAD']),
  }
}

/** Capture final commit, dirty flag and changed paths; never mutates the lane. */
export async function captureLaneState(lane: WorktreeLane): Promise<{ commit: string; dirty: boolean; changedPaths: string[] }> {
  const commit = await git(lane.worktreePath, ['rev-parse', 'HEAD'])
  const status = await git(lane.worktreePath, ['status', '--porcelain'])
  const changedPaths = status === '' ? [] : status.split('\n').map(line => line.slice(2).trim()).filter(Boolean)
  return { commit, dirty: changedPaths.length > 0, changedPaths }
}

/** Merge one clean lane branch into the repository's current branch. */
export async function integrateLane(lane: WorktreeLane): Promise<string> {
  const captured = await captureLaneState(lane)
  if (captured.dirty) throw new Error(`worktree lane ${lane.laneId} is dirty; commit or preserve it before integration`)
  const repoStatus = await git(lane.repoRoot, ['status', '--porcelain'])
  if (repoStatus !== '') throw new Error('main workspace is dirty; commit or stash your own changes before integrating a lane')
  await git(lane.repoRoot, ['merge', '--no-ff', '--no-edit', lane.branch])
  return git(lane.repoRoot, ['rev-parse', 'HEAD'])
}

/** Remove one clean, already-integrated lane without force or pruning. */
export async function cleanupLane(lane: WorktreeLane): Promise<void> {
  const captured = await captureLaneState(lane)
  if (captured.dirty) throw new Error(`worktree lane ${lane.laneId} is dirty; cleanup is refused`)
  try {
    await git(lane.repoRoot, ['merge-base', '--is-ancestor', lane.branch, 'HEAD'])
  } catch {
    throw new Error(`worktree lane ${lane.laneId} is not integrated into the current HEAD`)
  }
  await git(lane.repoRoot, ['worktree', 'remove', lane.worktreePath])
}

/** Archive/cancel defaults to preservation; cleanup/integration are separate gates. */
export function preserveLane(lane: WorktreeLane): void {
  if (lane.state !== 'cleaned') lane.state = 'preserved'
}
