import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
const component = await readFile(new URL('../src/client/AgentTeamsConfig.tsx', import.meta.url), 'utf8')

test('#324 registers the bundle config page against its settings namespace', () => {
  assert.match(source, /'configForms'/)
  assert.match(source, /whileServed\(\['agent-teams'\]/)
  assert.match(source, /name: 'plugins\.bundle\.config'/)
  assert.match(source, /key: '@nanmicoder\/dsh-agent-teams'/)
})

test('#324 edits maxMembers with the revision the form displayed', () => {
  assert.match(component, /path: \['maxMembers'\]/)
  assert.match(component, /form\?\.mutate\(\[.*revision\)/s)
  assert.match(component, /Number\.isSafeInteger\(parsed\).*parsed < 1/s)
})
