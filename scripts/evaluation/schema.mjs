#!/usr/bin/env node
import { createHash } from 'node:crypto'

export const EVAL_SCHEMA_VERSION = 1
export const MODES = Object.freeze(['single-agent', 'ordinary-subagent', 'agent-teams'])
export const OUTCOMES = Object.freeze(['pass', 'fail', 'timeout', 'error'])
export const SOURCES = Object.freeze(['host', 'unavailable'])

const OUTCOME_SET = new Set(OUTCOMES)
const MODE_SET = new Set(MODES)
const SOURCE_SET = new Set(SOURCES)

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!isObject(value)) return value
  const output = {}
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) output[key] = stableValue(value[key])
  }
  return output
}

export function canonicalJson(value) {
  return JSON.stringify(stableValue(value))
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function computeTaskHash(task) {
  if (!isObject(task)) throw new TypeError('task must be an object')
  const { taskHash: _taskHash, ...payload } = task
  return sha256(canonicalJson(payload))
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be a non-empty string`)
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`)
}

export function normalizeSuite(input) {
  if (!isObject(input)) throw new TypeError('suite must be an object')
  if (input.schemaVersion !== EVAL_SCHEMA_VERSION) throw new TypeError(`suite.schemaVersion must equal ${EVAL_SCHEMA_VERSION}`)
  assertNonEmptyString(input.suiteId, 'suite.suiteId')
  assertNonNegativeInteger(input.suiteVersion, 'suite.suiteVersion')
  if (input.suiteVersion < 1) throw new TypeError('suite.suiteVersion must be at least 1')
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) throw new TypeError('suite.tasks must be a non-empty array')

  const pairIds = new Set()
  const taskIds = new Set()
  const tasks = input.tasks.map((rawTask, index) => {
    if (!isObject(rawTask)) throw new TypeError(`suite.tasks[${index}] must be an object`)
    assertNonEmptyString(rawTask.pairId, `suite.tasks[${index}].pairId`)
    assertNonEmptyString(rawTask.taskId, `suite.tasks[${index}].taskId`)
    assertNonEmptyString(rawTask.prompt, `suite.tasks[${index}].prompt`)
    if (pairIds.has(rawTask.pairId)) throw new TypeError(`duplicate suite pairId ${rawTask.pairId}`)
    if (taskIds.has(rawTask.taskId)) throw new TypeError(`duplicate suite taskId ${rawTask.taskId}`)
    pairIds.add(rawTask.pairId)
    taskIds.add(rawTask.taskId)
    const task = clone(rawTask)
    const expectedHash = computeTaskHash(task)
    if (task.taskHash !== undefined && task.taskHash !== expectedHash) {
      throw new TypeError(`task hash mismatch for ${task.taskId}`)
    }
    task.taskHash = expectedHash
    return task
  })

  return { ...clone(input), schemaVersion: EVAL_SCHEMA_VERSION, tasks }
}

export function normalizeConfig(input) {
  if (!isObject(input)) throw new TypeError('configuration must be an object')
  assertNonEmptyString(input.model, 'configuration.model')
  assertNonEmptyString(input.provider, 'configuration.provider')
  if (!Array.isArray(input.modes) || input.modes.length !== MODES.length) {
    throw new TypeError(`configuration.modes must contain exactly ${MODES.join(', ')}`)
  }
  const modes = [...input.modes]
  if (new Set(modes).size !== modes.length || modes.some(mode => !MODE_SET.has(mode))) {
    throw new TypeError(`configuration.modes must contain each of ${MODES.join(', ')} exactly once`)
  }
  if (!isObject(input.budgets)) throw new TypeError('configuration.budgets must be an object')
  assertNonNegativeInteger(input.budgets.tools, 'configuration.budgets.tools')
  assertNonNegativeInteger(input.budgets.retries, 'configuration.budgets.retries')
  if (!Number.isFinite(input.budgets.wallMs) || input.budgets.wallMs <= 0) {
    throw new TypeError('configuration.budgets.wallMs must be a positive number')
  }
  return {
    model: input.model,
    provider: input.provider,
    modes,
    budgets: {
      tools: input.budgets.tools,
      wallMs: input.budgets.wallMs,
      retries: input.budgets.retries,
    },
  }
}

function emptyOutcomeCounts() {
  return { pass: 0, fail: 0, timeout: 0, error: 0 }
}

function addOutcome(counts, outcome) {
  if (outcome in counts) counts[outcome] += 1
}

function wallStats(trials) {
  const values = trials.map(trial => trial.wallMs).sort((a, b) => a - b)
  const total = values.reduce((sum, value) => sum + value, 0)
  const median = values.length === 0
    ? 0
    : values.length % 2 === 1
      ? values[(values.length - 1) / 2]
      : (values[values.length / 2 - 1] + values[values.length / 2]) / 2
  return {
    total,
    mean: values.length === 0 ? 0 : total / values.length,
    median,
    max: values.length === 0 ? 0 : values.at(-1),
  }
}

