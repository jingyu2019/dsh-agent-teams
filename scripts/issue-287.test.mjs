import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { access, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { spawnMember } from '../lib/members.js'
import { captureLaneState, cleanupLane, createWorktreeLane, integrateLane } from '../lib/worktrees.js'

const exec = promisify(execFile)
async function git(cwd, ...args) { return (await exec('git', args, { cwd })).stdout.trim() }

function fakeCaptain(cwd) {
  return {
    id: 'captain', status: 'idle', options: { provider: 'p', model: 'm' },
    session: { id: 'captain', seq: 0, header: { cwd, seedLength: 0 }, events: [], append() {}, snapshotEvents: () => [], requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) },
    followup() {}, steer() {}, cancel() {}, whenIdle() { return Promise.resolve() },
  }
}

async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), 'agent-teams-287-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const repo = join(parent, 'repo')
  const worktreeRoot = join(parent, 'worktrees')
  await mkdir(repo, { recursive: true })
  await git(repo, 'init', '-q')
  await git(repo, 'config', 'user.email', 'test@example.com')
  await git(repo, 'config', 'user.name', 'Test')
  await writeFile(join(repo, 'README.md'), 'hello\n')
  await git(repo, 'add', 'README.md')
  await git(repo, 'commit', '-qm', 'initial')
  const captain = fakeCaptain(repo)
  const starts = []
  const ctx = {
    effect(setup) { return setup() }, on() { return () => {} },
    tools: { register() {} },
    agents: { list: () => [captain], get: id => id === captain.id ? captain : undefined },
    llm: { async listModels(provider) { return [{ provider, id: 'm', name: 'm' }] }, async resolveCallConfig(config) { return config } },
    subagents: {
      getProvider(name) { return name === 'spawn' ? { prepareContinuable() {}, capabilities: { persona: true, toolFilter: true } } : undefined },
      list() { return ['spawn'] }, registerContinuableSetup() { return () => {} },
      async startActivation(spec) {
        starts.push(spec)
        return { childId: spec.childId ?? 'child-worker', messageId: 'm1', result: Promise.resolve({ stopReason: 'completed' }), dispose: async () => {} }
      },
      async followup() { return 'queued' }, async sendMessage() { return 'sent' }, interrupt() {},
      async listChildren() { return [] }, async listDescendants() { return [] }, async drainContinuableChildren() {},
    },
    logger: { warn() {}, debug() {} },
  }
  const selections = { async withPending(_parent, _label, _selection, fn) { return fn() } }
  const team = {
    name: 'Worktree Team', id: 'wt-team', captainSessionId: 'captain', createdAt: 1, phase: 'running', taskSeq: 1,
    members: [], tasks: [{ id: 't1', subject: 'Change README', status: 'pending', assignee: 'worker', dependencies: [], createdAt: 1, updatedAt: 1 }],
  }
  const member = { id: '', name: 'worker', role: 'engineer', provider: 'p', model: 'm', joinedAt: 1, status: 'idle' }
  team.members.push(member)
  return { repo, worktreeRoot, captain, ctx, selections, team, member, starts }
}

test('#287 a member lane is created once and the child starts in its worktree', async t => {
  const f = await fixture(t)
  const config = { provider: 'spawn', maxDepth: 0, worktrees: { enabled: true, root: f.worktreeRoot, baseRef: 'HEAD' } }
  const selection = { provider: 'p', model: 'm' }
  const first = await spawnMember(f.ctx, config, f.selections, selection, f.captain, f.team, f.member, '.agent-teams', new AbortController().signal, 'first', { deny: ['captain_only'] })
  assert.equal(first.childId, 'child-worker')
  assert.equal(f.team.worktreeLanes.length, 1)
  const lane = f.team.worktreeLanes[0]
  assert.equal(lane.state, 'ready')
  assert.equal(f.member.worktreeLaneId, lane.laneId)
  assert.equal(f.team.tasks[0].worktreeLaneId, lane.laneId)
  assert.equal(f.team.tasks[0].workspace.worktreePath, lane.worktreePath)
  assert.equal(f.starts[0].request.cwd, lane.worktreePath)
  assert.notEqual(lane.worktreePath, f.repo)
  assert.match(lane.branch, /^agent-teams\/wt-team\/lane-/u)

  f.starts.length = 0
  await spawnMember(f.ctx, config, f.selections, selection, f.captain, f.team, f.member, '.agent-teams', new AbortController().signal, 'second', { deny: ['captain_only'] })
  assert.equal(f.team.worktreeLanes.length, 1)
  assert.equal(f.starts[0].request.cwd, lane.worktreePath)
  assert.equal(f.starts[0].childId, first.childId)

  await writeFile(join(lane.worktreePath, 'README.md'), 'changed\n')
  const captured = await captureLaneState(lane)
  assert.equal(captured.dirty, true)
  assert.ok(captured.changedPaths.includes('README.md'))
  assert.match(captured.commit, /^[0-9a-f]{40}$/u)
})

test('#287 invalid base and root inside repository fail before a lane is registered', async t => {
  const f = await fixture(t)
  await assert.rejects(
    () => createWorktreeLane({ teamId: 'x', memberId: 'm', workspace: f.repo, root: f.repo, baseRef: 'HEAD' }),
    /outside the repository/,
  )
  await assert.rejects(
    () => createWorktreeLane({ teamId: 'x', memberId: 'm', workspace: f.repo, root: f.worktreeRoot, baseRef: 'does-not-exist' }),
    /Needed a single revision|unknown revision|ambiguous argument/iu,
  )
})


test('#287 clean integrated lanes can be explicitly merged and cleaned up', async t => {
  const f = await fixture(t)
  const lane = await createWorktreeLane({ teamId: 'wt-team', memberId: 'worker', workspace: f.repo, root: f.worktreeRoot, baseRef: 'HEAD' })
  await writeFile(join(lane.worktreePath, 'lane.txt'), 'lane work\n')
  await git(lane.worktreePath, 'add', 'lane.txt')
  await git(lane.worktreePath, 'commit', '-qm', 'lane work')
  await integrateLane(lane)
  assert.equal((await git(f.repo, 'show', 'HEAD:lane.txt')).trim(), 'lane work')
  await cleanupLane(lane)
  await assert.rejects(() => access(lane.worktreePath), error => error?.code === 'ENOENT')
})


test('#287 worktree integration and cleanup stay confirmation-gated and force-free', () => {
  const source = readFileSync(new URL('../src/tools.ts', import.meta.url), 'utf8')
  const worktrees = readFileSync(new URL('../src/worktrees.ts', import.meta.url), 'utf8')
  assert.match(source, /name: 'agent_teams_worktree'/u)
  assert.match(source, /confirmed_by_user !== true/u)
  assert.match(worktrees, /worktree', 'remove', lane\.worktreePath/u)
})
