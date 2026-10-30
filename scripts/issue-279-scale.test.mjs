import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { agentTeamsUiScaleFactor, parseAgentTeamsUiScale } from '../lib/client/ui-scale.js'

test('#279 UI scale preferences are strict, persisted and map to one CSS variable', () => {
  assert.equal(parseAgentTeamsUiScale(null), 'host')
  assert.equal(parseAgentTeamsUiScale('bogus'), 'host')
  assert.equal(parseAgentTeamsUiScale('100'), '100')
  assert.equal(parseAgentTeamsUiScale('125'), '125')
  assert.equal(parseAgentTeamsUiScale('150'), '150')
  assert.equal(agentTeamsUiScaleFactor('host'), '1')
  assert.equal(agentTeamsUiScaleFactor('125'), '1.25')
  assert.equal(agentTeamsUiScaleFactor('150'), '1.5')

  const panel = readFileSync(new URL('../src/client/ActivityPanel.tsx', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../src/client/ActivityPanel.module.css', import.meta.url), 'utf8')
  const locales = readFileSync(new URL('../src/client/locales.ts', import.meta.url), 'utf8')
  assert.match(panel, /AGENT_TEAMS_UI_SCALE_STORAGE_KEY/u)
  assert.match(panel, /data-control="ui-scale"/u)
  assert.match(panel, /--agent-teams-font-scale/u)
  assert.match(css, /var\(--agent-teams-font-scale, 1\)/u)
  assert.doesNotMatch(css, /font-size:\s*(?:[0-9]|10(?:\.[0-9]+)?)px/u)
  assert.match(locales, /'activity\.uiScale\.host'/u)
})