function tokenStats(trials) {
  const captain = trials.reduce((sum, trial) => sum + trial.tokens.captain, 0)
  const members = trials.reduce((sum, trial) => sum + trial.tokens.members, 0)
  return {
    captain,
    members,
    total: captain + members,
    source: trials.length > 0 && trials.every(trial => trial.tokens.source === 'host') ? 'host' : 'unavailable',
  }
}

function costStats(trials) {
  const complete = trials.filter(trial => trial.cost.source === 'host' && Number.isFinite(trial.cost.amount) && typeof trial.cost.currency === 'string')
  if (trials.length === 0 || complete.length !== trials.length) {
    return { amount: null, currency: null, source: 'unavailable' }
  }
  const currency = complete[0].cost.currency
  if (complete.some(trial => trial.cost.currency !== currency)) {
    return { amount: null, currency: null, source: 'unavailable' }
  }
  return {
    amount: complete.reduce((sum, trial) => sum + trial.cost.amount, 0),
    currency,
    source: 'host',
  }
}

function passStats(trials) {
  const outcomes = emptyOutcomeCounts()
  for (const trial of trials) addOutcome(outcomes, trial.outcome)
  return {
    trials: trials.length,
    outcomeCounts: outcomes,
    passRate: trials.length === 0 ? 0 : outcomes.pass / trials.length,
  }
}

function compactTrial(trial) {
  if (!trial) return null
  return {
    outcome: trial.outcome,
    pass: trial.outcome === 'pass',
    wallMs: trial.wallMs,
    toolsUsed: trial.toolsUsed,
    retriesUsed: trial.retriesUsed,
    tokens: { ...trial.tokens },
    cost: { ...trial.cost },
  }
}

function difference(candidate, baseline, field) {
  if (!candidate || !baseline || candidate[field] === null || baseline[field] === null) return null
  return candidate[field] - baseline[field]
}

function tokenDifference(candidate, baseline) {
  if (!candidate || !baseline) return null
  return candidate.tokens.total - baseline.tokens.total
}

function pairComparisons(trials, suite) {
  return suite.tasks.map(task => {
    const pairTrials = trials.filter(trial => trial.pairId === task.pairId)
    const byMode = Object.fromEntries(MODES.map(mode => [mode, compactTrial(pairTrials.find(trial => trial.mode === mode))]))
    const agent = byMode['agent-teams']
    const single = byMode['single-agent']
    const ordinary = byMode['ordinary-subagent']
    return {
      pairId: task.pairId,
      taskId: task.taskId,
      modes: byMode,
      agentTeamsVsSingle: {
        passDelta: agent && single ? Number(agent.pass) - Number(single.pass) : null,
        wallMs: difference(agent, single, 'wallMs'),
        tools: difference(agent, single, 'toolsUsed'),
        tokens: tokenDifference(agent, single),
      },
      agentTeamsVsOrdinary: {
        passDelta: agent && ordinary ? Number(agent.pass) - Number(ordinary.pass) : null,
        wallMs: difference(agent, ordinary, 'wallMs'),
        tools: difference(agent, ordinary, 'toolsUsed'),
        tokens: tokenDifference(agent, ordinary),
      },
    }
  })
}

export function buildSummary(trials, { suite, config }) {
  const outcomes = emptyOutcomeCounts()
  for (const trial of trials) addOutcome(outcomes, trial.outcome)
  const byMode = Object.fromEntries(MODES.map(mode => {
    const modeTrials = trials.filter(trial => trial.mode === mode)
    return [mode, {
      ...passStats(modeTrials),
      wallMs: wallStats(modeTrials),
      tokens: tokenStats(modeTrials),
      cost: costStats(modeTrials),
    }]
  }))
  const total = trials.length
  return {
    expectedTrials: suite.tasks.length * config.modes.length,
    observedTrials: total,
    complete: total === suite.tasks.length * config.modes.length,
    outcomeCounts: outcomes,
    passRate: total === 0 ? 0 : outcomes.pass / total,
    wallMs: wallStats(trials),
    tokens: tokenStats(trials),
    cost: costStats(trials),
    byMode,
    pairComparisons: pairComparisons(trials, suite),
    statisticalSignificance: 'not-assessed',
  }
}

function error(errors, code, path, message) {
  errors.push({ code, path, message })
}

function sameValue(a, b) {
  return canonicalJson(a) === canonicalJson(b)
}

