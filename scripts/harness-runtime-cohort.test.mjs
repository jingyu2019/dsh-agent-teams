import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inspectRuntimeCohort } from './harness-runtime-cohort.mjs';

const VERSION = '0.2.2-rc.3';
const HOST = 'node_modules/@deepseek-ai/dsh';
const CUA_MACOS = 'node_modules/@deepseek-ai/dsh-experimental-cua-macos';
const NATIVE_ARM64 = 'node_modules/@deepseek-ai/dsh-native-fixture';

/** Write one fake runtime tree: the lock file plus the manifests that are "installed". */
function makeRuntime(t, packages, installed = {}) {
    const root = mkdtempSync(join(tmpdir(), 'runtime-cohort-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const bytes = Buffer.from(JSON.stringify({ name: 'cohort-fixture', packages }));
    writeFileSync(join(root, 'package-lock.json'), bytes);
    for (const [path, manifest] of Object.entries(installed)) {
        mkdirSync(join(root, path), { recursive: true });
        writeFileSync(join(root, path, 'package.json'), JSON.stringify(manifest));
    }
    return { root, lockSha256: createHash('sha256').update(bytes).digest('hex') };
}

test('optional packages for another platform are skipped with reason optional-platform', t => {
    const { root } = makeRuntime(t, {
        [HOST]: { version: VERSION },
        [CUA_MACOS]: { version: VERSION, optional: true, os: ['darwin'] },
        [NATIVE_ARM64]: { version: VERSION, optional: true, cpu: ['arm64'] },
    }, { [HOST]: { name: '@deepseek-ai/dsh', version: VERSION } });
    const result = inspectRuntimeCohort(root, VERSION, { platform: 'linux', arch: 'x64' });
    assert.equal(result.count, 1);
    assert.deepEqual(result.cohort.map(entry => entry.name), ['@deepseek-ai/dsh']);
    assert.deepEqual(result.skipped.map(entry => entry.path), [CUA_MACOS, NATIVE_ARM64]);
    for (const entry of result.skipped) assert.equal(entry.reason, 'optional-platform');
    assert.deepEqual(result.skipped.map(entry => entry.os), [['darwin'], undefined]);
    assert.deepEqual(result.skipped.map(entry => entry.cpu), [undefined, ['arm64']]);
});

test('a non-optional host package missing on this platform still fails', t => {
    const { root } = makeRuntime(t, {
        [HOST]: { version: VERSION },
        [CUA_MACOS]: { version: VERSION, optional: false, os: ['darwin'] },
    }, { [HOST]: { name: '@deepseek-ai/dsh', version: VERSION } });
    assert.throws(
        () => inspectRuntimeCohort(root, VERSION, { platform: 'linux', arch: 'x64' }),
        /Missing host package node_modules\/@deepseek-ai\/dsh-experimental-cua-macos on linux\/x64/,
    );
});

test('an optional package the platform admits is not exempt from being installed', t => {
    const { root } = makeRuntime(t, {
        [HOST]: { version: VERSION },
        [CUA_MACOS]: { version: VERSION, optional: true, os: ['darwin'] },
    }, { [HOST]: { name: '@deepseek-ai/dsh', version: VERSION } });
    assert.throws(
        () => inspectRuntimeCohort(root, VERSION, { platform: 'darwin', arch: 'arm64' }),
        /Missing host package/,
    );
    // A negated constraint excludes the package everywhere but the named platform.
    const negated = makeRuntime(t, {
        [HOST]: { version: VERSION },
        [CUA_MACOS]: { version: VERSION, optional: true, os: ['!linux'] },
    }, { [HOST]: { name: '@deepseek-ai/dsh', version: VERSION } });
    const excluded = inspectRuntimeCohort(negated.root, VERSION, { platform: 'linux', arch: 'x64' });
    assert.deepEqual(excluded.skipped.map(entry => entry.path), [CUA_MACOS]);
    assert.equal(excluded.skipped[0].reason, 'optional-platform');
    assert.throws(
        () => inspectRuntimeCohort(negated.root, VERSION, { platform: 'darwin', arch: 'arm64' }),
        /Missing host package/,
    );
});

test('the lock and the installed tree must agree on the cohort version', t => {
    const lockMismatch = makeRuntime(t, {
        [HOST]: { version: VERSION },
        [CUA_MACOS]: { version: '0.2.2-rc.2', optional: true, os: ['darwin'] },
    }, { [HOST]: { name: '@deepseek-ai/dsh', version: VERSION } });
    assert.throws(
        () => inspectRuntimeCohort(lockMismatch.root, VERSION, { platform: 'linux', arch: 'x64' }),
        /Mixed host cohort node_modules\/@deepseek-ai\/dsh-experimental-cua-macos: lock 0\.2\.2-rc\.2, expected 0\.2\.2-rc\.3/,
    );

    const diskMismatch = makeRuntime(t, { [HOST]: { version: VERSION } }, {
        [HOST]: { name: '@deepseek-ai/dsh', version: '0.2.2-rc.1' },
    });
    assert.throws(
        () => inspectRuntimeCohort(diskMismatch.root, VERSION, { platform: 'linux', arch: 'x64' }),
        /Mixed host cohort node_modules\/@deepseek-ai\/dsh: disk 0\.2\.2-rc\.1, expected 0\.2\.2-rc\.3/,
    );
});

test('a tree without an actual Harness install is rejected', t => {
    const { root } = makeRuntime(t, {
        [CUA_MACOS]: { version: VERSION, optional: true, os: ['darwin'] },
    });
    assert.throws(
        () => inspectRuntimeCohort(root, VERSION, { platform: 'linux', arch: 'x64' }),
        /No actual Harness installation/,
    );
});

test('a matching cohort reports the lock digest and every admitted package', t => {
    const { root, lockSha256 } = makeRuntime(t, {
        [HOST]: { version: VERSION, integrity: 'sha512-host' },
        [NATIVE_ARM64]: { version: VERSION, integrity: 'sha512-native', optional: true, cpu: ['arm64'] },
    }, {
        [HOST]: { name: '@deepseek-ai/dsh', version: VERSION },
        [NATIVE_ARM64]: { name: '@deepseek-ai/dsh-native-fixture', version: VERSION },
    });
    const result = inspectRuntimeCohort(root, VERSION, { platform: 'darwin', arch: 'arm64' });
    assert.equal(result.version, VERSION);
    assert.equal(result.count, 2);
    assert.equal(result.lockSha256, lockSha256);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(result.cohort, [
        { path: HOST, name: '@deepseek-ai/dsh', version: VERSION, integrity: 'sha512-host' },
        { path: NATIVE_ARM64, name: '@deepseek-ai/dsh-native-fixture', version: VERSION, integrity: 'sha512-native' },
    ]);
});