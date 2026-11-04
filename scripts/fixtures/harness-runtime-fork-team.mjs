/** Real DSH fork provider scenario: a forked session owns a second team. */
import assert from 'node:assert/strict'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'runtime-lab-fork-owned-team'
export const inject = ['agents', 'subagents']

function record(event) {
  appendFileSync(process.env.LAB_TRACE, JSON.stringify({ ...event, time: Date.now() }) + '\n')
}

function team(id) {
  return JSON.parse(readFileSync(join(process.cwd(), '.agent-teams', id, 'team.json'), 'utf8'))
}

export function apply(ctx) {
  void (async () => {
    await ctx.get('loader').await()
    const parentHandle = await ctx.agents.create({
      sessionId: `fork-owner-parent-${randomUUID()}`,
      meta: { cwd: process.cwd() },
      agentOptions: { provider: 'runtime-lab', model: 'fixture-model' },
    })
    ctx.effect(() => () => parentHandle.dispose())
    const parent = parentHandle.agent
    process.env.LAB_PARENT_SESSION_ID = parent.id
    parent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Create the parent-owned AgentTeams team now.' }],
      source: { kind: 'user' },
    }))
    await parent.whenIdle()
    const parentTeam = team('runtime-lab-parent')
    assert.equal(parentTeam.captainSessionId, parent.id)

    const activation = await ctx.subagents.startActivation({
      provider: 'fork',
      label: 'forked captain',
      request: {
        parent,
        prompt: [{ type: 'text', text: 'Create a separate team owned by this fork, then check which team your status tool resolves.' }],
      },
      signal: new AbortController().signal,
      delivery: 'caller',
    })
    try {
      const result = await activation.result
      assert.equal(result.stopReason, 'completed')
      const forkTeam = team('runtime-lab-fork')
      assert.equal(forkTeam.captainSessionId, activation.childId)
      assert.notEqual(forkTeam.captainSessionId, parentTeam.captainSessionId)
      record({
        event: 'fork-owned-team-product-passed',
        parentSessionId: parent.id,
        forkSessionId: activation.childId,
        parentTeamId: parentTeam.id,
        forkTeamId: forkTeam.id,
      })
      console.log('FORK_OWNED_TEAM_OK')
    } finally {
      await activation.dispose()
    }
  })().catch(error => {
    record({ event: 'fork-owned-team-product-failed', error: String(error), stack: error?.stack })
    console.error(error)
    process.exitCode = 1
  })
}
