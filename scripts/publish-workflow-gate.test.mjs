import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const WORKFLOW = new URL('../.github/workflows/publish.yml', import.meta.url);
const lines = readFileSync(WORKFLOW, 'utf8').split('\n');

/** Slice one job's block out of the workflow text without a YAML parser. */
function jobLines(name) {
    const start = lines.findIndex(line => line === `  ${name}:`);
    assert.notEqual(start, -1, `publish.yml no longer declares the "${name}" job`);
    const stop = lines.findIndex((line, index) => index > start && /^ {2}[a-z][a-z0-9-]*:$/u.test(line));
    return lines.slice(start + 1, stop === -1 ? lines.length : stop);
}

function indented(job, key) {
    const line = job.find(candidate => candidate.startsWith(`    ${key}:`));
    assert.ok(line !== undefined, `the job no longer declares "${key}"`);
    return line;
}

test('consumer-resolution runs only after a successful publish, and still needs it', () => {
    const job = jobLines('consumer-resolution');
    assert.match(
        indented(job, 'if'),
        /\$\{\{ !cancelled\(\) && needs\.publish\.result == 'success' \}\}/u,
    );
    assert.match(indented(job, 'needs'), /needs: publish$/u);
});

test('the release job keeps its always() gate on a successful publish', () => {
    const job = jobLines('release');
    const condition = indented(job, 'if');
    assert.match(condition, /always\(\) && needs\.publish\.result == 'success'/u);
    assert.doesNotMatch(condition, /!cancelled\(\)/u);
});

test('the publish job is the upstream every consumer gate depends on', () => {
    const publish = jobLines('publish');
    assert.match(indented(publish, 'needs'), /needs: verify$/u);
    for (const downstream of ['consumer-resolution', 'release']) {
        assert.match(indented(jobLines(downstream), 'needs'), /publish/u);
    }
});