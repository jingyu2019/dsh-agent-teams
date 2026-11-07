import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as dshAgent from '@deepseek-ai/dsh-agent'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { installMemberSelection, memberSelectionChannel } from '../lib/harness-compat.js'

/**
 * The member route fix (DSH 0.2.2 audit §III).
 *
 * 0.2.1-rc.5 read a mutable ref during `system-prompt/assemble` and
 * `agent/request`, so writing that ref changed the request already in flight.
 * 0.2.2-rc.1 deleted the ref: `installModelSelection(agentCtx)` only appends
 * the model-switch notice, and the route lives on the Agent
 * (`agent.model.select`) through the `modelSelection` session projection.
 *
 * Detection is capability-based. Parameter lists do not survive bundling, so
 * `installModelSelection.length` is not a version signal and the seam must not
 * read it.
 */

function projectingAgent() {
  const selected = []
  let recorded
  return {
    selected,
    agent: {
      model: {
        current: () => recorded,
        select(selection) {
          selected.push(selection)
          recorded = selection
        },
      },
    },
  }
}

test('host without agent.model keeps the ref as the live route', () => {
  const ref = { current: { provider: 'p', model: 'primary' } }
  const channel = memberSelectionChannel(undefined, ref)
  assert.equal(channel.redirectsInStepRetry, true, 'rc.5 rewrote agent/request from the ref, so an in-step retry could be redirected')
  assert.deepEqual(channel.route(), { provider: 'p', model: 'primary' })
  channel.apply({ provider: 'p', model: 'fallback' })
  assert.deepEqual(ref.current, { provider: 'p', model: 'fallback' })
  assert.deepEqual(ref.assembled, { provider: 'p', model: 'fallback' })
  assert.deepEqual(channel.route(), { provider: 'p', model: 'fallback' })
})

test('host with agent.model records the route on the Agent', () => {
  const ref = { current: { provider: 'p', model: 'primary' } }
  const { agent, selected } = projectingAgent()
  const channel = memberSelectionChannel(agent, ref)
  assert.equal(channel.redirectsInStepRetry, false, '0.2.2 fixes the step route during step preparation')
  assert.deepEqual(channel.route(), { provider: 'p', model: 'primary' }, 'an empty projection falls back to the ref')
  channel.apply({ provider: 'p', model: 'fallback' })
  assert.deepEqual(selected, [{ provider: 'p', model: 'fallback' }])
  assert.deepEqual(channel.route(), { provider: 'p', model: 'fallback' })
  assert.deepEqual(ref.current, { provider: 'p', model: 'fallback' }, 'the ref stays current for our own routing reads')
})

test('installMemberSelection wires the host listeners on either shape and disposes them', () => {
  let installed = 0
  const agentCtx = {
    on() {
      installed += 1
      return () => {
        installed -= 1
      }
    },
  }
  const { agent } = projectingAgent()
  for (const routeOwner of [undefined, agent]) {
    const selection = installMemberSelection(agentCtx, routeOwner, { provider: 'p', model: 'primary' })
    assert.deepEqual(selection.ref.current, { provider: 'p', model: 'primary' })
    assert.equal(selection.channel.redirectsInStepRetry, routeOwner === undefined)
    assert.ok(installed > 0, 'the host installer must register its scoped listeners')
    selection.dispose()
    assert.equal(installed, 0, 'disposing the selection must release every listener')
  }
})

test('the audited host surface still matches the seam split', () => {
  assert.equal(typeof dshAgent.installModelSelection, 'function', 'the seam wraps installModelSelection; removing it means re-auditing docs/upgrade/0.2.2-audit.md §III')
  // 0.2.2+ shape. Absent on rc.5, where the ref is the route, so this branch
  // only guards hosts that own the route.
  if (typeof dshAgent.AgentModel === 'function') {
    assert.equal(typeof dshAgent.AgentModel.prototype.select, 'function', 'agent.model.select is the 0.2.2 route owner; a rename invalidates the seam')
    assert.equal(typeof dshAgent.AgentModel.prototype.current, 'function')
    assert.equal(dshAgent.modelSelectionProjectionDefinition?.stateVersion, 3, 'a projection stateVersion bump invalidates the audited selection shape')
  }
  assert.equal(SESSION_FORMAT_VERSION, 4, 'a session format bump invalidates the audited restore path')
})

test('the seam forks on capability, never on the installer signature', () => {
  const source = readFileSync(new URL('../lib/harness-compat.js', import.meta.url), 'utf8')
  assert.ok(!/installModelSelection\s*\.\s*length/.test(source), 'arity is stripped by bundlers and cannot identify the host generation')
  assert.match(source, /select === 'function'/, 'the fork must probe the Agent capability')
  assert.match(source, /redirectsInStepRetry/, 'callers distinguish the in-step retry semantics through the channel')
})
