/**
 * Issue #58: lifecycle status is a semantic presentation contract, not an
 * artwork-dependent rendering detail. These tests stay UI-framework-light:
 * the pure model and default renderer are exercised directly, while source
 * assertions pin the panel/CSS lifecycle and the no-new-polling constraint.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  STATUS_ORDER,
  STATUS_PRESENTATIONS,
  defaultStatusRenderer,
  semanticAgentStatus,
  statusMotionState,
  statusPresentation,
} from '../src/client/status-presentation.ts'
import { en, zh } from '../src/client/locales.ts'

const semanticStates = ['idle', 'working', 'waiting', 'completed', 'failed', 'cancelled', 'unknown']

function translator(dictionary) {
  return (key, params = {}) => String(dictionary[key] ?? key).replace(/\{(\w+)\}/gu, (_, name) => String(params[name] ?? ''))
}

function member(overrides = {}) {
  return {
    name: 'member-a',
    role: 'designer',
    activity: 'idle',
    status: 'idle',
    ...overrides,
  }
}

function task(status, state, assignee = 'member-a') {
  return { id: `${assignee}:${status}:${state}`, assignee, status, state }
}

test('the semantic contract has exactly seven stable, role-independent states', () => {
  assert.deepEqual(STATUS_ORDER, semanticStates)
  assert.deepEqual(Object.keys(STATUS_PRESENTATIONS).sort(), [...semanticStates].sort())
  for (const semantic of semanticStates) {
    const presentation = statusPresentation(semantic)
    assert.equal(presentation.semantic, semantic)
    assert.equal(presentation.labelKey, `agent.status.${semantic}`)
    assert.equal(presentation.ariaLabelKey, `agent.status.${semantic}.aria`)
    assert.equal(Object.hasOwn(presentation, 'role'), false)
    assert.equal(Object.hasOwn(presentation, 'avatar'), false)
  }
})

test('lifecycle aggregation maps working, idle, waiting, completion, failure, and cancellation distinctly', () => {
  assert.equal(semanticAgentStatus(member({ activity: 'working' }), []), 'working')
  assert.equal(semanticAgentStatus(member(), []), 'idle')
  assert.equal(semanticAgentStatus(member(), [task('in_progress', 'blocked')]), 'waiting')
  assert.equal(semanticAgentStatus(member(), [task('completed', 'completed')]), 'completed')
  assert.equal(semanticAgentStatus(member(), [task('failed', 'failed')]), 'failed')
  assert.equal(semanticAgentStatus(member(), [task('cancelled', 'cancelled')]), 'cancelled')
  assert.equal(semanticAgentStatus(member({ activity: 'unexpected', status: 'unexpected' }), []), 'unknown')
})

test('lifecycle meaning survives role changes and team-level staged/stopped context', () => {
  const tasks = [task('in_progress', 'blocked')]
  assert.equal(semanticAgentStatus(member({ role: 'engineer' }), tasks), 'waiting')
  assert.equal(semanticAgentStatus(member({ role: 'security reviewer' }), tasks), 'waiting')
  assert.equal(semanticAgentStatus(member(), [], { phase: 'staged' }), 'waiting')
  assert.equal(semanticAgentStatus(member({ activity: 'working' }), [], { halted: true }), 'cancelled')
  assert.equal(semanticAgentStatus(member(), [], { discarded: true }), 'cancelled')
  assert.equal(semanticAgentStatus(member({ activity: 'working' }), [], { phase: 'staged' }), 'working')
})

test('working outranks stale tasks, while failed and cancelled terminal sets remain observable', () => {
  assert.equal(semanticAgentStatus(member({ activity: 'working' }), [task('failed', 'failed')]), 'working')
  assert.equal(semanticAgentStatus(member(), [task('failed', 'failed'), task('completed', 'completed')]), 'failed')
  assert.equal(semanticAgentStatus(member(), [task('cancelled', 'cancelled'), task('completed', 'completed')]), 'cancelled')
  assert.equal(semanticAgentStatus(member(), [task('in_progress', 'running')]), 'waiting')
})

test('default renderer always contains stable visible text and a screen-reader label', () => {
  for (const locale of [zh, en]) {
    const t = translator(locale)
    for (const semantic of semanticStates) {
      const presentation = statusPresentation(semantic)
      const html = renderToStaticMarkup(defaultStatusRenderer.render(presentation, {
        t,
        motionState: statusMotionState(presentation, { mounted: true, hidden: false, reducedMotion: false }),
      }))
      assert.match(html, new RegExp(`data-status="${semantic}"`, 'u'))
      assert.match(html, /role="img"/u)
      assert.match(html, /aria-label="[^"]+"/u)
      assert.match(html, /data-status-label="">[^<]*\S[^<]*<\/span>/u)
      assert.notEqual(t(presentation.labelKey).trim(), '')
      assert.notEqual(t(presentation.ariaLabelKey).trim(), '')
    }
  }
})

test('a replacement renderer receives the unchanged mapping and can change visuals only', () => {
  const calls = []
  const replacement = {
    render(presentation) {
      calls.push(presentation)
      return `visual:${presentation.semantic}`
    },
  }
  const mapped = statusPresentation('failed')
  assert.equal(replacement.render(mapped), 'visual:failed')
  assert.equal(calls[0], mapped)
  assert.equal(mapped.labelKey, 'agent.status.failed')
  assert.equal(mapped.tone, 'danger')
})

test('motion is running only for visible pulse states, paused when hidden, and stopped on unmount', () => {
  const working = statusPresentation('working')
  const completed = statusPresentation('completed')
  assert.equal(statusMotionState(working, { mounted: true, hidden: false, reducedMotion: false }), 'running')
  assert.equal(statusMotionState(working, { mounted: true, hidden: true, reducedMotion: false }), 'paused')
  assert.equal(statusMotionState(working, { mounted: true, hidden: false, reducedMotion: true }), 'none')
  assert.equal(statusMotionState(working, { mounted: false, hidden: false, reducedMotion: false }), 'stopped')
  assert.equal(statusMotionState(completed, { mounted: true, hidden: false, reducedMotion: false }), 'none')
})

test('the panel consumes the existing snapshot and does not add another polling loop', async () => {
  const [panel, status, css] = await Promise.all([
    readFile(new URL('../src/client/ActivityPanel.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/status-presentation.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/ActivityPanel.module.css', import.meta.url), 'utf8'),
  ])
  assert.equal((panel.match(/startActivityPolling\s*\(/gu) ?? []).length, 1)
  assert.doesNotMatch(status, /\b(?:fetch|setInterval|startActivityPolling)\s*\(/u)
  assert.match(panel, /defaultStatusRenderer/u)
  assert.match(panel, /data-status=/u)
  assert.match(css, /\[data-motion-state=['"]paused['"]\]/u)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/u)
  assert.match(css, /animation-play-state:\s*paused/u)
})

test('locale dictionaries cover all visible and accessible status labels', () => {
  const sourceKeys = Object.keys(zh).filter(key => key.startsWith('agent.status.'))
  assert.equal(sourceKeys.length, semanticStates.length * 2)
  for (const semantic of semanticStates) {
    assert.equal(typeof zh[`agent.status.${semantic}`], 'string')
    assert.equal(typeof zh[`agent.status.${semantic}.aria`], 'string')
    assert.equal(typeof en[`agent.status.${semantic}`], 'string')
    assert.equal(typeof en[`agent.status.${semantic}.aria`], 'string')
  }
})
