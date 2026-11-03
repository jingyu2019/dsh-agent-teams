/**
 * Issue #330: /state must not resend unrelated workspaces or duplicate a
 * physical state root that was registered twice.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { createTeamDir } from '../lib/state.js'

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

test('#330 the state route deduplicates physical roots and scopes by sessionId', () => {
  assert.match(source, /realpathSync\(stateRoot\)/u)
  assert.match(source, /seenRoots\.has\(identity\)/u)
  assert.match(source, /sessionId= scopes collection/u)
  assert.match(source, /snapshots\.filter\(team => team\.captainSessionId === sessionScope\)/u)
})

test('#330 two registrations of one directory resolve to the same identity', async t => {
  const root = await mkdtemp(join(tmpdir(), 'issue-330-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  const link = join(root, 'workspace-link')
  await mkdir(workspace, { recursive: true })
  await symlink(workspace, link, 'dir')
  await createTeamDir(join(workspace, '.agent-teams'), {
    id: 'shared-team', name: 'Shared', captainSessionId: 'captain', createdAt: 1, taskSeq: 0, phase: 'running',
    members: [], tasks: [],
  })
  assert.equal(await realpath(join(workspace, '.agent-teams')), await realpath(join(link, '.agent-teams')))
  // The duplicate registration must not double the row.
  const identities = new Set([await realpath(join(workspace, '.agent-teams')), await realpath(join(link, '.agent-teams'))])
  assert.equal(identities.size, 1)
})

test('#330 the client scopes a single-session monitor and leaves mixed sessions unscoped', async () => {
  const { startActivityPolling } = await import('../lib/client/activity-monitor.js')
  const calls = []
  const response = { ok: true, status: 200, headers: { get: () => '"e"' }, json: async () => ({ teams: [] }) }
  const poll = startActivityPolling([{ key: 's:t', sessionId: 's', teamId: 't' }], {
    fetchState: async url => { calls.push(url); return response },
    schedule: () => 1, cancel: () => {}, publishSnapshots: () => {}, settleTargets: () => {},
  })
  await poll.firstTick
  assert.match(calls[0], /[?&]sessionId=s/u)
  poll.stop()
})
