import assert from 'node:assert/strict'
import test from 'node:test'
import { activityEtag, requestMatchesEtag } from '../lib/web-routes.js'
import { startActivityPolling } from '../lib/client/activity-monitor.js'

const header = value => ({ get: name => name.toLowerCase() === 'etag' ? value : null })
const response = (status, etag, body) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: etag === undefined ? undefined : header(etag),
  json: async () => {
    if (status === 304) throw new Error('304 body must not be parsed')
    return body
  },
})
async function until(predicate) {
  const deadline = Date.now() + 1000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for polling state')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('activity ETags are stable and If-None-Match supports lists', () => {
  const body = JSON.stringify({ teams: [] })
  const etag = activityEtag(body)
  assert.match(etag, /^"[A-Za-z0-9_-]+"$/)
  assert.equal(activityEtag(body), etag)
  assert.notEqual(activityEtag(body + ' '), etag)
  assert.equal(requestMatchesEtag(etag, etag), true)
  assert.equal(requestMatchesEtag(`"older", ${etag}`, etag), true)
  assert.equal(requestMatchesEtag([`"older"`, etag], etag), true)
  assert.equal(requestMatchesEtag('"older"', etag), false)
  assert.equal(requestMatchesEtag(undefined, etag), false)
})

test('activity polling revalidates live and archive snapshots without duplicate publication', async () => {
  const calls = []
  const published = []
  let scheduled
  const target = { key: 'session:team', sessionId: 'session', teamId: 'team' }
  const poll = startActivityPolling([target], {
    fetchState: async (url, init) => {
      calls.push({ url, init })
      if (calls.length === 1) return response(200, '"live-1"', { teams: [] })
      if (calls.length === 2) return response(200, '"archive-1"', { teams: [] })
      if (calls.length === 3) return response(304, '"live-1"')
      if (calls.length === 4) return response(304, '"archive-1"')
      throw new Error('unexpected poll')
    },
    schedule: callback => { scheduled = callback; return 1 },
    cancel: () => {},
    publishSnapshots: update => published.push(update),
    settleTargets: () => {},
  })

  await poll.firstTick
  assert.equal(calls.length, 2)
  assert.equal(calls[0].init.headers, undefined)
  assert.equal(calls[1].init.headers, undefined)
  assert.deepEqual(published, [{ teams: [] }, { archivedTeams: [] }])

  scheduled()
  await until(() => calls.length === 4)
  assert.equal(calls[2].init.headers?.['if-none-match'], '"live-1"')
  assert.equal(calls[3].init.headers?.['if-none-match'], '"archive-1"')
  assert.equal(published.length, 2, '304 responses must not republish unchanged snapshots')
  poll.stop()
})
