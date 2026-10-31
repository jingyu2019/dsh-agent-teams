/** Permanent #117 regressions for lock and activation-context retention. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createActivationContextIndex } from '../lib/scheduler.js'
import { teamLockQueueKeys, withTeamLock } from '../lib/state.js'

test('#117 team lock queue releases every key after repeated serialized work', async () => {
  for (let index = 0; index < 1_000; index += 1) {
    await withTeamLock(`team:lock-audit:${index % 17}`, async () => index)
  }
  assert.deepEqual(teamLockQueueKeys(), [])
})

test('#117 concurrent team lock queues drain without retaining keys', async () => {
  await Promise.all(Array.from({ length: 100 }, (_, index) => withTeamLock(`team:concurrent-audit:${index}`, async () => index)))
  assert.deepEqual(teamLockQueueKeys(), [])
})

test('#117 activation context can forget every deleted team', () => {
  const contexts = createActivationContextIndex()
  for (let index = 0; index < 100; index++) {
    contexts.remember(`team-${index}`, `/workspace/root-${index}`, `/workspace/${index}`)
  }

  assert.deepEqual(contexts.size(), { roots: 100, workspaces: 100 })
  assert.equal(contexts.root('team-42'), '/workspace/root-42')
  assert.equal(contexts.workspace('team-42'), '/workspace/42')

  for (let index = 0; index < 100; index++) contexts.forget(`team-${index}`)

  assert.deepEqual(contexts.size(), { roots: 0, workspaces: 0 })
  assert.equal(contexts.root('team-42'), undefined)
  assert.equal(contexts.workspace('team-42'), undefined)
})

test('#117 activation context forgetting is idempotent', () => {
  const contexts = createActivationContextIndex()
  contexts.remember('team', '/state', '/workspace')
  contexts.forget('team')
  contexts.forget('team')
  assert.deepEqual(contexts.size(), { roots: 0, workspaces: 0 })
})
