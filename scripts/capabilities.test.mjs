import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { SystemPrompt, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { installTeamCapabilities, TEAM_MEMBER_PROMPT } from '../lib/capabilities.js'
import { TEAM_TOOL_NAMES, MEMBER_TOOL_NAMES } from '../lib/tool-names.js'
import { usageSectionText } from '../lib/index.js'
import { formatProfilesForPrompt } from '../lib/profiles.js'
import { registerAgentTeamsTools } from '../lib/tools.js'
import { createTeamDir, archiveTeamDir, recordRetiredMemberIds } from '../lib/state.js'

const requireTools = createRequire(import.meta.resolve('@deepseek-ai/dsh-tools'))
const requireDsh = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const requireBase = createRequire(requireDsh.resolve('@deepseek-ai/dsh-base/package.json'))
const { ToolResultPruner } = await import(pathToFileURL(requireBase.resolve('@deepseek-ai/dsh-compaction-tool-result-pruner')).href)
async function mountCodeRuntime(host, workspace) {
  const fibers = []
  const load = async (name, config) => {
    const module = await import(pathToFileURL(requireBase.resolve('@deepseek-ai/dsh-' + name)).href)
    const fiber = host.plugin(module.default ?? module.NodePtcRuntime, config)
    fibers.push(fiber)
    await fiber.await()
  }
  try {
    let modern = false
    try { requireBase.resolve('@deepseek-ai/dsh-ptc-runtime-node'); modern = true } catch {}
    if (modern) {
      await load('session-projection')
      let hasWorkingDirectory = false
      try { requireBase.resolve('@deepseek-ai/dsh-working-directory'); hasWorkingDirectory = true } catch {}
      if (hasWorkingDirectory) await load('working-directory')
      await load('fs-local')
      await load('subprocess-local')
      await load('sandbox-local')
      await load('sandbox-policy', { mode: 'danger-full-access', workspaceRoot: workspace })
      await load('ptc-runtime-node', { timeoutMs: 10000, maxOutputBytes: 1048576, maxOldGenerationSizeMb: 128 })
    } else await load('code-runtime-worker-thread', { computeMs: 3000, maxWallMs: 10000, maxOutputBytes: 1048576, maxOldGenerationSizeMb: 128 })
    return { dispose: async () => { for (const fiber of fibers.reverse()) await fiber.dispose() } }
  } catch (error) { for (const fiber of fibers.reverse()) await fiber.dispose(); throw error }
}
// Two host generations, keyed on capability rather than a version string:
// 0.2.1 and earlier let ToolsService own `mode` and per-scope presentation
// (`tools.presentAs`), and one call is a single ToolExecutionInput.
// 0.2.2+ makes `mode`/`maxParallelSubCalls` unrepresentable (`z.never()`), moves
// presentation and batch settlement into a per-scope ToolExecutor selected
// through `tools.setExecutor()`, and takes a ToolBatchInput of `calls`.
const executorOwnedTools = typeof ToolRuntime.prototype.setExecutor === 'function'

async function mountToolRuntime(host) {
  const runtime = host.plugin(ToolRuntime, executorOwnedTools ? {} : { mode: 'native' })
  await runtime.await()
  if (!executorOwnedTools) return runtime
  const native = await import(pathToFileURL(requireBase.resolve('@deepseek-ai/dsh-tool-executor-native')).href)
  const executor = host.plugin(native)
  await executor.await()
  return { dispose: async () => { await executor.dispose(); await runtime.dispose() } }
}

function toolCallBlock(name, args, callId) {
  return { type: 'tool-call', id: callId, name, arguments: JSON.stringify(args ?? {}) }
}

async function runTool(host, { agent, name, args = {}, callId = name + '-test', signal = new AbortController().signal, parent }) {
  if (!executorOwnedTools) return host.tools.execute({ name, arguments: args, callId, agent, signal, ...(parent === undefined ? {} : { parent }) })
  const batch = await host.tools.execute({ calls: [toolCallBlock(name, args, callId)], agent, signal })
  const settled = batch.results.find(entry => entry.callId === callId)
  assert.ok(settled, 'the executor must settle every call in the batch')
  return settled.result
}

// Present one scope through the PTC surface. 0.2.1 and earlier flip the scope's
// presentation mode with `tools.presentAs('ptc')`; 0.2.2+ selects a per-scope PTC
// ToolExecutor and proves the switch instead of assuming it.
let deploymentRestore

async function presentPtc(host, agent, assemble) {
  const tools = agent.ctx.tools
  if (typeof tools.presentAs === 'function') return tools.presentAs('ptc')
  assert.equal(typeof tools.setExecutor, 'function', 'a host must expose either tools.presentAs or a per-scope ToolExecutor')
  const ptc = await import(pathToFileURL(requireBase.resolve('@deepseek-ai/dsh-tool-executor-ptc')).href)
  // The executor reads `ctx.tools` and `ctx.systemPrompt` in its constructor, so it
  // has to be built from a context that declared those injects. Mounting the shipped
  // plugin does exactly that (dsh-tool-executor-ptc lib/index.js:1764-1776:
  // `inject = [tools, systemPrompt, ptcRuntime]`), whereas `new PtcExecutor(scope)`
  // on a scope that declared nothing throws
  // `cannot get property "systemPrompt" without inject` on 0.2.2.
  let restore
  const selector = {
    name: 'agent-teams-test-ptc-selection',
    inject: ptc.inject,
    apply(ctx) { restore = ctx.tools.setExecutor(new ptc.PtcExecutor(ctx, {})) },
  }
  // Selecting on the Agent scope, not the deployment root: the root already holds the
  // native executor mounted above, and `setExecutor` refuses a scope that holds one.
  // A scoped record outlives its disposer, though — `selectExecutor` prefers the
  // nearest record even when it holds `executor: void 0` (dsh-tools
  // lib/index.js:617-628), so leaving it empty would starve every later call in this
  // file with TOOL_EXECUTOR_UNAVAILABLE.
  const previous = tools.selectExecutor(agent)
  // A slot this helper filled during an earlier PTC case has to be freed before it can
  // be filled again: `setExecutor` refuses a scope that already holds an executor
  // (dsh-tools lib/index.js:600).
  deploymentRestore?.()
  deploymentRestore = undefined
  const fiber = agent.ctx.plugin(selector)
  await fiber.await()
  assert.equal(typeof restore, 'function', 'selecting a PTC executor must return a restore handle')
  assert.deepEqual((await assemble(agent)).tools.map(tool => tool.name), ['run_code'])
  // `setExecutor` documents that unloading leaves the selection unavailable until it is
  // replaced (dsh-tools lib/index.js:596-598), so the deployment executor goes back in.
  return () => { restore(); deploymentRestore = tools.setExecutor(previous); void fiber.dispose() }
}

const { createScope } = await import(pathToFileURL(requireTools.resolve('@deepseek-ai/dsh-scope')).href)

function assertCaptainProtocol(system) {
  for (const rule of [/the user's goal as description/, /attempt_id/, /never approve in that planning turn/i, /Never approve your own implementation/, /depend on a failed task/, /Resume only on a later explicit user request/]) assert.match(system, rule)
}

test('stable tool presentation uses real scoped registry and prompt assembly', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-capabilities-'))
  const stateRoot = join(workspace, '.agent-teams')
  const host = new Context()
  const prompt = host.plugin(SystemPrompt, { includeHarnessIdentity: false })
  await prompt.await()
  const tools = await mountToolRuntime(host)
  const worker = await mountCodeRuntime(host, workspace)
  const agents = []
  const scopes = []
  const noop = () => {}
  const definitions = []
  let owned
  registerAgentTeamsTools({
    on: () => noop, effect: setup => setup(), logger: { warn: noop, debug: noop },
    tools: { register: definition => definitions.push(definition) },
    agents: { get: id => agents.find(agent => agent.id === id) },
    subagents: { followup: async () => {}, registerContinuableSetup: () => noop },
  }, { stateDir: '.agent-teams', memberProvider: 'spawn', memberMaxDepth: 1, maxMembers: 8, profiles: {} })
  const business = host.plugin({ inject: ['tools'], apply(ctx) {
    owned = ctx
    for (const definition of definitions) ctx.tools.register(definition)
    ctx.provide('agents', { list: () => agents })
  } })
  await business.await()
  const createAgent = (id, parentSession, events = []) => {
    events = events.map((event, seq) => ({ ...event, seq }))
    const agent = { id, status: 'idle', session: { header: { cwd: workspace, parentSession, seedLength: 0 }, events,
      inheritedEventCount: 0, get seq() { return events.length },
      snapshotEvents: () => events.slice(), eventAt: seq => events[seq],
      append(type, data) { const event = { seq: events.length, type, data }; events.push(event); return event },
    } }
    const scope = createScope(owned, agent)
    agent.ctx = scope.ctx
    agents.push(agent)
    scopes.push(scope)
    return agent
  }
  const a = createAgent('captain-a'), b = createAgent('ordinary-b')
  const pendingMembers = new Set()
  const core = usageSectionText(TEAM_TOOL_NAMES.join(', '), formatProfilesForPrompt({ demo: { taskPlanning: 'captain', members: [{ name: 'reviewer' }], protocol: 'Review prepared work independently.' } }))
  const options = { stateDir: '.agent-teams', isPendingMember: agent => pendingMembers.has(agent.id), captainPrompt: () => core }
  const plugin = { inject: ['tools', 'systemPrompt', 'agents'], apply(ctx) { installTeamCapabilities(ctx, options) } }
  let fiber = host.plugin(plugin)
  await fiber.await()
  const assemble = agent => host.systemPrompt.assemble({ agent, scope: agent })
  const names = async agent => (await assemble(agent)).tools.map(tool => tool.name)
  const execute = (agent, name, args = {}, signal = new AbortController().signal) => runTool(host, { agent, name, args, callId: name + '-test', signal })
  const captainNames = [...TEAM_TOOL_NAMES].sort()
  const header = async agent => { const assembled = await assemble(agent); return JSON.stringify({ system: renderPrompt(assembled), tools: assembled.tools }) }
  const initialHeader = await header(a)
  const team = { id: 'saved', name: 'Saved', captainSessionId: a.id, createdAt: 1, members: [], tasks: [], taskSeq: 0, phase: 'staged' }
  try {
    await t.test('first request keeps all tools and the complete fixed captain protocol', async () => {
      assert.deepEqual(await names(a), captainNames)
      assertCaptainProtocol(renderPrompt(await assemble(a)))
      assert.equal((await names(a)).length, TEAM_TOOL_NAMES.length)
      assert.equal(host.tools.get('agent_teams_open', a), undefined)
      assert.doesNotMatch(renderPrompt(await assemble(a)), /agent_teams_open/)
      t.diagnostic(JSON.stringify({ role: 'captain-idle', profiles: ['demo'], promptBytes: Buffer.byteLength(renderPrompt(await assemble(a))), schemaBytes: Buffer.byteLength(JSON.stringify((await assemble(a)).tools)) }))
    })
    await t.test('cancelled and invalid business calls preserve the header', async () => {
      const controller = new AbortController()
      controller.abort()
      assert.equal((await execute(a, 'agent_teams_status', {}, controller.signal)).isError, true)
      const invalid = await execute(a, 'agent_teams_create', { name: 'Invalid', profile: 'missing', approval: 'required' })
      assert.equal(invalid.isError, true)
      assert.match(JSON.stringify(invalid), /unknown AgentTeams profile/)
      assert.equal(await header(a), initialHeader)
    })
    await t.test('user restrictions remain authoritative while fixed profile metadata stays visible', async () => {
      const userDeny = a.ctx.tools.restrict({ deny: ['agent_teams_delete'] })
      try {
        assert.ok((await names(a)).includes('agent_teams_create'))
        assert.ok(!(await names(a)).includes('agent_teams_delete'))
        assert.deepEqual(await names(b), captainNames)
        assert.match(renderPrompt(await assemble(a)), /demo \(1 member, captain planning\): Review prepared work independently/)
        assertCaptainProtocol(renderPrompt(await assemble(a)))
        assert.equal(await header(b), initialHeader)
      } finally { userDeny() }
      assert.equal(await header(a), initialHeader)
    })
    await t.test('the original tool allowlist can directly create and archive', async () => {
      const legacy = createAgent('legacy-captain')
      host.emit('agent/session-start', { agent: legacy, source: 'startup' })
      const restore = legacy.ctx.tools.restrict({ allow: [...TEAM_TOOL_NAMES] })
      try {
        assert.deepEqual((await names(legacy)).sort(), [...TEAM_TOOL_NAMES].sort())
        assert.equal(host.tools.get('agent_teams_open', legacy), undefined)
        assertCaptainProtocol(renderPrompt(await assemble(legacy)))
        for (const name of ['agent_teams_create', 'agent_teams_delete']) {
          const result = await runTool(host, { agent: legacy, name, args: name === 'agent_teams_create' ? { name: 'Legacy', approval: 'required' } : {}, callId: name + '-legacy' })
          assert.equal(result.isError, false, JSON.stringify(result))
        }
        assertCaptainProtocol(renderPrompt(await assemble(legacy)))
      } finally { restore() }
    })
    await t.test('status reports halted work without replacing or resuming it', async () => {
      await createTeamDir(stateRoot, { ...team, phase: 'running', halted: true })
      const file = join(stateRoot, team.id, 'team.json')
      const before = await readFile(file, 'utf8')
      const first = await execute(a, 'agent_teams_status'), second = await execute(a, 'agent_teams_status')
      assert.equal(first.isError, false, JSON.stringify(first))
      assert.equal(second.isError, false, JSON.stringify(second))
      assert.equal(first.value.team_id, team.id)
      assert.equal(first.value.halted, true)
      assert.equal(await readFile(file, 'utf8'), before)
      assert.equal(await header(a), initialHeader)
    })
    await t.test('duplicate creation directs the captain to reuse the existing team without changing it', async () => {
      const file = join(stateRoot, team.id, 'team.json')
      const before = await readFile(file, 'utf8')
      const result = await execute(a, 'agent_teams_create', { name: 'Replacement', approval: 'required' })
      assert.equal(result.isError, true, JSON.stringify(result))
      assert.match(JSON.stringify(result), /Use agent_teams_status and continue the existing team/)
      assert.match(JSON.stringify(result), /Do not delete and recreate it merely to continue work/)
      assert.equal(await readFile(file, 'utf8'), before)
      assert.equal((await execute(a, 'agent_teams_status')).value.team_id, team.id)
      assert.equal(await header(a), initialHeader)
    })
    await t.test('fresh child is restricted to member tools before its id has been persisted', async () => {
      pendingMembers.add('child')
      const member = createAgent('child', a.id, [{ type: 'subagent/descriptor', data: {
        version: 3, mode: 'continuable', provider: 'spawn', label: 'agent-teams:saved:worker', agentProvider: 'fake', agentModel: 'fake',
      } }])
      host.emit('agent/session-start', { agent: member, source: 'startup' })
      pendingMembers.delete('child')
      assert.deepEqual((await names(member)).sort(), [...MEMBER_TOOL_NAMES].sort())
      assert.equal(renderPrompt(await assemble(member)), TEAM_MEMBER_PROMPT)
      assert.equal(host.tools.get('agent_teams_open', member), undefined)
      assert.equal(host.tools.get('agent_teams_approve', member), undefined)
      assert.ok(Buffer.byteLength(TEAM_MEMBER_PROMPT) < 600)
      t.diagnostic(JSON.stringify({ role: 'member', promptBytes: Buffer.byteLength(TEAM_MEMBER_PROMPT), schemaBytes: Buffer.byteLength(JSON.stringify((await assemble(member)).tools)) }))
    })
    await t.test('an ordinary subagent label cannot impersonate durable or pending membership', async () => {
      const child = createAgent('ordinary-child', a.id, [{ type: 'subagent/descriptor', data: {
        version: 3, mode: 'continuable', provider: 'spawn', label: 'agent-teams:saved:worker', agentProvider: 'fake', agentModel: 'fake',
      } }])
      host.emit('agent/session-start', { agent: child, source: 'startup' })
      assert.deepEqual(await names(child), captainNames)
    })
    await t.test('a retired member remains restricted to member operations on cold resume', async () => {
      await recordRetiredMemberIds(stateRoot, ['retired-child'])
      const child = createAgent('retired-child', a.id)
      host.emit('agent/session-start', { agent: child, source: 'resume' })
      assert.deepEqual((await names(child)).sort(), [...MEMBER_TOOL_NAMES].sort())
    })
    await t.test('supported PTC presentation modes keep the operation SDK stable after status', async () => {
      // `both` only exists where ToolsService still owns presentation; a host
      // with a per-scope ToolExecutor exposes the PTC surface alone.
      const legacyPresentation = typeof a.ctx.tools.presentAs === 'function'
      for (const mode of legacyPresentation ? ['ptc', ...(!requireDsh('@deepseek-ai/dsh/package.json').version.startsWith('0.2.1') ? ['both'] : [])] : ['ptc']) {
        const restore = legacyPresentation ? a.ctx.tools.presentAs(mode) : await presentPtc(host, a, assemble)
        const assembly = await assemble(a)
        const sdk = assembly.sections.find(section => section.name === 'tools:sdk').text
        assert.doesNotMatch(sdk, /agent_teams_open/)
        for (const name of TEAM_TOOL_NAMES) assert.ok(sdk.includes(name), name)
        const before = await header(a)
        const result = await runTool(host, { agent: a, name: 'run_code', args: { code: 'return await tools.agent_teams_status({});', description: 'Read current team state' }, callId: 'sdk-status-' + mode })
        assert.equal(result.isError, false, JSON.stringify(result))
        assert.equal(await header(a), before)
        restore()
      }
    })
    await t.test('real run_code may discard status output without losing operating rules', async () => {
      const restore = await presentPtc(host, a, assemble)
      try {
        const before = await header(a)
        const result = await runTool(host, { agent: a, name: 'run_code', args: { code: 'await tools.agent_teams_status({}); return "STATUS_OUTPUT_DISCARDED";', description: 'Inspect current team without returning the result' }, callId: 'discard-status-output' })
        assert.equal(result.isError, false, JSON.stringify(result))
        assert.match(JSON.stringify(result.content), /STATUS_OUTPUT_DISCARDED/)
        assert.doesNotMatch(JSON.stringify(result.content), /attempt_id|captain protocol/)
        assert.ok(a.session.events.some(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'agent_teams_status'))
        assertCaptainProtocol(renderPrompt(await assemble(a)))
        assert.equal(await header(a), before)
      } finally { restore() }
    })
    await t.test('HMR removes old masks and restores persisted participants in existing scopes', async () => {
      await fiber.dispose()
      assert.equal(host.tools.get('agent_teams_open', b), undefined)
      assert.equal((await names(b)).length, TEAM_TOOL_NAMES.length)
      assert.doesNotMatch(renderPrompt(await assemble(b)), /AgentTeams captain protocol/)
      fiber = host.plugin(plugin)
      await fiber.await()
      assert.equal((await names(a)).length, TEAM_TOOL_NAMES.length)
      assert.deepEqual(await names(b), captainNames)
      assertCaptainProtocol(renderPrompt(await assemble(b)))
      assert.equal(await header(b), initialHeader)
      const retired = agents.find(agent => agent.id === 'retired-child')
      assert.deepEqual((await names(retired)).sort(), [...MEMBER_TOOL_NAMES].sort())
      assert.equal(renderPrompt(await assemble(retired)), TEAM_MEMBER_PROMPT)
    })
    await t.test('a cold captain loads its durable role before its first request', async () => {
      const cold = createAgent(a.id)
      host.emit('agent/session-start', { agent: cold, source: 'resume' })
      assert.equal((await names(cold)).length, TEAM_TOOL_NAMES.length)
      assert.equal(await header(cold), initialHeader)
      // This new Agent has no historical tool calls. Persisted work is
      // still directly addressable through the original business tools.
      assert.equal(cold.session.events.length, 0)
      const result = await runTool(host, { agent: cold, name: 'agent_teams_status', callId: 'cold-direct-status' })
      assert.equal(result.isError, false, JSON.stringify(result))
      assert.match(JSON.stringify(result.content), /Saved/)
      assertCaptainProtocol(renderPrompt(await assemble(cold)))
    })
    await t.test('archive and idle preserve the original captain prefix', async () => {
      await archiveTeamDir(stateRoot, team.id)
      assert.equal((await names(a)).length, TEAM_TOOL_NAMES.length)
      host.emit('agent/status', { agent: a, status: 'idle' })
      assert.deepEqual(await names(a), captainNames)
    })
    await t.test('create, status and archive preserve the prefix in native and nested dispatch', async () => {
      for (const nested of [false, true]) {
        assert.equal(await header(a), initialHeader)
        // `parent` marks a nested dispatch where the host still models one; a
        // batch-input host expresses nesting through the owning Agent's scope,
        // so both iterations assert the same prefix contract there.
        const exec = name => runTool(host, { agent: a, name, args: name === 'agent_teams_create' ? { name: 'Saved', description: 'Preserve the requested goal', approval: 'required' } : {}, callId: name + '-test', ...(nested ? { parent: {} } : {}) })
        for (const name of ['agent_teams_create', 'agent_teams_status', 'agent_teams_delete']) {
          const result = await exec(name)
          assert.equal(result.isError, false, JSON.stringify(result))
          assert.equal(await header(a), initialHeader)
        }
        assert.equal((await exec('agent_teams_status')).isError, true, 'Archived work is no longer an active team')
        host.emit('agent/status', { agent: a, status: 'idle' })
        assert.deepEqual(await names(a), captainNames)
        assert.equal(await header(a), initialHeader)
      }
    })
    await t.test('even aggressive host result pruning cannot remove the system protocol', async () => {
      const pruner = new ToolResultPruner(new Context(), { thresholdChars: 128, headChars: 16, tailChars: 16 })
      const rendered = [{ type: 'text', text: 'x'.repeat(256) + core + 'y'.repeat(256) }]
      const pruned = pruner.pruneContent(rendered)
      assert.ok(pruned, 'the real host pruner must actually remove content')
      assert.doesNotMatch(JSON.stringify(pruned), /attempt_id|captain protocol/)
      assertCaptainProtocol(renderPrompt(await assemble(b)))
      assert.equal(await header(b), initialHeader)
    })
    await t.test('read failure leaves the fixed header intact', async () => {
      await mkdir(join(stateRoot, 'broken'))
      await writeFile(join(stateRoot, 'broken/team.json'), '{broken')
      assert.equal((await execute(b, 'agent_teams_status')).isError, true)
      assert.deepEqual(await names(b), captainNames)
    })
  } finally {
    await fiber.dispose()
    for (const scope of scopes.reverse()) await scope.dispose()
    await business.dispose(); await tools.dispose(); await worker.dispose(); await prompt.dispose()
    await rm(workspace, { recursive: true, force: true })
  }
})
