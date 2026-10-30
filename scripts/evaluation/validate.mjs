#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { runEvaluation } from './harness.mjs'
import { buildSummary, validateEvaluation } from './schema.mjs'
import { DETERMINISTIC_SUITE, deterministicConfig, deterministicRunner } from './fixtures/deterministic.mjs'

function reportResult(result) {
  return {
    ok: result.ok,
    errors: result.errors,
    recomputed: result.recomputed ? {
      expectedTrials: result.recomputed.expectedTrials,
      observedTrials: result.recomputed.observedTrials,
      passRate: result.recomputed.passRate,
      outcomeCounts: result.recomputed.outcomeCounts,
      tokens: result.recomputed.tokens,
      cost: result.recomputed.cost,
    } : null,
  }
}

export async function selfTest() {
  const report = await runEvaluation({
    suite: DETERMINISTIC_SUITE,
    config: deterministicConfig,
    runner: deterministicRunner,
  })
  const valid = validateEvaluation(report)
  if (!valid.ok) throw new Error(`self-test fixture must validate: ${JSON.stringify(valid.errors)}`)

  const cherryPicked = structuredClone(report)
  cherryPicked.trials = cherryPicked.trials.filter(trial => !(trial.taskId === 'negative-control' && trial.mode === 'agent-teams'))
  cherryPicked.summary = buildSummary(cherryPicked.trials, { suite: cherryPicked.suite, config: cherryPicked.configuration })
  const omitted = validateEvaluation(cherryPicked)
  if (omitted.ok || !omitted.errors.some(item => item.code === 'MISSING_TRIAL')) {
    throw new Error('self-test failed: omitted failed trial was not rejected as MISSING_TRIAL')
  }

  const unequal = structuredClone(report)
  unequal.trials[1].budgets.wallMs += 1
  const inconsistent = validateEvaluation(unequal)
  if (inconsistent.ok || !inconsistent.errors.some(item => item.code === 'BUDGET_MISMATCH')) {
    throw new Error('self-test failed: unequal budgets were not rejected')
  }

  return {
    ok: true,
    validReport: reportResult(valid),
    rejectedCherryPick: reportResult(omitted),
    rejectedUnequalBudget: reportResult(inconsistent),
    cases: {
      pairedTrials: report.trials.length,
      retainedFailures: report.summary.outcomeCounts.fail,
      retainedTimeouts: report.summary.outcomeCounts.timeout,
      overheadPair: report.summary.pairComparisons.find(pair => pair.taskId === 'overhead-control'),
    },
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--self-test') {
    const result = await selfTest()
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    return
  }
  if (args.length !== 1 || args[0].startsWith('--')) {
    throw new Error('usage: node scripts/evaluation/validate.mjs <report.json> | --self-test')
  }
  const report = JSON.parse(await readFile(resolve(args[0]), 'utf8'))
  const result = validateEvaluation(report)
  process.stdout.write(JSON.stringify(reportResult(result), null, 2) + '\n')
  if (!result.ok) process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(cause => {
    console.error(cause?.stack ?? cause)
    process.exitCode = 1
  })
}
