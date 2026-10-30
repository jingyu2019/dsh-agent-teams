export const DETERMINISTIC_SUITE = Object.freeze({
  schemaVersion: 1,
  suiteId: 'issue-211-deterministic-paired',
  suiteVersion: 1,
  description: 'Offline positive, negative-control and overhead-control cases for the paired evaluation harness.',
  tasks: [
    {
      pairId: 'objective-fix-pair',
      taskId: 'objective-fix',
      prompt: 'Fix a bounded failing test and preserve the existing public behavior.',
    },
    {
      pairId: 'negative-control-pair',
      taskId: 'negative-control',
      prompt: 'Deliberately unsatisfiable negative control: require an impossible proof that must fail in every mode.',
    },
    {
      pairId: 'overhead-control-pair',
      taskId: 'overhead-control',
      prompt: 'Answer a short deterministic question while cooperation overhead is measured.',
    },
  ],
})

export const deterministicConfig = Object.freeze({
  model: 'offline-fixture-model',
  provider: 'offline-fixture-provider',
  modes: ['single-agent', 'ordinary-subagent', 'agent-teams'],
  budgets: { tools: 8, wallMs: 2_000, retries: 1 },
})

const perMode = {
  'single-agent': { wallMs: 10, toolsUsed: 1, retriesUsed: 0, tokens: 20 },
  'ordinary-subagent': { wallMs: 20, toolsUsed: 2, retriesUsed: 0, tokens: 35 },
  'agent-teams': { wallMs: 30, toolsUsed: 3, retriesUsed: 0, tokens: 55 },
}

function resultFor(mode, { fail = false, tokens = perMode[mode].tokens, wallMs = perMode[mode].wallMs } = {}) {
  const data = perMode[mode]
  const captain = Math.ceil(tokens / 2)
  const members = tokens - captain
  return {
    outcome: fail ? 'fail' : 'pass',
    wallMs,
    toolsUsed: data.toolsUsed,
    retriesUsed: data.retriesUsed,
    tokens: { captain, members, total: tokens, source: 'host' },
    cost: { amount: tokens / 1_000_000, currency: 'USD', source: 'host' },
    judge: {
      rubric: fail ? 'impossible-proof-control-v1' : 'bounded-task-outcome-v1',
      verdict: fail ? 'fail' : 'pass',
    },
    ...(fail ? { error: { type: 'judge', name: 'EvaluationFailure', message: 'negative control correctly failed' } } : {}),
  }
}

export async function deterministicRunner({ taskId, mode }) {
  if (taskId === 'negative-control') return resultFor(mode, { fail: true, tokens: 5 })
  if (taskId === 'overhead-control') {
    return resultFor(mode, {
      wallMs: mode === 'agent-teams' ? 30 : mode === 'ordinary-subagent' ? 20 : 10,
      tokens: mode === 'agent-teams' ? 80 : mode === 'ordinary-subagent' ? 50 : 20,
    })
  }
  return resultFor(mode)
}
