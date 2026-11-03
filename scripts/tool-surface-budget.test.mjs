import assert from 'node:assert/strict'
import test from 'node:test'
import { collectToolDefinitions, measureToolSurfaces, toolBytes } from './tool-surface-budget.mjs'
import { CAPTAIN_TOOL_NAMES, CORE_CAPTAIN_TOOL_NAMES, MEMBER_TOOL_NAMES } from '../lib/tool-names.js'

test('tool surface budget measures the real registered definitions', async () => {
  const definitions = await collectToolDefinitions()
  const measured = measureToolSurfaces(definitions)
  assert.equal(measured.captain.tools, CAPTAIN_TOOL_NAMES.length)
  assert.equal(measured.coreCaptain.tools, CORE_CAPTAIN_TOOL_NAMES.length)
  assert.equal(measured.member.tools, MEMBER_TOOL_NAMES.length)
  assert.ok(measured.captain.bytes > measured.coreCaptain.bytes)
  assert.equal(measured.savings.tools, CAPTAIN_TOOL_NAMES.length - CORE_CAPTAIN_TOOL_NAMES.length)
  assert.equal(measured.savings.bytes, measured.captain.bytes - measured.coreCaptain.bytes)
  for (const row of measured.captain.rows) {
    assert.equal(row.bytes, toolBytes(definitions.get(row.name)))
    assert.ok(row.bytes > 0)
  }
})

test('core tool surface omits only advanced captain tools', async () => {
  const definitions = await collectToolDefinitions()
  const measured = measureToolSurfaces(definitions)
  const coreNames = new Set(measured.coreCaptain.rows.map(row => row.name))
  for (const name of CORE_CAPTAIN_TOOL_NAMES) assert.ok(coreNames.has(name))
  const advanced = measured.captain.rows.filter(row => !coreNames.has(row.name))
  assert.ok(advanced.length > 0)
  assert.ok(advanced.every(row => !row.name.includes('claim_task') && !row.name.includes('send_message')))
})
