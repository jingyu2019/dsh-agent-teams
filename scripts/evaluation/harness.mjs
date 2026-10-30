#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  OUTCOMES,
  SOURCES,
  buildSummary,
  canonicalJson,
  normalizeConfig,
  normalizeSuite,
} from './schema.mjs'

export const DEFAULT_LIMITATIONS = Object.freeze([
  'A small or single paired run is not statistical evidence and no significance test is performed.',
  'Results apply only to the recorded model, provider, host version, suite version, budgets, and execution order.',
  'Wall time includes the runner callback but excludes external queueing and operator setup unless the runner records it explicitly.',
  'Token and cost totals are only comparable when every trial reports source=host; unavailable sources are retained as zero rather than estimated.',
  'Model nondeterminism means re-running the same suite can change outcomes; preserve raw trial ledgers and report all reruns.',
])

const OUTCOME_SET = new Set(OUTCOMES)
const SOURCE_SET = new Set(SOURCES)

function nonNegativeInteger(value, fallback = 0) {
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

function normalizeTokens(input) {
  if (!input || !SOURCE_SET.has(input.source) || input.source === 'unavailable') {
    return { captain: 0, members: 0, total: 0, source: 'unavailable' }
  }
  const captain = nonNegativeInteger(input.captain)
  const members = nonNegativeInteger(input.members)
  return { captain, members, total: captain + members, source: 'host' }
}

function normalizeCost(input) {
  if (!input || !SOURCE_SET.has(input.source) || input.source === 'unavailable') {
    return { amount: null, currency: null, source: 'unavailable' }
  }
  if (!Number.isFinite(input.amount) || input.amount < 0 || typeof input.currency !== 'string' || input.currency.trim() === '') {
    return { amount: null, currency: null, source: 'unavailable' }
  }
  return { amount: input.amount, currency: input.currency, source: 'host' }
}

function normalizeJudge(input, outcome) {
  if (input && typeof input.rubric === 'string' && input.rubric.trim() && typeof input.verdict === 'string' && input.verdict.trim()) {
    return { rubric: input.rubric, verdict: input.verdict }
  }
  return {
    rubric: 'Harness fallback: runner did not provide a judge record',
    verdict: outcome,
  }
}

function serializeError(cause, type) {
  return {
    type,
    name: typeof cause?.name === 'string' ? cause.name : 'Error',
    message: typeof cause?.message === 'string' ? cause.message : String(cause),
  }
}

function timeoutPromise(controller, wallMs) {
  let timer
  const promise = new Promise(resolve => {
    timer = setTimeout(() => {
      controller.abort()
      resolve({ __evaluationTimeout: true })
    }, wallMs)
  })
  return { promise, clear: () => clearTimeout(timer) }
}

async function executeTrial(planned, runner, clock) {
  const started = clock()
  const controller = new AbortController()
  const timeout = timeoutPromise(controller, planned.budgets.wallMs)
  let raw
  let timeoutHit = false
  try {
    raw = await Promise.race([
      Promise.resolve().then(() => runner({ ...planned, signal: controller.signal })),
      timeout.promise,
    ])
    timeoutHit = raw?.__evaluationTimeout === true
  } catch (cause) {
    raw = { outcome: 'error', error: cause }
  } finally {
    timeout.clear()
  }

  const elapsed = Math.max(0, clock() - started)
  const base = {
    trialId: planned.trialId,
    pairId: planned.pairId,
    taskId: planned.taskId,
    taskHash: planned.taskHash,
    mode: planned.mode,
    model: planned.model,
    provider: planned.provider,
    budgets: { ...planned.budgets },
  }

  if (timeoutHit) {
    return {
      ...base,
      outcome: 'timeout',
      wallMs: elapsed,
      toolsUsed: 0,
      retriesUsed: 0,
      tokens: { captain: 0, members: 0, total: 0, source: 'unavailable' },
      cost: { amount: null, currency: null, source: 'unavailable' },
      judge: { rubric: 'Fixed wall-time budget expired before the runner returned', verdict: 'timeout' },
      error: { type: 'timeout', name: 'TimeoutError', message: `wall-time budget of ${planned.budgets.wallMs}ms expired` },
    }
  }

  if (!raw || typeof raw !== 'object') {
    return {
      ...base,
      outcome: 'error',
      wallMs: elapsed,
      toolsUsed: 0,
      retriesUsed: 0,
      tokens: { captain: 0, members: 0, total: 0, source: 'unavailable' },
      cost: { amount: null, currency: null, source: 'unavailable' },
      judge: { rubric: 'Runner must return an object', verdict: 'error' },
      error: { type: 'runner', name: 'TypeError', message: 'runner returned no result object' },
    }
  }

  let outcome = OUTCOME_SET.has(raw.outcome) ? raw.outcome : 'error'
  let budgetError = null
  const toolsUsed = nonNegativeInteger(raw.toolsUsed)
  const retriesUsed = nonNegativeInteger(raw.retriesUsed)
  if (toolsUsed > planned.budgets.tools) {
    outcome = 'error'
    budgetError = `tool budget exceeded: ${toolsUsed} > ${planned.budgets.tools}`
  } else if (retriesUsed > planned.budgets.retries) {
    outcome = 'error'
    budgetError = `retry budget exceeded: ${retriesUsed} > ${planned.budgets.retries}`
  }

  // Use the larger of host-reported and harness-observed time so a runner cannot under-report latency.
  const reportedWallMs = Number.isFinite(raw.wallMs) && raw.wallMs >= 0 ? Math.max(raw.wallMs, elapsed) : elapsed
  if (outcome !== 'timeout' && reportedWallMs > planned.budgets.wallMs) {
    outcome = 'timeout'
    budgetError = `wall-time budget exceeded: ${reportedWallMs} > ${planned.budgets.wallMs}ms`
  }

  let error = raw.error
  if (error instanceof Error) error = serializeError(error, 'runner')
  else if (typeof error === 'string') error = { type: 'runner', name: 'Error', message: error }
  if (!error && budgetError) error = { type: 'budget', name: 'BudgetError', message: budgetError }
  if (!error && raw.outcome !== undefined && !OUTCOME_SET.has(raw.outcome)) {
    error = { type: 'runner', name: 'TypeError', message: `unknown outcome ${String(raw.outcome)}` }
  }
  if (!error && outcome === 'error') {
    error = { type: 'runner', name: 'Error', message: 'runner recorded an error without details' }
  }

  return {
    ...base,
    outcome,
    wallMs: reportedWallMs,
    toolsUsed,
    retriesUsed,
    tokens: normalizeTokens(raw.tokens),
    cost: normalizeCost(raw.cost),
    judge: normalizeJudge(raw.judge, outcome),
    ...(error ? { error } : {}),
  }
}

export function createTrialPlan(suiteInput, configInput) {
  const suite = normalizeSuite(suiteInput)
  const config = normalizeConfig(configInput)
  return suite.tasks.flatMap(task => config.modes.map(mode => ({
    trialId: `${task.pairId}:${mode}`,
    pairId: task.pairId,
    taskId: task.taskId,
    taskHash: task.taskHash,
    mode,
    model: config.model,
    provider: config.provider,
    budgets: { ...config.budgets },
    task: { ...task },
    configuration: { ...config, modes: [...config.modes], budgets: { ...config.budgets } },
  })))
}

export async function runEvaluation({ suite: suiteInput, config: configInput, runner, now = Date.now, limitations = [...DEFAULT_LIMITATIONS] }) {
  if (typeof runner !== 'function') throw new TypeError('runEvaluation requires a runner function')
  const suite = normalizeSuite(suiteInput)
  const config = normalizeConfig(configInput)
  const plan = createTrialPlan(suite, config)
  const clock = typeof now === 'function' ? now : Date.now
  const startedAtMs = clock()
  const trials = []
  for (const planned of plan) {
    trials.push(await executeTrial(planned, runner, clock))
  }
  const completedAtMs = clock()
  const summary = buildSummary(trials, { suite, config })
  return {
    schemaVersion: 1,
    run: {
      suiteId: suite.suiteId,
      suiteVersion: suite.suiteVersion,
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date(completedAtMs).toISOString(),
      modeOrder: [...config.modes],
    },
    suite,
    configuration: config,
    trials,
    summary,
    limitations: limitations.map(String),
  }
}

export async function loadSuiteFile(path) {
  const text = await readFile(path, 'utf8')
  if (path.endsWith('.jsonl')) {
    const records = text.split(/\r?\n/).filter(line => line.trim() !== '').map((line, index) => {
      try { return JSON.parse(line) } catch (cause) { throw new Error(`invalid JSONL at ${path}:${index + 1}: ${cause.message}`) }
    })
    const header = records.find(record => record.type === 'suite') ?? records[0]
    if (!header) throw new Error('suite JSONL is empty')
    return {
      schemaVersion: header.schemaVersion,
      suiteId: header.suiteId,
      suiteVersion: header.suiteVersion,
      ...(header.description ? { description: header.description } : {}),
      tasks: records.filter(record => record.type !== 'suite').map(record => {
        const { type: _type, ...task } = record
        return task
      }),
    }
  }
  return JSON.parse(text)
}

export function trialsJsonl(report) {
  return report.trials.map(trial => canonicalJson(trial)).join('\n') + (report.trials.length ? '\n' : '')
}

async function loadRunner(path) {
  const module = await import(pathToFileURL(resolve(path)).href + `?mtime=${Date.now()}`)
  const runner = module.runTrial ?? module.default
  if (typeof runner !== 'function') throw new Error('runner module must export runTrial or a default function')
  return runner
}

function parseArgs(argv) {
  const allowed = new Set(['--suite', '--config', '--runner', '--out', '--plan'])
  const args = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--plan') { args.set(flag, true); continue }
    if (!allowed.has(flag)) throw new Error(`unknown argument ${flag}`)
    if (args.has(flag)) throw new Error(`duplicate argument ${flag}`)
    const value = argv[++i]
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
    args.set(flag, value)
  }
  if (!args.has('--suite')) throw new Error('--suite is required')
  if (!args.has('--config')) throw new Error('--config is required')
  if (!args.get('--plan') && !args.has('--runner')) throw new Error('--runner is required unless --plan is used')
  if (!args.get('--plan') && !args.has('--out')) throw new Error('--out is required for an execution run')
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const suite = await loadSuiteFile(resolve(args.get('--suite')))
  const config = JSON.parse(await readFile(resolve(args.get('--config')), 'utf8'))
  if (args.get('--plan')) {
    const plan = createTrialPlan(suite, config).map(({ task: _task, configuration: _configuration, ...trial }) => trial)
    process.stdout.write(JSON.stringify({ schemaVersion: 1, suiteId: suite.suiteId, trials: plan }, null, 2) + '\n')
    return
  }
  const runner = await loadRunner(args.get('--runner'))
  const report = await runEvaluation({ suite, config, runner })
  const out = resolve(args.get('--out'))
  await writeFile(out, JSON.stringify(report, null, 2) + '\n')
  await writeFile(out.replace(/\.json$/i, '') + '.trials.jsonl', trialsJsonl(report))
  process.stdout.write(JSON.stringify({
    report: out,
    trials: report.trials.length,
    passRate: report.summary.passRate,
    outcomes: report.summary.outcomeCounts,
    complete: report.summary.complete,
  }, null, 2) + '\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(cause => {
    console.error(cause?.stack ?? cause)
    process.exitCode = 1
  })
}
