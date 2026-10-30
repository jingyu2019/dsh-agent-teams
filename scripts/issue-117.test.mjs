import assert from 'node:assert/strict'
import test from 'node:test'
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
