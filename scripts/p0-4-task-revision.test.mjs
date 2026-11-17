/**
 * P0-4: optimistic locking on task rewrites.
 *
 * `TeamTask.revision` is a monotonic scalar (1 on creation, +1 per
 * contract/status/assignee write). The three rewrite entry points
 * (`update_task`, `reassign_task`, `edit_plan` update_task) accept an optional
 * `expected_revision`; a stale value is refused with an actionable message and
 * leaves the record untouched, and omitting it keeps the old behaviour.
 *
 * Legacy records written before this field read back as revision 1.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTeamDir, isTeamTask, readTeam } from '../src/state.ts';
import { bumpTaskRevision, expectedRevisionError, taskRevision } from '../src/task-revision.ts';
import { registerAgentTeamsTools } from '../src/tools.ts';

const TEAM_ID = 'revision-team';

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

function taskRecord(overrides = {}) {
    return {
        id: 't1', subject: 'Write the report', status: 'claimed', assignee: 'captain',
        dependencies: [], attempt: 1, revision: 1, kind: 'work', createdAt: 1, updatedAt: 1,
        ...overrides,
    };
}

async function fixture(t, tasks) {
    const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-p04-'));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    const stateRoot = join(workspace, '.agent-teams');
    const captain = fakeAgent('captain', workspace);
    const worker = fakeAgent('child-worker', workspace);
    await createTeamDir(stateRoot, {
        id: TEAM_ID, name: 'Revision Team', captainSessionId: 'captain', createdAt: 1, phase: 'running',
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

test('a matching expected_revision updates the task and advances the revision', async t => {
    const f = await fixture(t, [taskRecord()]);
    await f.call('agent_teams_update_task', { task_id: 't1', expected_revision: 1, status: 'in_progress', output: 'started' });
    const task = await f.task('t1');
    assert.equal(task.status, 'in_progress');
    assert.equal(task.output, 'started');
    assert.equal(task.revision, 2, 'one accepted write advances the lock exactly once');
});

test('a stale expected_revision is refused with the current revision and changes nothing', async t => {
    const f = await fixture(t, [taskRecord({ revision: 4 })]);
    await assert.rejects(
        () => f.call('agent_teams_update_task', { task_id: 't1', expected_revision: 3, status: 'in_progress', output: 'stale write' }),
        /changed by someone else.*based this change on revision 3.*now at revision 4.*agent_teams_status.*expected_revision: 4/u,
    );
    const task = await f.task('t1');
    assert.equal(task.revision, 4, 'a refused update must not bump the revision');
    assert.equal(task.status, 'claimed');
    assert.equal(task.output, undefined, 'a refused update must not write the payload');
});

test('omitting expected_revision keeps the previous unconditional behaviour', async t => {
    const f = await fixture(t, [taskRecord({ revision: 7 })]);
    await f.call('agent_teams_update_task', { task_id: 't1', status: 'in_progress', output: 'legacy caller' });
    const task = await f.task('t1');
    assert.equal(task.status, 'in_progress');
    assert.equal(task.revision, 8);
});

test('reassign_task honours expected_revision', async t => {
    const f = await fixture(t, [taskRecord({ status: 'pending', assignee: undefined, attempt: 0 })]);
    await assert.rejects(
        () => f.call('agent_teams_reassign_task', { task_id: 't1', assignee: 'captain', expected_revision: 9 }),
        /changed by someone else.*revision 9.*now at revision 1/u,
    );
    assert.equal((await f.task('t1')).status, 'pending', 'a refused reassignment must not move the task');
    await f.call('agent_teams_reassign_task', { task_id: 't1', assignee: 'captain', expected_revision: 1 });
    const task = await f.task('t1');
    assert.equal(task.assignee, 'captain');
    assert.ok(task.revision > 1, 'every reassignment path bumps the revision');
});

test('edit_plan update_task honours expected_revision for never-started work', async t => {
    const f = await fixture(t, [taskRecord({ status: 'pending', assignee: undefined, attempt: 0 })]);
    const mutation = { action: 'update_task', task_id: 't1', subject: 'Sharper subject', expected_revision: 9 };
    await assert.rejects(
        () => f.call('agent_teams_edit_plan', { operations: [mutation] }),
        /changed by someone else.*revision 9.*now at revision 1/u,
    );
    assert.equal((await f.task('t1')).subject, 'Write the report', 'a refused plan edit must not be applied');
    await f.call('agent_teams_edit_plan', { operations: [{ ...mutation, expected_revision: 1 }] });
    const task = await f.task('t1');
    assert.equal(task.subject, 'Sharper subject');
    // Editing a running team's plan also lets the scheduler look at the newly
    // ready task, and a claim is itself a durable rewrite. So the exact value
    // depends on whether dispatch raced the read; the lock must advance at
    // least once and every later write must keep building on it.
    assert.ok(task.revision >= 2, `an accepted plan edit advances the lock (saw ${task.revision})`);
});

test('a legacy task without a revision reads as 1 and gains the field on its next write', async t => {
    const legacy = taskRecord();
    delete legacy.revision;
    const f = await fixture(t, [legacy]);
    const task = await f.task('t1');
    // The field is NOT fabricated on read: a read-back record must stay
    // byte-identical to the in-memory state an audit captured, otherwise every
    // audit would report phantom drift. Legacy records read as 1 through the
    // helper and are rewritten with the field on the next durable write.
    assert.equal(task.revision, undefined, 'a legacy record keeps its stored shape');
    assert.equal(taskRevision(task), 1, 'legacy records read as revision 1');
    assert.equal(isTeamTask({ ...task }), true, 'a legacy task is still a valid task');
    assert.equal(isTeamTask({ ...task, revision: 0 }), false, 'revision must be an integer >= 1');
    assert.equal(isTeamTask({ ...task, revision: 2.5 }), false, 'revision must be an integer');

    await f.call('agent_teams_update_task', { task_id: 't1', expected_revision: 1, status: 'in_progress', output: 'started' });
    assert.equal((await f.task('t1')).revision, 2, 'the first write after legacy normalizes the lock to 2');
});

test('the shared helpers keep the lock honest in isolation', () => {
    const task = { revision: 3 };
    assert.equal(taskRevision(task), 3);
    assert.equal(bumpTaskRevision(task), 4);
    assert.equal(task.revision, 4);
    assert.equal(taskRevision({}), 1, 'a missing revision reads as 1');
    assert.equal(expectedRevisionError({ id: 't9', revision: 2 }, undefined), undefined);
    assert.equal(expectedRevisionError({ id: 't9', revision: 2 }, 2), undefined);
    assert.match(expectedRevisionError({ id: 't9', revision: 2 }, 1), /task "t9".*revision 1.*revision 2/u);
});