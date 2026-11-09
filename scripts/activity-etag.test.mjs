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

test('activity polling revalidates the live snapshot and skips an unchanged archive', async () => {
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
  await until(() => calls.length === 3)
  assert.equal(calls[2].init.headers?.['if-none-match'], '"live-1"')
  // Archives are immutable per team generation. Once every explicit target is
  // found and no replacement was published, an unchanged live snapshot must
  // not drag the archive along on every tick.
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(calls.length, 3, 'an unchanged archive must not be refetched on every tick')
  assert.equal(published.length, 2, '304 responses must not republish unchanged snapshots')
  poll.stop()
})

test('scoped polling names the session once and keeps the archive query valid', async () => {
  const calls = []
  let scheduled
  const target = { key: 'session:team', sessionId: 'session', teamId: 'team' }
  const poll = startActivityPolling([target], {
    fetchState: async (url) => {
      calls.push(url)
      return response(200, '"e"', { teams: [] })
    },
    schedule: callback => { scheduled = callback; return 1 },
    cancel: () => {},
    publishSnapshots: () => {},
    settleTargets: () => {},
  })
  await poll.firstTick
  assert.equal(calls[0], '/plugins/dsh-agent-teams/state?session=session&summary=1')
  assert.equal(calls[1], '/plugins/dsh-agent-teams/state?archived=1&session=session')
  poll.stop()
})

test('mixed-session targets keep the unscoped union query', async () => {
  const calls = []
  const poll = startActivityPolling([
    { key: 'a:t', sessionId: 'a', teamId: 't' },
    { key: 'b:u', sessionId: 'b', teamId: 'u' },
  ], {
    fetchState: async (url) => { calls.push(url); return response(200, '"e"', { teams: [] }) },
    schedule: () => 1,
    cancel: () => {},
    publishSnapshots: () => {},
    settleTargets: () => {},
  })
  await poll.firstTick
  assert.equal(calls[0], '/plugins/dsh-agent-teams/state')
  poll.stop()
})

test('a hidden document polls at the slow cadence and reschedules on visibility', async () => {
  const intervals = []
  let listener
  let visibility
  let hidden = true
  const poll = startActivityPolling([{ key: 's:t', sessionId: 's', teamId: 't' }], {
    fetchState: async () => response(200, '"e"', { teams: [] }),
    schedule: (callback, intervalMs) => { intervals.push(intervalMs); listener = callback; return 1 },
    cancel: () => {},
    publishSnapshots: () => {},
    settleTargets: () => {},
    documentHidden: () => hidden,
    subscribeVisibility: callback => { visibility = callback; return () => {} },
  })
  await poll.firstTick
  assert.equal(intervals.at(-1), 10_000)
  hidden = false
  visibility()
  assert.equal(intervals.at(-1), 1_000)
  poll.stop()
})
