import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  createTrialPlan,
  runEvaluation,
} from './evaluation/harness.mjs'
import {
  DETERMINISTIC_SUITE,
  deterministicConfig,
  deterministicRunner,
} from './evaluation/fixtures/deterministic.mjs'
import {
  buildSummary,
  computeTaskHash,
  validateEvaluation,
} from './evaluation/schema.mjs'

const codes = result => result.errors.map(error => error.code)

async function deterministicReport() {
  return runEvaluation({
    suite: DETERMINISTIC_SUITE,
    config: deterministicConfig,
    runner: deterministicRunner,
    now: (() => {
      let value = 1_000
      return () => value += 10
    })(),
  })
}

test('plan covers every task in all three paired modes', () => {
  const plan = createTrialPlan(DETERMINISTIC_SUITE, deterministicConfig)
  assert.equal(plan.length, DETERMINISTIC_SUITE.tasks.length * 3)
  for (const task of DETERMINISTIC_SUITE.tasks) {
    const pair = plan.filter(trial => trial.pairId === task.pairId)
    assert.deepEqual(pair.map(trial => trial.mode), ['single-agent', 'ordinary-subagent', 'agent-teams'])
    assert.ok(pair.every(trial => trial.taskId === task.taskId))
    assert.ok(pair.every(trial => trial.taskHash === computeTaskHash(task)))
  }
})

test('deterministic paired run retains negative controls and exposes AgentTeams overhead', async () => {
  const report = await deterministicReport()
  const result = validateEvaluation(report)
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2))
  assert.equal(report.trials.length, 9)
  assert.equal(report.summary.passRate, 6 / 9)
  assert.equal(report.summary.outcomeCounts.fail, 3)

  const negative = report.trials.filter(trial => trial.taskId === 'negative-control')
  assert.equal(negative.length, 3)
  assert.ok(negative.every(trial => trial.outcome === 'fail'))
  assert.ok(negative.every(trial => trial.judge.verdict === 'fail'))

  const overhead = report.summary.pairComparisons.find(pair => pair.pairId === 'overhead-control-pair')
  assert.ok(overhead)
  assert.ok(overhead.agentTeamsVsSingle.tokens > 0)
  assert.ok(overhead.agentTeamsVsSingle.wallMs > 0)
  assert.equal(overhead.agentTeamsVsSingle.passDelta, 0)
  assert.equal(report.summary.statisticalSignificance, 'not-assessed')
})

test('harness retains pass, thrown error and timeout records in the same paired run', async () => {
  const suite = {
    schemaVersion: 1,
    suiteId: 'retention-suite',
    suiteVersion: 1,
    tasks: [{ pairId: 'retention-pair', taskId: 'retention-task', prompt: 'Return a result' }],
  }
  const config = {
    model: 'fixture-model', provider: 'fixture-provider', modes: ['single-agent', 'ordinary-subagent', 'agent-teams'],
    budgets: { tools: 2, wallMs: 25, retries: 0 },
  }
  const runner = async ({ mode }) => {
    if (mode === 'single-agent') {
      return { outcome: 'pass', wallMs: 4, toolsUsed: 1, retriesUsed: 0, tokens: { captain: 4, members: 0, total: 4, source: 'host' }, cost: { amount: 0, currency: 'USD', source: 'host' }, judge: { rubric: 'fixture', verdict: 'pass' } }
    }
    if (mode === 'ordinary-subagent') throw new Error('synthetic runner failure')
    return new Promise(() => {})
  }
  const report = await runEvaluation({ suite, config, runner })
  assert.equal(report.trials.length, 3)
  assert.deepEqual(report.trials.map(trial => trial.outcome), ['pass', 'error', 'timeout'])
  assert.match(report.trials[1].error.message, /synthetic runner failure/)
  assert.match(report.trials[2].error.message, /wall-time budget/)
  assert.equal(validateEvaluation(report).ok, true)
})

test('validator rejects a removed failed trial even when the summary is recomputed', async () => {
  const report = await deterministicReport()
  report.trials = report.trials.filter(trial => !(trial.taskId === 'negative-control' && trial.mode === 'agent-teams'))
  report.summary = buildSummary(report.trials, { suite: report.suite, config: report.configuration })
  const result = validateEvaluation(report)
  assert.equal(result.ok, false)
  assert.ok(codes(result).includes('MISSING_TRIAL'))
  assert.ok(result.errors.some(error => error.path.includes('negative-control')))
})

test('validator rejects a cherry-picked summary that disagrees with raw trials', async () => {
  const report = await deterministicReport()
  report.summary.passRate = 1
  report.summary.outcomeCounts.fail = 0
  const result = validateEvaluation(report)
  assert.equal(result.ok, false)
  assert.ok(codes(result).includes('SUMMARY_MISMATCH'))
})

test('validator recomputes wall time, token and cost metrics from raw trials', async () => {
  const report = await deterministicReport()
  report.summary.wallMs.total += 1
  report.summary.tokens.total += 1
  report.summary.cost.amount += 1
  const result = validateEvaluation(report)
  assert.equal(result.ok, false)
  assert.ok(codes(result).includes('SUMMARY_MISMATCH'))
})

test('validator rejects a configuration that omits an evaluation mode', async () => {
  const report = await deterministicReport()
  report.configuration.modes = report.configuration.modes.slice(0, 2)
  const result = validateEvaluation(report)
  assert.equal(result.ok, false)
  assert.ok(codes(result).includes('INVALID_CONFIG'))
})

test('validator rejects unequal models or budgets inside one paired report', async () => {
  const report = await deterministicReport()
  report.trials[1].budgets.wallMs += 1
  const result = validateEvaluation(report)
  assert.equal(result.ok, false)
  assert.ok(codes(result).includes('BUDGET_MISMATCH'))
})

test('summary exposes host token and cost provenance', async () => {
  const report = await deterministicReport()
  assert.equal(report.summary.tokens.source, 'host')
  assert.equal(report.summary.cost.source, 'host')
  assert.equal(report.summary.tokens.total, report.summary.tokens.captain + report.summary.tokens.members)
})

test('validator rejects token totals that are not captain plus members', async () => {
  const report = await deterministicReport()
  report.trials[0].tokens.members += 1
  report.summary = buildSummary(report.trials, { suite: report.suite, config: report.configuration })
  const result = validateEvaluation(report)
  assert.equal(result.ok, false)
  assert.ok(codes(result).includes('TOKEN_TOTAL_MISMATCH'))
})

test('validator rejects a task prompt changed after its hash was recorded', async () => {
  const report = await deterministicReport()
  report.suite.tasks[0].prompt += ' injected change'
  const result = validateEvaluation(report)
  assert.equal(result.ok, false)
  assert.ok(codes(result).includes('TASK_HASH_MISMATCH'))
})

test('validator rejects a report that claims statistical significance', async () => {
  const report = await deterministicReport()
  report.summary.statisticalSignificance = 'significant'
  const result = validateEvaluation(report)
  assert.equal(result.ok, false)
  assert.ok(codes(result).includes('UNSUPPORTED_SIGNIFICANCE'))
})

test('normal harness tests are network-free and docs state the limitations', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => { throw new Error('network access attempted by evaluation test') }
  try {
    const report = await deterministicReport()
    assert.equal(validateEvaluation(report).ok, true)
  } finally {
    globalThis.fetch = originalFetch
  }
  const docs = await readFile(new URL('../docs/evaluation/README.md', import.meta.url), 'utf8')
  assert.match(docs, /not statistical evidence/i)
  assert.match(docs, /failure.*timeout.*retain/i)
  assert.match(docs, /cost source/i)
})
