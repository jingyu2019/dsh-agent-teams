import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { archiveTeamDir, createTeamDir, deleteArchivedTeamDir, listArchivedTeamIds, readArchivedTeam } from '../lib/state.js'

test('#223 archived team deletion is explicit, scoped and permanent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-teams-223-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await createTeamDir(root, { id: 'old-team', name: 'Old Team', captainSessionId: 'captain', createdAt: 1, phase: 'running', taskSeq: 0, members: [], tasks: [] })
  await archiveTeamDir(root, 'old-team')
  assert.deepEqual(await listArchivedTeamIds(root), ['old-team'])
  assert.equal((await readArchivedTeam(root, 'old-team')).id, 'old-team')
  assert.equal(await deleteArchivedTeamDir(root, 'old-team'), true)
  assert.deepEqual(await listArchivedTeamIds(root), [])
  assert.equal(await deleteArchivedTeamDir(root, 'old-team'), false)
  await assert.rejects(() => deleteArchivedTeamDir(root, '../old-team'), /invalid archived team id/)
})

test('#223 archive delete route and panel are authenticated and confirmation-gated', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const panel = readFileSync(new URL('../src/client/ActivityPanel.tsx', import.meta.url), 'utf8')
  assert.match(source, /path: '\/plugins\/dsh-agent-teams\/archive'/u)
  assert.match(source, /req\.method !== 'DELETE'/u)
  assert.match(source, /archived\.captainSessionId !== captain\.id/u)
  assert.match(panel, /archive\.deleteConfirm/u)
  assert.match(panel, /method: 'DELETE'/u)
})
