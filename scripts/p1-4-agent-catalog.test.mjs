/**
 * P1-4 portable agent-preset catalog: import → export → re-import round trip,
 * same-name conflicts, path-traversal refusal, and warn-don't-fail validation.
 *
 * These cases exercise `src/agent-library.ts` directly because the catalog is a
 * pure filesystem module: the tool wrapper only forwards arguments.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
    exportAgentCatalog,
    importAgentCatalog,
    loadAgentLibrary,
    resolvePresetByName,
    saveAgentPreset,
} from '../src/agent-library.ts';

const scratch = (t, label) => {
    const root = mkdtempSync(join(tmpdir(), `agent-catalog-${label}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return root;
};

const byName = (left, right) => left.name.localeCompare(right.name);

const comparable = preset => ({
    name: preset.name,
    role: preset.role,
    provider: preset.provider,
    model: preset.model,
    reasoningEffort: preset.reasoningEffort,
    executionPrompt: preset.executionPrompt,
    skillIds: [...preset.skillIds],
    toolPolicy: preset.toolPolicy,
    avatar: preset.avatar,
});

const writeEntry = (root, name, manifest, extra = {}) => {
    const directory = join(root, name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'plugin.json'), JSON.stringify(manifest));
    if (extra.instructions !== undefined) writeFileSync(join(directory, 'instructions.md'), extra.instructions);
    for (const [file, body] of Object.entries(extra.files ?? {})) writeFileSync(join(directory, file), body);
    return directory;
};

test('export → import → export reproduces the same presets', async t => {
    const source = scratch(t, 'source'), target = scratch(t, 'target'), catalog = join(scratch(t, 'catalog'), 'agents');
    await saveAgentPreset(source, {
        name: 'Writer', role: 'Writes prose', provider: 'p', model: 'm', reasoningEffort: 'high',
        executionPrompt: 'Be surgical.', skillIds: ['docs'], toolPolicy: 'read-only',
    });
    await saveAgentPreset(source, { name: 'Reader', role: '', executionPrompt: 'Read only.', skillIds: [] });
    const before = (await loadAgentLibrary(source)).presets.map(comparable).sort(byName);

    const exported = await exportAgentCatalog(source, catalog);
    assert.deepEqual(exported.exported.map(entry => entry.name), ['Reader', 'Writer']);
    assert.ok(existsSync(join(catalog, 'writer', 'plugin.json')));
    assert.equal(readFileSync(join(catalog, 'writer', 'instructions.md'), 'utf8').trim(), 'Be surgical.');

    const imported = await importAgentCatalog(target, catalog);
    assert.equal(imported.imported.length, 2);
    assert.deepEqual([...imported.conflicts, ...imported.skipped], []);
    assert.deepEqual((await loadAgentLibrary(target)).presets.map(comparable).sort(byName), before);

    // the summon gesture resolves case- and whitespace-insensitively
    const writer = resolvePresetByName((await loadAgentLibrary(target)).presets, '  writer ');
    assert.equal(writer?.executionPrompt, 'Be surgical.');
    assert.equal(resolvePresetByName([], 'nobody'), undefined);
});

test('same-name presets are refused by default, then left untouched by an identical overwrite', async t => {
    const source = scratch(t, 'conflict-source'), target = scratch(t, 'conflict-target');
    const catalog = join(scratch(t, 'conflict-catalog'), 'agents');
    await saveAgentPreset(source, { name: 'Solo', role: 'r', executionPrompt: 'One.', skillIds: [] });
    await exportAgentCatalog(source, catalog);
    assert.equal((await importAgentCatalog(target, catalog)).imported.length, 1);
    const revision = (await loadAgentLibrary(target)).presets[0].revision;

    const second = await importAgentCatalog(target, catalog);
    assert.deepEqual(second.imported, []);
    assert.equal(second.conflicts.length, 1);
    assert.equal(second.conflicts[0].name, 'Solo');
    assert.equal((await loadAgentLibrary(target)).presets[0].revision, revision, 'a refused conflict must not bump the revision');

    const forced = await importAgentCatalog(target, catalog, { overwrite: true });
    assert.deepEqual(forced.unchanged, ['Solo']);
    assert.deepEqual(forced.imported, []);
    assert.equal((await loadAgentLibrary(target)).presets[0].revision, revision, 'identical content must stay revision-stable');
});

test('import refuses path traversal and absolute references instead of reading outside the catalog', async t => {
    const stateRoot = scratch(t, 'traversal-state'), catalog = join(scratch(t, 'traversal'), 'agents');
    writeEntry(catalog, 'escape', { name: 'Escape', instructionsFile: '../../../../etc/passwd' });
    await assert.rejects(() => importAgentCatalog(stateRoot, catalog), /path traversal/);
    writeEntry(catalog, 'absolute', { name: 'Absolute', instructionsFile: '/etc/passwd' });
    await assert.rejects(() => importAgentCatalog(stateRoot, catalog), /refusing absolute/);
    assert.deepEqual((await loadAgentLibrary(stateRoot)).presets, []);
});

test('missing fields warn per entry and never abort the whole import', async t => {
    const stateRoot = scratch(t, 'warn'), catalog = join(scratch(t, 'warn-catalog'), 'agents');
    writeEntry(catalog, 'complete', { name: 'Complete', role: 'Has everything', skills: ['docs'] }, { instructions: 'Do the thing.' });
    writeEntry(catalog, 'partial', { name: 'Partial' });
    writeEntry(catalog, 'route', { name: 'Route', role: 'r', provider: 'lonely' }, { instructions: 'x' });
    const result = await importAgentCatalog(stateRoot, catalog);
    assert.equal(result.imported.length, 3, 'a bare entry still imports');
    const fields = result.warnings.map(warning => `${warning.source}:${warning.field}`);
    assert.ok(fields.includes('partial:instructions'), 'missing instructions.md must warn');
    assert.ok(fields.includes('partial:role'), 'missing role must warn');
    assert.ok(fields.includes('route:provider'), 'a provider without a model must warn');
    const presets = (await loadAgentLibrary(stateRoot)).presets;
    const partial = resolvePresetByName(presets, 'Partial');
    assert.equal(partial?.executionPrompt, 'Partial', 'the fallback prompt is the name, not an empty string');
    assert.equal(resolvePresetByName(presets, 'Route')?.provider, undefined, 'the partial route is dropped');
});

test('directory entries accept skills/ and a single JSON file imports the same shape', async t => {
    const stateRoot = scratch(t, 'mixed'), root = scratch(t, 'mixed-catalog'), catalog = join(root, 'agents');
    const entry = writeEntry(catalog, 'skilled', { name: 'Skilled', role: 'r' }, { instructions: 'Skilled prompt.' });
    mkdirSync(join(entry, 'skills', 'docs'), { recursive: true });
    mkdirSync(join(entry, 'skills', 'review'), { recursive: true });
    const file = join(root, 'presets.json');
    writeFileSync(file, JSON.stringify({
        schemaVersion: 1,
        presets: [
            { name: 'Inline', role: 'r', executionPrompt: 'Inline prompt.', skills: ['docs'] },
            { role: 'no name at all' },
        ],
    }));
    const fromDirectory = await importAgentCatalog(stateRoot, catalog);
    const fromFile = await importAgentCatalog(stateRoot, file);
    assert.deepEqual(fromDirectory.imported.map(entry => entry.name), ['Skilled']);
    assert.deepEqual(fromFile.imported.map(entry => entry.name), ['Inline']);
    assert.equal(fromFile.skipped.length, 1);
    assert.match(fromFile.skipped[0].reason, /no name/);
    const presets = (await loadAgentLibrary(stateRoot)).presets;
    assert.deepEqual(resolvePresetByName(presets, 'Skilled')?.skillIds, ['docs', 'review']);
    assert.equal(resolvePresetByName(presets, 'Inline')?.executionPrompt, 'Inline prompt.');
});

test('import never executes scripts shipped inside the catalog', async t => {
    const stateRoot = scratch(t, 'execute'), root = scratch(t, 'execute-catalog'), catalog = join(root, 'agents');
    const marker = join(root, 'executed.marker');
    writeEntry(catalog, 'scripted', { name: 'Scripted', role: 'r' }, {
        instructions: 'Nothing here runs.',
        files: {
            'package.json': JSON.stringify({ name: 'scripted', scripts: { postinstall: 'node evil.mjs' } }),
            'evil.mjs': `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'boom');`,
        },
    });
    assert.equal((await importAgentCatalog(stateRoot, catalog)).imported.length, 1);
    assert.equal(existsSync(marker), false, 'import must not run catalog scripts');
});