/**
 * P0-4: `agent_teams_amend_task` honours the same optimistic lock as the other
 * rewrite entry points.
 *
 * The amendment is the one rewrite the PRD calls out explicitly: two captain
 * amendments in a row, with a third-party write in between, used to base the
 * second amendment on a contract the first one had already replaced. amend_task
 * now accepts an optional `expected_revision`; a stale value is refused before
 * anything is written, names the current revision to retry with, and leaves the
 * task content, the revision scalar and the revisions ledger untouched.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTeamDir, isTeamTask, readTeam } from '../src/state.ts';
import { registerAgentTeamsTools } from '../src/tools.ts';

const TEAM_ID = 'amend-revision-team';

function fakeAgent(id, cwd) {
    return {
        id, status: 'idle', options: { provider: 'p', model: 'm' },
        session: {
            id, seq: 0, header: { cwd, seedLength: 0 }, events: [], append() {},
            snapshotEvents: () => [], requestHeader: () => ({ config: { provider: 'p', model: 'm', reasoningEffort: 'high' } }),
        },
        followup() {}, steer() {}, cancel() {}, whenIdle() { return Promise.resolve() },
    };
}

/** A non-terminal quality task: amend_task only edits review/requirements-like contracts. */
function reviewTask(overrides = {}) {
    return {
        id: 't2', subject: 'Review the report', kind: 'review', status: 'pending', assignee: 'captain',
        dependencies: [], attempt: 0, revision: 1, createdAt: 1, updatedAt: 1,
        objective: 'Review the report', acceptance: ['covers the gap'],
        verify: ['pnpm verify:unit'], inScope: ['src/'], outOfScope: [],
        ...overrides,
    };
}

async function fixture(t, tasks) {
    const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-p04-amend-'));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    const stateRoot = join(workspace, '.agent-teams');
    const captain = fakeAgent('captain', workspace);
    const worker = fakeAgent('child-worker', workspace);
    await createTeamDir(stateRoot, {
        id: TEAM_ID, name: 'Amend Revision Team', captainSessionId: 'captain', createdAt: 1, phase: 'running',
        taskSeq: tasks.length,
        members: [{ id: 'child-worker', name: 'worker', joinedAt: 1, status: 'idle' }],
        tasks,
    });
    const definitions = new Map();
    const noop = () => {};
    const ctx = {
        effect(setup) { return setup(); }, on() { return noop; },
        tools: { register(definition) { definitions.set(definition.name, definition); } },
        agents: { list: () => [captain, worker], get: id => (id === captain.id ? captain : id === worker.id ? worker : undefined) },
        llm: { async listModels(provider) { return [{ provider, id: 'm', name: 'm' }]; }, async resolveCallConfig(config) { return config; } },
        subagents: {
            getProvider(name) { return name === 'spawn' ? { prepareContinuable() {}, capabilities: { persona: true, toolFilter: true } } : undefined; },
            list() { return ['spawn']; }, registerContinuableSetup() { return noop; },
            async followup() { return 'queued'; }, async sendMessage() { return 'sent'; }, interrupt() {},
            async listChildren() { return []; }, async listDescendants() { return []; }, async drainContinuableChildren() {},
        },
        logger: { warn: noop, debug: noop },
    };
    registerAgentTeamsTools(ctx, { stateDir: '.agent-teams', memberProvider: 'spawn', memberMaxDepth: 0, maxMembers: 8, profiles: {}, toolPolicies: {}, skills: {} });
    const call = (name, args) => definitions.get(name).execute(args, { agent: captain, callId: `${name}-test`, signal: new AbortController().signal });
    const task = async id => (await readTeam(stateRoot, TEAM_ID)).tasks.find(item => item.id === id);
    return { stateRoot, call, task };
}

test('a matching expected_revision amends the contract and advances the revision', async t => {
    const f = await fixture(t, [reviewTask()]);
    const before = await f.task('t2');
    const result = await f.call('agent_teams_amend_task', {
        task_id: 't2', expected_revision: 1, reason: 'acceptance asked for the impossible',
        objective: 'Review the report for the real gap',
    });
    assert.equal(result.revision_count, 1, 'the amendment is appended to the revisions ledger');
    const task = await f.task('t2');
    assert.equal(task.objective, 'Review the report for the real gap');
    assert.equal(task.revision, 2, 'one accepted amendment advances the lock exactly once');
    assert.equal(task.revisions.length, 1, 'the ledger keeps one entry per amendment');
    assert.ok(task.updatedAt >= before.updatedAt);
});

