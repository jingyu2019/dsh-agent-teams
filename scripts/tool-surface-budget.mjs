#!/usr/bin/env node
/**
 * Measure the rendered captain/member tool surface without a live host.
 *
 * The host sends every visible tool definition (name, description, parameter
 * schema) to the model on each request. This script registers the real tool
 * definitions against a stub context and reports their serialized size for the
 * full and `toolSurface: core` surfaces. Byte counts are exact; the token
 * column is an explicit heuristic (about 4 bytes per ASCII token) and is not a
 * provider tokenizer.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerAgentTeamsTools } from '../lib/tools.js'
import { CAPTAIN_TOOL_NAMES, CORE_CAPTAIN_TOOL_NAMES, MEMBER_TOOL_NAMES } from '../lib/tool-names.js'

const noop = () => {}

function fakeAgent(id, cwd) {
  return {
    id,
    status: 'idle',
    options: { provider: 'p', model: 'm' },
    session: {
      id, seq: 0, header: { cwd, seedLength: 0 }, events: [], append() {},
      snapshotEvents: () => [],
      requestHeader: () => ({ config: { provider: 'p', model: 'm', reasoningEffort: 'high' } }),
    },
    followup() {}, steer() {}, cancel() {}, whenIdle() { return Promise.resolve() },
  }
}

/** Register the real definitions and return them keyed by tool name. */
export async function collectToolDefinitions() {
  const workspace = await mkdtemp(join(tmpdir(), 'tool-surface-budget-'))
  try {
    const captain = fakeAgent('captain', workspace)
    const definitions = new Map()
    const listeners = new Map()
    const ctx = {
      effect(setup) { return setup() },
      on(name, listener) {
        const list = listeners.get(name) ?? []
        list.push(listener)
        listeners.set(name, list)
        return () => listeners.set(name, list.filter(item => item !== listener))
      },
      tools: { register(definition) { definitions.set(definition.name, definition) } },
      agents: { list: () => [captain], get: id => id === captain.id ? captain : undefined },
      llm: {
        async listModels(provider) { return [{ provider, id: 'm', name: 'm' }] },
        async resolveCallConfig(config) { return config },
      },
      subagents: {
        getProvider() { return undefined },
        list() { return [] },
        registerContinuableSetup() { return noop },
        async followup() { return 'queued' },
        async sendMessage() { return 'sent' },
        interrupt() {},
        async listChildren() { return [] },
        async listDescendants() { return [] },
        async drainContinuableChildren() {},
      },
      logger: { warn: noop, debug: noop },
    }
    registerAgentTeamsTools(ctx, {
      stateDir: '.agent-teams', memberProvider: 'spawn', memberMaxDepth: 0, maxMembers: 8,
      profiles: {}, toolPolicies: {}, skills: {},
    })
    return definitions
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

/** Exact serialized bytes for one tool definition. */
export function toolBytes(definition) {
  return Buffer.byteLength(JSON.stringify({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
  }))
}

function surface(definitions, names) {
  const rows = names.map(name => {
    const definition = definitions.get(name)
    if (definition === undefined) throw new Error(`tool definition missing: ${name}`)
    return { name, bytes: toolBytes(definition) }
  })
  const bytes = rows.reduce((total, row) => total + row.bytes, 0)
  return { tools: rows.length, bytes, estimatedTokens: Math.ceil(bytes / 4), rows }
}

/** Compare the full captain/member surfaces with the opt-in core surface. */
export function measureToolSurfaces(definitions) {
  const captain = surface(definitions, CAPTAIN_TOOL_NAMES)
  const coreCaptain = surface(definitions, CORE_CAPTAIN_TOOL_NAMES)
  const member = surface(definitions, MEMBER_TOOL_NAMES)
  return {
    captain,
    coreCaptain,
    member,
    savings: {
      tools: captain.tools - coreCaptain.tools,
      bytes: captain.bytes - coreCaptain.bytes,
      percent: captain.bytes === 0 ? 0 : Math.round((1 - coreCaptain.bytes / captain.bytes) * 1000) / 10,
    },
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').at(-1))) {
  const definitions = await collectToolDefinitions()
  process.stdout.write(JSON.stringify(measureToolSurfaces(definitions), null, 2) + '\n')
}
