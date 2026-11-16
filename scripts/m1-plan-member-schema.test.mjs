/**
 * `agent_teams_create` plan.members[] schema behaviour.
 *
 * Upstream #352: `executionPrompt` was declared on the interface but missing
 * from the tool schema, so a caller-supplied value was silently dropped before
 * validation and the member never saw it. Type-checking and source greps both
 * miss that class of defect, so these cases assert the exported schema object
 * and the consumer path instead.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveTeamProfile } from '../lib/profiles.js';

// lib/tools.js may be a build behind src/tools.ts; say so instead of failing
// inside an assertion with an unrelated TypeError.
const { planMemberSchema } = await import('../lib/tools.js');
if (planMemberSchema === undefined)
    throw new Error('lib/tools.js is stale: it does not export planMemberSchema yet; run "npm run build" before this test');

test('plan.members[] schema is closed and declares executionPrompt', () => {
    assert.equal(planMemberSchema.type, 'object');
    assert.equal(planMemberSchema.additionalProperties, false, 'unknown member fields must be rejected, not silently dropped');
    const prompt = planMemberSchema.properties.executionPrompt;
    assert.ok(prompt !== undefined, 'planMemberSchema must declare executionPrompt');
    assert.equal(prompt.type, 'string');
    assert.ok(typeof prompt.description === 'string' && prompt.description.length > 0);
});

test('plan.members[] schema keeps every pre-existing member field', () => {
    const expected = {
        name: 'string',
        role: 'string',
        provider: 'string',
        model: 'string',
        reasoning_effort: 'string',
        tool_policy: 'string',
        skills: 'array',
        preset_id: 'string',
    };
    for (const [field, type] of Object.entries(expected)) {
        assert.ok(planMemberSchema.properties[field] !== undefined, `planMemberSchema lost ${field}`);
        assert.equal(planMemberSchema.properties[field].type, type, `${field} changed type`);
    }
    assert.deepEqual(Object.keys(planMemberSchema.properties).sort(), [...Object.keys(expected), 'executionPrompt'].sort());
    assert.equal(planMemberSchema.properties.name.required, true);
    assert.deepEqual(planMemberSchema.properties.skills.items, { type: 'string' });
});

test('profile normalization preserves a plan member executionPrompt and leaves it absent when omitted', () => {
    const profile = resolveTeamProfile({
        'schema probe': {
            members: [
                { name: 'writer', executionPrompt: 'Prefer surgical diffs.' },
                { name: 'reader' },
            ],
        },
    }, 'schema probe', 4);
    assert.deepEqual(profile.members.map(member => member.name), ['writer', 'reader']);
    assert.equal(profile.members[0].executionPrompt, 'Prefer surgical diffs.');
    assert.equal(profile.members[1].executionPrompt, undefined);
});