test('a stale expected_revision is refused with the current revision and changes nothing', async t => {
    const f = await fixture(t, [reviewTask({ revision: 4 })]);
    const before = await f.task('t2');
    await assert.rejects(
        () => f.call('agent_teams_amend_task', {
            task_id: 't2', expected_revision: 3, reason: 'second amendment of the day',
            objective: 'A contract based on revision three',
        }),
        /task "t2" was changed by someone else: you based this change on revision 3, but it is now at revision 4\..*agent_teams_status.*expected_revision: 4/u,
    );
    const task = await f.task('t2');
    assert.equal(task.objective, before.objective, 'a refused amendment must not write the contract');
    assert.equal(task.revision, 4, 'a refused amendment must not bump the revision');
    assert.deepEqual(task.revisions ?? [], before.revisions ?? [], 'a refused amendment must not append a ledger entry');
});

test('omitting expected_revision keeps the previous unconditional behaviour', async t => {
    const f = await fixture(t, [reviewTask({ revision: 7 })]);
    await f.call('agent_teams_amend_task', {
        task_id: 't2', reason: 'legacy caller without a lock', acceptance: ['covers the real gap'],
    });
    const task = await f.task('t2');
    assert.deepEqual(task.acceptance, ['covers the real gap']);
    assert.equal(task.revision, 8, 'the amendment still bumps the revision when no lock is supplied');
});

test('an unusable expected_revision is rejected before any write', async t => {
    const f = await fixture(t, [reviewTask({ revision: 2 })]);
    for (const expected_revision of [0, 1.5, 'x']) {
        await assert.rejects(
            () => f.call('agent_teams_amend_task', {
                task_id: 't2', expected_revision, reason: 'bad lock value', objective: 'nope',
            }),
            // The tool schema rejects a non-number before the handler runs; the handler
            // rejects the remaining unusable numbers. Both are refusals, neither writes.
            /expected_revision must be an integer >= 1|"expected_revision" must be a number/u,
            `expected_revision=${String(expected_revision)} must be refused`,
        );
    }
    const task = await f.task('t2');
    assert.equal(task.objective, 'Review the report', 'no rejected value may reach the contract');
    assert.equal(task.revision, 2);
    assert.deepEqual(task.revisions ?? [], []);
});

test('a third-party rewrite between two amendments makes the second one stale', async t => {
    const f = await fixture(t, [reviewTask()]);
    await f.call('agent_teams_amend_task', {
        task_id: 't2', expected_revision: 1, reason: 'first amendment', objective: 'First contract',
    });
    const afterFirst = await f.task('t2');
    assert.equal(afterFirst.revision, 2);

    // Any durable rewrite of the same task is a third-party write for the next
    // amendment; a review contract cannot move pending -> in_progress, so the
    // captain annotates the task instead (still a revision bump).
    await f.call('agent_teams_update_task', {
        task_id: 't2', expected_revision: 2, output: 'captain moved the task on',
    });
    const afterUpdate = await f.task('t2');
    assert.equal(afterUpdate.revision, 3, 'update_task is the third-party writer');

    await assert.rejects(
        () => f.call('agent_teams_amend_task', {
            task_id: 't2', expected_revision: afterFirst.revision, reason: 'second amendment on a stale read',
            objective: 'Second contract computed from the first amendment',
        }),
        /based this change on revision 2, but it is now at revision 3.*expected_revision: 3/u,
    );
    const refused = await f.task('t2');
    assert.equal(refused.objective, 'First contract', 'the stale amendment leaves the first contract intact');
    assert.equal(refused.revisions.length, 1);

    await f.call('agent_teams_amend_task', {
        task_id: 't2', expected_revision: 3, reason: 'second amendment after re-reading the task',
        objective: 'Second contract',
    });
    const amended = await f.task('t2');
    assert.equal(amended.objective, 'Second contract');
    assert.equal(amended.revision, 4, 'the retry with the current revision is the only write that lands');
    assert.equal(amended.revisions.length, 2);
});

test('the review freeze still wins over a valid expected_revision', async t => {
    const passed = {
        id: 't3', subject: 'Review mask', kind: 'review', status: 'completed', dependencies: ['t2'],
        createdAt: 1, updatedAt: 1, attempt: 1, verdict: 'pass', reviewedTaskId: 't2', reviewedAttempt: 1,
        objective: 'Review mask', acceptance: ['no blockers'],
    };
    const f = await fixture(t, [reviewTask(), passed]);
    assert.ok(isTeamTask(passed));
    await assert.rejects(
        () => f.call('agent_teams_amend_task', {
            task_id: 't2', expected_revision: 1, reason: 'too late', objective: 'Frozen contract',
        }),
        /already passed review; its contract is frozen/u,
    );
    const task = await f.task('t2');
    assert.equal(task.objective, 'Review the report');
    assert.equal(task.revision, 1, 'the frozen-contract refusal must not bump the revision either');
});