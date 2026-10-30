import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AVATAR_MAX_BYTES, avatarUrl, memberAvatarRef, parseRasterAvatar, readManagedAvatar, storeManagedAvatar } from '../lib/avatars.js'
import { createTeamDir, readTeam } from '../lib/state.js'
import { assembleTeamSnapshot } from '../lib/snapshot.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

test('#121 raster validation accepts only supported local image signatures', () => {
  const png = parseRasterAvatar(PNG)
  assert.equal(png?.ext, 'png')
  assert.equal(png?.mime, 'image/png')
  assert.match(png?.sha256 ?? '', /^[0-9a-f]{64}$/u)
  assert.equal(parseRasterAvatar(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), undefined)
  assert.equal(parseRasterAvatar(Buffer.from('<!doctype html>')), undefined)
  assert.equal(parseRasterAvatar(Buffer.alloc(AVATAR_MAX_BYTES + 1)), undefined)
})

test('#121 avatar storage is content-addressed and restores through durable state', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-121-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const stateRoot = join(workspace, '.agent-teams')
  const avatar = parseRasterAvatar(PNG)
  assert.ok(avatar)
  const ref = await storeManagedAvatar(stateRoot, 'avatar-team', avatar)
  assert.deepEqual(ref, { kind: 'managed', sha256: avatar.sha256, ext: 'png' })
  const read = await readManagedAvatar(stateRoot, 'avatar-team', ref)
  assert.deepEqual(read?.bytes, PNG)
  assert.equal(read?.mime, 'image/png')

  await createTeamDir(stateRoot, {
    id: 'avatar-team', name: 'Avatar Team', captainSessionId: 'captain', createdAt: 1, phase: 'running', taskSeq: 0,
    members: [{ id: 'child-1', name: 'Scout', role: 'researcher', joinedAt: 1, status: 'idle' }], tasks: [], memberAvatars: { Scout: ref },
  })
  const team = await readTeam(stateRoot, 'avatar-team')
  assert.deepEqual(team.memberAvatars.Scout, ref)
  assert.equal(memberAvatarRef(team, team.members[0])?.kind, 'managed')
  assert.equal(avatarUrl('avatar-team', team.memberAvatars.Scout), `/plugins/dsh-agent-teams/avatar/avatar-team/${ref.sha256}.png`)
  const snapshot = await assembleTeamSnapshot({ logger: { warn() {} } }, stateRoot, workspace, team, { historic: true })
  assert.equal(snapshot.members[0].avatarUrl, avatarUrl('avatar-team', ref))
})

test('#121 avatar route is authenticated, bounded and local-only', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const panel = readFileSync(new URL('../src/client/ActivityPanel.tsx', import.meta.url), 'utf8')
  assert.match(source, /path: '\/plugins\/dsh-agent-teams\/avatar'/u)
  assert.match(source, /readJsonRequest\(req, 4_000_000\)/u)
  assert.match(source, /parseRasterAvatar\(Buffer\.from\(data, 'base64'\)\)/u)
  assert.match(source, /avatar must be a PNG, JPEG or WebP image up to 2 MiB/u)
  assert.match(panel, /accept="image\/png,image\/jpeg,image\/webp"/u)
  assert.match(panel, /member\.avatarUrl/u)
})
