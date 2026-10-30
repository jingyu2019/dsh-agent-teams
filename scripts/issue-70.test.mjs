import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { copyAttachments, copyAttachment } from '../lib/attachments.js'
import { createTeamDir, readMailbox } from '../lib/state.js'
import { registerAgentTeamsTools } from '../lib/tools.js'

function fakeAgent(id, cwd) {
  return {
    id, status: 'idle', options: { provider: 'p', model: 'm' },
    session: {
      id, seq: 0, header: { cwd, seedLength: 0 }, events: [], append() {},
      snapshotEvents: () => [], requestHeader: () => ({ config: { provider: 'p', model: 'm', reasoningEffort: 'high' } }),
    },
    followup() {}, steer() {}, cancel() {}, whenIdle() { return Promise.resolve() },
  }
}

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-70-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const stateRoot = join(workspace, '.agent-teams')
  const captain = fakeAgent('captain', workspace)
  const worker = fakeAgent('child-worker', workspace)
  await mkdir(join(workspace, 'out'), { recursive: true })
  await writeFile(join(workspace, 'out', 'report.md'), '# Report\n\nDone.\n')
  await writeFile(join(workspace, '.env'), 'SECRET=1\n')
  await createTeamDir(stateRoot, {
    id: 'attach-team', name: 'Attach Team', captainSessionId: 'captain', createdAt: 1, phase: 'running', taskSeq: 1,
    members: [{ id: 'child-worker', name: 'worker', joinedAt: 1, status: 'idle' }],
    tasks: [{ id: 't1', subject: 'Produce a report', status: 'in_progress', assignee: 'worker', dependencies: [], attempt: 1, attemptId: 'a1', inScope: ['out/'], createdAt: 1, updatedAt: 1 }],
  })
  const definitions = new Map()
  const noop = () => {}
  const ctx = {
    effect(setup) { return setup() }, on() { return noop },
    tools: { register(definition) { definitions.set(definition.name, definition) } },
    agents: { list: () => [captain, worker], get: id => id === captain.id ? captain : id === worker.id ? worker : undefined },
    llm: { async listModels(provider) { return [{ provider, id: 'm', name: 'm' }] }, async resolveCallConfig(config) { return config } },
    subagents: {
      getProvider(name) { return name === 'spawn' ? { prepareContinuable() {}, capabilities: { persona: true, toolFilter: true } } : undefined },
      list() { return ['spawn'] }, registerContinuableSetup() { return noop },
      async followup() { return 'queued' }, async sendMessage() { return 'sent' }, interrupt() {},
      async listChildren() { return [] }, async listDescendants() { return [] }, async drainContinuableChildren() {},
    },
    logger: { warn: noop, debug: noop },
  }
  registerAgentTeamsTools(ctx, { stateDir: '.agent-teams', memberProvider: 'spawn', memberMaxDepth: 0, maxMembers: 8, profiles: {}, toolPolicies: {}, skills: {} })
  const call = (name, agent, args) => definitions.get(name).execute(args, { agent, callId: `${name}-test`, signal: new AbortController().signal })
  return { workspace, stateRoot, captain, worker, call }
}

test('#70 member attachments are safely copied and persisted on the mailbox', async t => {
  const f = await fixture(t)
  const result = await f.call('agent_teams_send_message', f.worker, { to: 'captain', content: 'report attached', attachments: ['out/report.md'] })
  assert.ok(result.delivered === 'live' || result.delivered === 'mailbox')
  const mailbox = await readMailbox(f.stateRoot, 'attach-team', 'captain')
  assert.equal(mailbox.length, 1)
  assert.equal(mailbox[0].attachments.length, 1)
  const attachment = mailbox[0].attachments[0]
  assert.equal(attachment.name, 'report.md')
  assert.equal(attachment.mime, 'text/markdown; charset=utf-8')
  assert.match(attachment.storageRef, /^attachments\/[0-9a-f]{64}\.md$/u)
  assert.equal(attachment.source.sourcePath, 'out/report.md')
  assert.equal(attachment.sha256, attachment.source.sha256)
})

