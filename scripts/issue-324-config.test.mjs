import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
const component = await readFile(new URL('../src/client/AgentTeamsConfig.tsx', import.meta.url), 'utf8')

test('#324 registers the bundle config page against its settings namespace', () => {
  assert.match(source, /'configForms'/)
  assert.match(source, /installAgentTeamsConfigPage\(ctx\)/)
  assert.match(component, /whileServed\(\[AGENT_TEAMS_CONFIG_ENTRY\]/)
  assert.match(component, /name: 'plugins\.bundle\.config'/)
  assert.match(component, /key: AGENT_TEAMS_BUNDLE_CONFIG_KEY/)
})

test('#324 edits maxMembers with the revision the form displayed', () => {
  assert.match(component, /settingsNumberField\(MAX_MEMBERS_FIELD\)/)
  assert.match(component, /Number\.isSafeInteger\(value\).*value >= 1/s)
  assert.match(component, /onReset=\{\(\) => resetField\(MAX_MEMBERS_FIELD\)\}/)
  assert.match(component, /onDiscard=\{discard\}/)
  assert.match(component, /onSave=\{save\}/)
})