function validateTrial(trial, index, taskByPair, config, errors) {
  const base = `trials[${index}]`
  if (!isObject(trial)) {
    error(errors, 'INVALID_TRIAL', base, 'trial must be an object')
    return
  }
  for (const field of ['trialId', 'pairId', 'taskId', 'taskHash', 'model', 'provider']) {
    if (typeof trial[field] !== 'string' || trial[field].trim() === '') {
      error(errors, 'INVALID_TRIAL', `${base}.${field}`, `${field} must be a non-empty string`)
    }
  }
  if (!MODE_SET.has(trial.mode)) error(errors, 'INVALID_MODE', `${base}.mode`, 'unknown evaluation mode')
  if (!OUTCOME_SET.has(trial.outcome)) error(errors, 'INVALID_OUTCOME', `${base}.outcome`, 'unknown outcome')
  if (!Number.isFinite(trial.wallMs) || trial.wallMs < 0) error(errors, 'INVALID_TRIAL', `${base}.wallMs`, 'wallMs must be non-negative')
  for (const field of ['toolsUsed', 'retriesUsed']) {
    if (!Number.isInteger(trial[field]) || trial[field] < 0) error(errors, 'INVALID_TRIAL', `${base}.${field}`, `${field} must be a non-negative integer`)
  }

  const task = taskByPair.get(trial.pairId)
  if (!task) {
    error(errors, 'UNKNOWN_PAIR', `${base}.pairId`, `pairId ${trial.pairId} is not in the suite`)
  } else {
    if (trial.taskId !== task.taskId) error(errors, 'TASK_ID_MISMATCH', `${base}.taskId`, 'trial taskId does not match its suite pair')
    if (trial.taskHash !== task.taskHash) error(errors, 'TASK_HASH_MISMATCH', `${base}.taskHash`, 'trial taskHash does not match its suite task')
  }

  if (trial.model !== config.model || trial.provider !== config.provider) {
    error(errors, 'MODEL_MISMATCH', base, 'model/provider must be fixed across all trials')
  }
  if (!sameValue(trial.budgets, config.budgets)) {
    error(errors, 'BUDGET_MISMATCH', `${base}.budgets`, 'tool/wall/retry budgets must equal the run configuration')
  }
  if (Number.isInteger(trial.toolsUsed) && trial.budgets && trial.toolsUsed > trial.budgets.tools) {
    error(errors, 'BUDGET_EXCEEDED', `${base}.toolsUsed`, 'tool use exceeds the fixed tool budget')
  }
  if (Number.isInteger(trial.retriesUsed) && trial.budgets && trial.retriesUsed > trial.budgets.retries) {
    error(errors, 'BUDGET_EXCEEDED', `${base}.retriesUsed`, 'retries exceed the fixed retry budget')
  }
  if (trial.outcome !== 'timeout' && Number.isFinite(trial.wallMs) && trial.budgets && trial.wallMs > trial.budgets.wallMs) {
    error(errors, 'BUDGET_EXCEEDED', `${base}.wallMs`, 'non-timeout wall time exceeds the fixed wall budget')
  }

  if (!isObject(trial.tokens)) {
    error(errors, 'INVALID_TOKENS', `${base}.tokens`, 'tokens must be an object')
  } else {
    for (const field of ['captain', 'members', 'total']) {
      if (!Number.isInteger(trial.tokens[field]) || trial.tokens[field] < 0) {
        error(errors, 'INVALID_TOKENS', `${base}.tokens.${field}`, `${field} must be a non-negative integer`)
      }
    }
    if (!SOURCE_SET.has(trial.tokens.source)) error(errors, 'INVALID_TOKENS', `${base}.tokens.source`, 'token source must be host or unavailable')
    if (trial.tokens.captain + trial.tokens.members !== trial.tokens.total) {
      error(errors, 'TOKEN_TOTAL_MISMATCH', `${base}.tokens.total`, 'total tokens must equal captain + members')
    }
    if (trial.tokens.source === 'unavailable' && (trial.tokens.captain !== 0 || trial.tokens.members !== 0 || trial.tokens.total !== 0)) {
      error(errors, 'INVALID_TOKENS', `${base}.tokens`, 'unavailable tokens must be recorded as zero, not guessed')
    }
  }

  if (!isObject(trial.cost) || !SOURCE_SET.has(trial.cost.source)) {
    error(errors, 'INVALID_COST', `${base}.cost`, 'cost source must be host or unavailable')
  } else if (trial.cost.source === 'host') {
    if (!Number.isFinite(trial.cost.amount) || trial.cost.amount < 0 || typeof trial.cost.currency !== 'string' || trial.cost.currency.trim() === '') {
      error(errors, 'INVALID_COST', `${base}.cost`, 'host cost requires a non-negative amount and currency')
    }
  } else if (trial.cost.amount !== null || trial.cost.currency !== null) {
    error(errors, 'INVALID_COST', `${base}.cost`, 'unavailable cost must use null amount and currency')
  }

  if (!isObject(trial.judge) || typeof trial.judge.rubric !== 'string' || trial.judge.rubric.trim() === '' || typeof trial.judge.verdict !== 'string' || trial.judge.verdict.trim() === '') {
    error(errors, 'INVALID_JUDGE', `${base}.judge`, 'judge rubric and verdict are required')
  }
  if (trial.outcome !== 'pass' && trial.outcome !== 'fail' && trial.outcome !== 'timeout' && trial.outcome !== 'error') {
    error(errors, 'INVALID_OUTCOME', `${base}.outcome`, 'unrecognized outcome')
  }
}