test('#70 attachment scope rejects traversal, secrets, symlinks, hardlinks and mismatched bytes', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-70-reject-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const stateRoot = join(workspace, '.agent-teams')
  await mkdir(join(workspace, 'out'), { recursive: true })
  await writeFile(join(workspace, 'out', 'ok.txt'), 'ok')
  await writeFile(join(workspace, '.env'), 'secret')
  await writeFile(join(workspace, 'out', 'bad.png'), 'not a png')
  await mkdir(join(stateRoot, 'other'), { recursive: true })
  await writeFile(join(stateRoot, 'other', 'team.json'), '{"name":"other"}')
  await mkdir(join(workspace, '.dsh'), { recursive: true })
  await writeFile(join(workspace, '.dsh', 'secret.txt'), 'private')
  for (const [dir, file] of [['artifacts/.git', 'config.txt'], ['artifacts/node_modules', 'payload.json'], ['artifacts/secrets', 'token.txt']]) {
    await mkdir(join(workspace, dir), { recursive: true })
    await writeFile(join(workspace, dir, file), 'protected')
  }
  await symlink(join(workspace, '.env'), join(workspace, 'out', 'link.txt'))
  await link(join(workspace, '.env'), join(workspace, 'out', 'hard.txt'))
  const base = { workspace, stateRoot, teamId: 't', allowedScopes: ['out/'] }
  assert.equal((await copyAttachment({ ...base, sourcePath: 'out/ok.txt' })).name, 'ok.txt')
  await assert.rejects(() => copyAttachment({ ...base, sourcePath: '../.env' }), /invalid segment/)
  await assert.rejects(() => copyAttachment({ ...base, sourcePath: '.env' }), /outside the current task scope|excluded from delivery/)
  await assert.rejects(() => copyAttachment({ ...base, allowedScopes: ['.'], sourcePath: '.env' }), /excluded from delivery/)
  await assert.rejects(() => copyAttachment({ ...base, sourcePath: '.agent-teams/other/team.json' }), /outside the current task scope|excluded from delivery/)
  await assert.rejects(
    () => copyAttachment({ ...base, sourcePath: 'team.json', artifactRoots: [{ id: 'state', path: join(stateRoot, 'other'), allowRead: true }] }),
    /excluded from delivery/,
  )
  await assert.rejects(
    () => copyAttachment({ ...base, sourcePath: 'secret.txt', artifactRoots: [{ id: 'dsh', path: join(workspace, '.dsh'), allowRead: true }] }),
    /excluded from delivery/,
  )
  for (const [dir, file] of [['artifacts/.git', 'config.txt'], ['artifacts/node_modules', 'payload.json'], ['artifacts/secrets', 'token.txt']]) {
    await assert.rejects(
      () => copyAttachment({ ...base, sourcePath: file, artifactRoots: [{ id: dir, path: join(workspace, dir), allowRead: true }] }),
      /excluded from delivery/,
    )
  }
  await assert.rejects(() => copyAttachment({ ...base, sourcePath: 'out/link.txt' }), /symlink/)
  await assert.rejects(() => copyAttachment({ ...base, sourcePath: 'out/hard.txt' }), /hard links/)
  await assert.rejects(() => copyAttachment({ ...base, sourcePath: 'out/bad.png' }), /PNG signature/)
})

test('#70 owner artifact roots allow captain attachments and total limits stay bounded', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-70-root-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const root = join(workspace, 'artifacts')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'note.txt'), 'owner note')
  const stateRoot = join(workspace, '.agent-teams')
  const item = await copyAttachment({
    workspace, stateRoot, teamId: 't', sourcePath: 'note.txt', allowedScopes: [],
    artifactRoots: [{ id: 'artifacts', path: root, allowRead: true }],
  })
  assert.equal(item.name, 'note.txt')
  await assert.rejects(
    () => copyAttachments({ workspace, stateRoot, teamId: 't', paths: Array.from({ length: 6 }, (_, index) => `artifacts/n${index}.txt`), allowedScopes: [], artifactRoots: [{ id: 'artifacts', path: root, allowRead: true }] }),
    /at most 5 attachments/,
  )
})

test('#70 attachment route and panel stay authenticated and local', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const panel = readFileSync(new URL('../src/client/ActivityPanel.tsx', import.meta.url), 'utf8')
  assert.match(source, /path: '\/plugins\/dsh-agent-teams\/attachment\/'/u)
  assert.match(source, /readAttachment\(stateRoot, team\.id, file\)/u)
  assert.match(source, /'x-content-type-options': 'nosniff'/u)
  assert.match(panel, /message\.attachments\?\.map/u)
})
