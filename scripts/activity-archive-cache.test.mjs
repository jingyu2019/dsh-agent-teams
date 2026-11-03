import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ARCHIVED_SNAPSHOT_CACHE_LIMIT,
  archivedSnapshotCacheSize,
  clearArchivedSnapshotCache,
  collectArchivedTeamsActivity,
} from '../lib/snapshot.js'
import { archiveTeamDir, createTeamDir, writeTeam } from '../lib/state.js'

const ctx = { logger: { warn() {} } }

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'archive-cache-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

function team(id, name = id) {
  return {
    id, name, captainSessionId: `captain-${id}`, createdAt: 1, taskSeq: 0, phase: 'running',
    members: [{ name: 'worker', id: `worker-${id}`, status: 'idle', joinedAt: 1 }],
    tasks: [{ id: 't1', subject: 'work', status: 'completed', assignee: 'worker', dependencies: [], createdAt: 1, updatedAt: 2 }],
  }
}

test('archived snapshots are reused until team.json changes', async t => {
  clearArchivedSnapshotCache()
  const root = await workspace(t)
  await createTeamDir(root, team('cache-team', 'First'))
  await archiveTeamDir(root, 'cache-team')
  const roots = [{ workspace: 'ws', stateRoot: root }]

  const first = await collectArchivedTeamsActivity(ctx, roots)
  assert.equal(first.length, 1)
  assert.equal(first[0].name, 'First')
  assert.equal(archivedSnapshotCacheSize(), 1)

  const second = await collectArchivedTeamsActivity(ctx, roots)
  assert.equal(second[0], first[0], 'unchanged archive must reuse the cached snapshot object')

  const updated = team('cache-team', 'Second')
  await writeTeam(join(root, 'archive'), updated)
  const third = await collectArchivedTeamsActivity(ctx, roots)
  assert.equal(third[0].name, 'Second')
  assert.notEqual(third[0], first[0])
  assert.equal(archivedSnapshotCacheSize(), 1)
})

test('deleted archives are evicted from the cache', async t => {
  clearArchivedSnapshotCache()
  const root = await workspace(t)
  await createTeamDir(root, team('gone-team'))
  await archiveTeamDir(root, 'gone-team')
  const roots = [{ workspace: 'ws', stateRoot: root }]
  await collectArchivedTeamsActivity(ctx, roots)
  assert.equal(archivedSnapshotCacheSize(), 1)
  await rm(join(root, 'archive', 'gone-team'), { recursive: true, force: true })
  const snapshots = await collectArchivedTeamsActivity(ctx, roots)
  assert.deepEqual(snapshots, [])
  assert.equal(archivedSnapshotCacheSize(), 0)
})

test('archives in different state roots never share a cache entry', async t => {
  clearArchivedSnapshotCache()
  const left = await workspace(t)
  const right = await workspace(t)
  await createTeamDir(left, team('same-id', 'Left'))
  await createTeamDir(right, team('same-id', 'Right'))
  await archiveTeamDir(left, 'same-id')
  await archiveTeamDir(right, 'same-id')
  const snapshots = await collectArchivedTeamsActivity(ctx, [
    { workspace: 'left', stateRoot: left },
    { workspace: 'right', stateRoot: right },
  ])
  assert.deepEqual(snapshots.map(snapshot => snapshot.name).sort(), ['Left', 'Right'])
  assert.equal(archivedSnapshotCacheSize(), 2)
})

test('the archived snapshot cache stays bounded', async t => {
  clearArchivedSnapshotCache()
  const root = await workspace(t)
  const count = ARCHIVED_SNAPSHOT_CACHE_LIMIT + 8
  for (let index = 0; index < count; index++) {
    const id = `bulk-${index}`
    await createTeamDir(root, { ...team(id), members: [], tasks: [] })
    await archiveTeamDir(root, id)
  }
  const snapshots = await collectArchivedTeamsActivity(ctx, [{ workspace: 'ws', stateRoot: root }])
  assert.equal(snapshots.length, count)
  assert.equal(archivedSnapshotCacheSize(), ARCHIVED_SNAPSHOT_CACHE_LIMIT)
})

test('an invalid cached archive is dropped instead of serving stale data', async t => {
  clearArchivedSnapshotCache()
  const root = await workspace(t)
  await createTeamDir(root, team('broken-team'))
  await archiveTeamDir(root, 'broken-team')
  const roots = [{ workspace: 'ws', stateRoot: root }]
  await collectArchivedTeamsActivity(ctx, roots)
  assert.equal(archivedSnapshotCacheSize(), 1)
  await writeFile(join(root, 'archive', 'broken-team', 'team.json'), '{not json', 'utf8')
  const snapshots = await collectArchivedTeamsActivity(ctx, roots)
  assert.deepEqual(snapshots, [])
  assert.equal(archivedSnapshotCacheSize(), 0)
})

test('missing archive directory is handled without touching the cache', async t => {
  clearArchivedSnapshotCache()
  const root = await workspace(t)
  await mkdir(root, { recursive: true })
  assert.deepEqual(await collectArchivedTeamsActivity(ctx, [{ workspace: 'ws', stateRoot: root }]), [])
  assert.equal(archivedSnapshotCacheSize(), 0)
})
