import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { parseMaxMembersDraft } from '../src/client/max-members-config.ts'
import { resolveToolsConfig } from '../lib/index.js'

const source = await readFile(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
const component = await readFile(new URL('../src/client/AgentTeamsConfig.tsx', import.meta.url), 'utf8')
const hostConfig = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')

test('#324 registers the bundle config page against its settings namespace', () => {
  assert.match(source, /'configForms'/)
  assert.match(source, /installAgentTeamsConfigPage\(ctx\)/)
  assert.match(component, /whileServed\(\[AGENT_TEAMS_CONFIG_ENTRY\]/)
  assert.match(component, /name: 'plugins\.bundle\.config'/)
  assert.match(component, /key: AGENT_TEAMS_BUNDLE_CONFIG_KEY/)
})

test('#324 edits maxMembers with the revision the form displayed', () => {
  assert.match(component, /settingsNumberField\(MAX_MEMBERS_FIELD\)/)
  assert.match(component, /parse: parseMaxMembersDraft/)
  assert.match(component, /onReset=\{\(\) => resetField\(MAX_MEMBERS_FIELD\)\}/)
  assert.match(component, /onDiscard=\{discard\}/)
  assert.match(component, /onSave=\{save\}/)
})

test('#324 exposes maxMembers to the Host settings form', () => {
  assert.match(hostConfig, /maxMembers:\s*z\.natural\(\)\.min\(1\)\.default\(8\)\.volatile\(\)/)
})

test('#324 reads saved maxMembers changes from the live Config reference', () => {
  let current = 8
  const config = resolveToolsConfig({ maxMembers: { get: () => current } })
  assert.equal(config.maxMembers, 8)
  assert.equal(config.maxConcurrentWorkers, 8)
  current = 12
  assert.equal(config.maxMembers, 12)
  assert.equal(config.maxConcurrentWorkers, 12)
})

test('#324 accepts only positive safe integers and clears blank drafts', () => {
  assert.deepEqual(parseMaxMembersDraft('1'), { kind: 'set', value: 1 })
  assert.deepEqual(parseMaxMembersDraft(' 42 '), { kind: 'set', value: 42 })
  assert.deepEqual(parseMaxMembersDraft(''), { kind: 'clear' })
  assert.deepEqual(parseMaxMembersDraft('   '), { kind: 'clear' })
  for (const draft of ['0', '-1', '-0', '1.5', 'Infinity', '9007199254740992', 'nope']) {
    assert.equal(parseMaxMembersDraft(draft), undefined, `draft ${JSON.stringify(draft)} must be rejected`)
  }
})