export function validateEvaluation(report, { suite: externalSuite } = {}) {
  const errors = []
  if (!isObject(report)) {
    return { ok: false, errors: [{ code: 'INVALID_REPORT', path: '$', message: 'report must be an object' }], recomputed: null }
  }
  if (report.schemaVersion !== EVAL_SCHEMA_VERSION) error(errors, 'INVALID_SCHEMA_VERSION', 'schemaVersion', `expected ${EVAL_SCHEMA_VERSION}`)

  let suite
  try {
    suite = normalizeSuite(externalSuite ?? report.suite)
  } catch (cause) {
    const message = String(cause?.message ?? cause)
    const code = /task hash mismatch/i.test(message) ? 'TASK_HASH_MISMATCH' : 'INVALID_SUITE'
    error(errors, code, 'suite', message)
  }
  let config
  try {
    config = normalizeConfig(report.configuration)
  } catch (cause) {
    error(errors, 'INVALID_CONFIG', 'configuration', String(cause?.message ?? cause))
  }

  if (!Array.isArray(report.trials)) {
    error(errors, 'INVALID_TRIALS', 'trials', 'trials must be an array')
    return { ok: false, errors, recomputed: null }
  }
  if (!Array.isArray(report.limitations) || report.limitations.length < 4 || report.limitations.some(item => typeof item !== 'string' || item.trim() === '')) {
    error(errors, 'MISSING_LIMITATIONS', 'limitations', 'at least four non-empty limitation statements are required')
  }
  if (report.summary?.statisticalSignificance !== 'not-assessed') {
    error(errors, 'UNSUPPORTED_SIGNIFICANCE', 'summary.statisticalSignificance', 'small paired runs must not claim statistical significance')
  }

  if (suite && config) {
    const tasks = new Map(suite.tasks.map(task => [task.pairId, task]))
    const expected = new Set(suite.tasks.flatMap(task => config.modes.map(mode => `${task.pairId}\u0000${mode}`)))
    const seenCombo = new Set()
    const seenTrialIds = new Set()
    report.trials.forEach((trial, index) => {
      validateTrial(trial, index, tasks, config, errors)
      if (!isObject(trial)) return
      if (typeof trial.trialId === 'string') {
        if (seenTrialIds.has(trial.trialId)) error(errors, 'DUPLICATE_TRIAL_ID', `trials[${index}].trialId`, 'trialId must be unique')
        seenTrialIds.add(trial.trialId)
      }
      const combo = `${trial.pairId}\u0000${trial.mode}`
      if (!expected.has(combo)) error(errors, 'UNEXPECTED_TRIAL', `trials[${index}]`, 'trial is not in the paired task x mode matrix')
      if (seenCombo.has(combo)) error(errors, 'DUPLICATE_TRIAL', `trials[${index}]`, 'each pairId and mode may appear only once')
      seenCombo.add(combo)
    })
    for (const task of suite.tasks) {
      for (const mode of config.modes) {
        const combo = `${task.pairId}\u0000${mode}`
        if (!seenCombo.has(combo)) {
          error(errors, 'MISSING_TRIAL', `trials.${task.pairId}.${mode}`, `missing paired trial for task ${task.taskId} in mode ${mode}`)
        }
      }
    }
    try {
      const recomputed = buildSummary(report.trials, { suite, config })
      if (!sameValue(report.summary, recomputed)) {
        error(errors, 'SUMMARY_MISMATCH', 'summary', 'summary does not match metrics recomputed from raw trials')
      }
      return { ok: errors.length === 0, errors, recomputed }
    } catch (cause) {
      error(errors, 'INVALID_REPORT', '$', String(cause?.message ?? cause))
      return { ok: false, errors, recomputed: null }
    }
  }
  return { ok: false, errors, recomputed: null }
}

export function assertValidEvaluation(report, options) {
  const result = validateEvaluation(report, options)
  if (!result.ok) {
    const cause = new Error(`evaluation report is invalid: ${result.errors.map(item => `${item.code}@${item.path}`).join(', ')}`)
    cause.errors = result.errors
    throw cause
  }
  return result
}
