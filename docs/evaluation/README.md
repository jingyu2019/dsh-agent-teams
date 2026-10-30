# Paired AgentTeams evaluation harness (#211)

This directory contains an offline-testable harness for comparing the same task set under three execution modes:

- `single-agent`
- `ordinary-subagent`
- `agent-teams`

The implementation lives in `scripts/evaluation/`. It is intentionally separate from the plugin runtime and does **not** modify `src/`, `package.json`, provider credentials, or the normal product test suite.

## What is measured

Every report records:

- paired `pairId`, `taskId`, and independently recomputable SHA-256 `taskHash`;
- the fixed model, provider, mode order, and tool/wall-time/retry budgets;
- every trial, including `pass`, `fail`, `timeout`, and `error`;
- wall time, tools used, retries used, and judge rubric/verdict;
- captain, member, and total tokens;
- token source and cost source (`host` or `unavailable`);
- pass rate, outcome counts, wall-time statistics, token/cost totals, and per-pair AgentTeams deltas.

Failure and timeout records are retained verbatim; the harness never drops unsuccessful runs while constructing a summary.

## Suite format

A suite is versioned JSON or JSONL. A JSON suite has this shape:

```json
{
  "schemaVersion": 1,
  "suiteId": "issue-211-example",
  "suiteVersion": 1,
  "tasks": [
    {
      "pairId": "review-pair",
      "taskId": "review-objective",
      "prompt": "Review the supplied objective and return a bounded verdict."
    }
  ]
}
```

The harness derives `taskHash` from the canonical task payload. If a suite supplies a hash, it must match; the validator recomputes every hash and rejects prompt injection or drift.

JSONL accepts one suite-record line followed by task lines:

```jsonl
{"type":"suite","schemaVersion":1,"suiteId":"issue-211-example","suiteVersion":1}
{"type":"task","pairId":"review-pair","taskId":"review-objective","prompt":"Review the supplied objective."}
```

## Fixed configuration

```json
{
  "model": "deepseek-chat",
  "provider": "deepseek",
  "modes": ["single-agent", "ordinary-subagent", "agent-teams"],
  "budgets": { "tools": 12, "wallMs": 300000, "retries": 1 }
}
```

All three modes must be present exactly once. The same model, provider, tool budget, wall budget, and retry budget are copied into every raw trial. The validator rejects unequal configuration even if the summary appears correct.

## Runner contract

The harness is provider-neutral. A runner is an async function, or a module exporting `runTrial` / a default function:

```js
export async function runTrial({ task, mode, model, provider, budgets, signal }) {
  // Invoke the selected host/provider with the supplied fixed configuration.
  return {
    outcome: 'pass',                  // pass | fail | timeout | error
    wallMs: 1200,
    toolsUsed: 3,
    retriesUsed: 0,
    tokens: { captain: 700, members: 900, total: 1600, source: 'host' },
    cost: { amount: 0.003, currency: 'USD', source: 'host' },
    judge: { rubric: 'acceptance-v1', verdict: 'pass' }
  }
}
```

The harness enforces tool, retry, and wall-time ceilings. A timeout is recorded with the fixed budget and whatever `host` telemetry is available; unavailable token/cost telemetry must be represented as zero/`null` with source `unavailable`, never guessed from text length.

## Commands

Print the exact paired task × mode matrix without running a model:

```bash
node scripts/evaluation/harness.mjs --suite suite.json --config config.json --plan
```

Run all trials and write `report.json` plus the append-only raw ledger `report.trials.jsonl`:

```bash
node scripts/evaluation/harness.mjs \
  --suite suite.json \
  --config config.json \
  --runner ./runner.mjs \
  --out report.json
```

Validate and recompute metrics from raw trials:

```bash
node scripts/evaluation/validate.mjs report.json
node scripts/evaluation/validate.mjs --self-test
```

The self-test and normal `node --test scripts/issue-211.test.mjs` path are offline. Real-provider runs are opt-in through an explicit runner and are not executed by product verification.

## Validator guarantees

The validator recomputes the entire summary from raw trials. It rejects:

- missing or duplicate pair/mode trials, including a removed failed trial;
- cherry-picked summaries whose pass counts, outcome counts, timing, tokens, or cost disagree with raw records;
- unequal models, providers, tool budgets, wall budgets, or retry budgets;
- over-budget tool/retry use and non-timeout wall overruns;
- incorrect task/pair identity or changed task hashes;
- token totals that do not equal captain plus member tokens;
- missing judge records, invalid source provenance, or unsupported significance claims.

An omission can only be detected against the report's versioned suite and configuration. If an operator deliberately substitutes a passing trial for a failed one before creating the report, the validator cannot reconstruct history without an external append-only host ledger. Preserve the emitted `*.trials.jsonl` and provider logs for audit.

## Negative and overhead controls

The offline fixture `scripts/evaluation/fixtures/deterministic.mjs` includes:

- an ordinary positive task;
- an impossible negative-control task that must fail in every mode;
- an overhead-control task where AgentTeams passes but consumes more wall time, tools, and tokens than single-agent or ordinary subagent.

The overhead result is descriptive, not a promotion criterion. A single run is **not statistical evidence**, and the summary always records `statisticalSignificance: "not-assessed"`.

## Limitations

- Small N cannot establish significance, confidence intervals, or provider-wide behavior.
- Results are bound to the recorded model, provider, host version, suite hash, budgets, and execution order.
- A generic runner cannot prove that the host used the requested model or tool policy; capture host-side traces when that matters.
- Wall time is the larger of host-reported timing and harness-observed callback time; queue delay and setup are excluded unless the runner includes them.
- The in-process wall budget stops waiting and records a timeout, but JavaScript cannot forcibly terminate a runner that ignores the abort signal; isolate such runners in a child process.
- Token and cost values depend on host telemetry. `source: unavailable` means the report does not claim an estimate.
- The validator checks report integrity, not semantic truth of a judge. Use task-specific rubrics and retain judge evidence.
- AgentTeams may be slower or more expensive on simple tasks; the included overhead case makes that trade-off visible rather than hiding it.

## Scope boundary

This work is W6.1 / issue #211 only. Integrating the command into `package.json`, adding a provider-specific production runner, and collecting real model evidence require separate authorization and review.
