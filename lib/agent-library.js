/** Versioned, plugin-owned global agent preset library. No live sessions. */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
export const AGENT_LIBRARY_FILE = 'agent-library/presets.json';
export const AGENT_LIBRARY_MAX_PRESETS = 100;
const emptyLibrary = () => ({ schemaVersion: 1, presets: [] });
function libraryPath(stateRoot) {
    return join(stateRoot, AGENT_LIBRARY_FILE);
}
function isPreset(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    const preset = value;
    return preset['schemaVersion'] === 1
        && typeof preset['id'] === 'string' && preset['id'] !== ''
        && Number.isSafeInteger(preset['revision']) && preset['revision'] >= 1
        && typeof preset['name'] === 'string' && preset['name'].trim() !== ''
        && typeof preset['role'] === 'string'
        && typeof preset['executionPrompt'] === 'string'
        && Array.isArray(preset['skillIds']) && preset['skillIds'].every(item => typeof item === 'string')
        && Number.isFinite(preset['createdAt']) && Number.isFinite(preset['updatedAt']);
}
export async function loadAgentLibrary(stateRoot) {
    try {
        const raw = JSON.parse(await readFile(libraryPath(stateRoot), 'utf8'));
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
            throw new Error('agent library must be an object');
        const object = raw;
        if (object['schemaVersion'] !== 1 || !Array.isArray(object['presets']) || !object['presets'].every(isPreset)) {
            throw new Error('agent library has an unsupported or invalid shape');
        }
        if (object['presets'].length > AGENT_LIBRARY_MAX_PRESETS)
            throw new Error('agent library exceeds its preset cap');
        return { schemaVersion: 1, presets: object['presets'] };
    }
    catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
            return emptyLibrary();
        throw error;
    }
}
async function saveAgentLibrary(stateRoot, library) {
    const file = libraryPath(stateRoot);
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(library, null, 2), 'utf8');
    await rename(temporary, file);
}
/** Create or update one revision; updates never mutate Teams that copied an older revision. */
export async function saveAgentPreset(stateRoot, input) {
    const library = await loadAgentLibrary(stateRoot);
    const now = Date.now();
    const id = input.id?.trim() || randomUUID();
    const existingIndex = library.presets.findIndex(preset => preset.id === id);
    if (existingIndex < 0 && library.presets.length >= AGENT_LIBRARY_MAX_PRESETS) {
        throw new Error(`agent library is at its ${AGENT_LIBRARY_MAX_PRESETS}-preset cap`);
    }
    if (library.presets.some((preset, index) => index !== existingIndex && preset.name.trim().toLowerCase() === input.name.trim().toLowerCase())) {
        throw new Error(`agent preset name "${input.name.trim()}" is already used`);
    }
    const existing = existingIndex < 0 ? undefined : library.presets[existingIndex];
    const preset = {
        schemaVersion: 1,
        id,
        revision: (existing?.revision ?? 0) + 1,
        name: input.name.trim(),
        role: input.role.trim(),
        ...input.provider === undefined ? {} : { provider: input.provider },
        ...input.model === undefined ? {} : { model: input.model },
        ...input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort },
        executionPrompt: input.executionPrompt,
        skillIds: [...input.skillIds],
        ...input.toolPolicy === undefined ? {} : { toolPolicy: input.toolPolicy },
        ...input.avatar === undefined ? {} : { avatar: input.avatar },
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
    };
    if (existingIndex < 0)
        library.presets.push(preset);
    else
        library.presets[existingIndex] = preset;
    await saveAgentLibrary(stateRoot, library);
    return preset;
}
export async function deleteAgentPreset(stateRoot, id) {
    const library = await loadAgentLibrary(stateRoot);
    const next = library.presets.filter(preset => preset.id !== id);
    if (next.length === library.presets.length)
        return false;
    await saveAgentLibrary(stateRoot, { schemaVersion: 1, presets: next });
    return true;
}
/** Portable catalog layout: `agents/<name>/plugin.json` plus `instructions.md`. */
export const AGENT_CATALOG_MANIFEST = 'plugin.json';
export const AGENT_CATALOG_INSTRUCTIONS = 'instructions.md';
const CATALOG_SKILL_DIRECTORY = 'skills';
const CATALOG_MAX_SKILL_IDS = 8;
function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}
function isMissingFile(error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
/**
 * Reject absolute, drive-letter, UNC and `..` references inside an imported
 * catalog: an entry may only point at files below its own directory.
 */
function catalogRelativePath(value, field) {
    if (value === '')
        throw new Error(`${field} must not be empty`);
    if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) {
        throw new Error(`refusing absolute ${field} in an imported catalog: ${value}`);
    }
    const segments = value.split(/[\\/]+/).filter(segment => segment !== '' && segment !== '.');
    if (segments.includes('..'))
        throw new Error(`refusing path traversal in an imported catalog ${field}: ${value}`);
    return segments.join('/');
}
function catalogString(raw, keys, source, field, warnings) {
    for (const key of keys) {
        const value = raw[key];
        if (value === undefined || value === null)
            continue;
        if (typeof value !== 'string') {
            warnings.push({ source, field, message: `${key} must be a string; the value was ignored` });
            continue;
        }
        const trimmed = value.trim();
        if (trimmed !== '')
            return trimmed;
    }
    return undefined;
}
function catalogSkillIds(raw, source, warnings) {
    const value = raw['skills'] ?? raw['skillIds'] ?? raw['skill_ids'];
    if (value === undefined)
        return [];
    if (!Array.isArray(value)) {
        warnings.push({ source, field: 'skills', message: 'skills must be an array of skill ids; the value was ignored' });
        return [];
    }
    const ids = [];
    for (const item of value) {
        if (typeof item === 'string') {
            const id = item.trim();
            if (id !== '')
                ids.push(id);
            continue;
        }
        const record = asRecord(item);
        const id = typeof record?.['id'] === 'string' ? record['id'].trim() : '';
        if (id === '') {
            warnings.push({ source, field: 'skills', message: 'skill entry without a string id was ignored' });
            continue;
        }
        ids.push(id);
    }
    const unique = [...new Set(ids)];
    if (unique.length > CATALOG_MAX_SKILL_IDS) {
        warnings.push({ source, field: 'skills', message: `at most ${CATALOG_MAX_SKILL_IDS} skill ids are imported; extra ids were dropped` });
        return unique.slice(0, CATALOG_MAX_SKILL_IDS);
    }
    return unique;
}
function catalogAvatar(raw, source, warnings) {
    const value = raw['avatar'];
    if (value === undefined || value === null)
        return undefined;
    const record = asRecord(value);
    const role = typeof record?.['role'] === 'string' ? record['role'].trim() : '';
    if (record?.['kind'] === 'builtin' && role !== '')
        return { kind: 'builtin', role };
    const sha256 = typeof record?.['sha256'] === 'string' ? record['sha256'] : '';
    const ext = record?.['ext'];
    if (record?.['kind'] === 'managed' && /^[a-f0-9]{64}$/.test(sha256) && (ext === 'png' || ext === 'jpg' || ext === 'webp')) {
        warnings.push({ source, field: 'avatar', message: 'managed avatar binaries are not portable; the reference is copied as-is' });
        return { kind: 'managed', sha256, ext };
    }
    warnings.push({ source, field: 'avatar', message: 'avatar must be {kind:"builtin",role} or {kind:"managed",sha256,ext}; the value was ignored' });
    return undefined;
}
/** Normalize one manifest into a preset input; missing fields warn, only a nameless entry fails. */
function catalogPresetInput(source, raw, defaultName, warnings, instructions) {
    const declaredName = catalogString(raw, ['name'], source, 'name', warnings);
    const name = declaredName ?? (defaultName.trim() === '' ? undefined : defaultName.trim());
    if (name === undefined)
        return { reason: 'entry has no name' };
    if (declaredName === undefined)
        warnings.push({ source, field: 'name', message: 'name is missing from the manifest; the directory name was used' });
    const role = catalogString(raw, ['role', 'description'], source, 'role', warnings) ?? '';
    if (role === '')
        warnings.push({ source, field: 'role', message: 'role is missing; the preset is imported with an empty role' });
    let provider = catalogString(raw, ['provider'], source, 'provider', warnings);
    let model = catalogString(raw, ['model'], source, 'model', warnings);
    if ((provider === undefined) !== (model === undefined)) {
        warnings.push({ source, field: 'provider', message: 'provider and model must be supplied together; the partial route was ignored' });
        provider = undefined;
        model = undefined;
    }
    const reasoningEffort = catalogString(raw, ['reasoningEffort', 'reasoning_effort'], source, 'reasoningEffort', warnings);
    const toolPolicy = catalogString(raw, ['toolPolicy', 'tool_policy'], source, 'toolPolicy', warnings);
    const inlinePrompt = catalogString(raw, ['executionPrompt', 'execution_prompt', 'prompt', 'instructions'], source, 'executionPrompt', warnings);
    let executionPrompt = instructions?.trim() ?? '';
    if (executionPrompt === '')
        executionPrompt = inlinePrompt ?? '';
    if (executionPrompt === '') {
        warnings.push({ source, field: 'executionPrompt', message: 'no instructions were supplied; the preset falls back to its role or name' });
        executionPrompt = role !== '' ? role : name;
    }
    const avatar = catalogAvatar(raw, source, warnings);
    const id = typeof raw['id'] === 'string' && raw['id'].trim() !== '' ? raw['id'].trim() : undefined;
    return {
        input: {
            ...id === undefined ? {} : { id },
            name, role,
            ...provider === undefined ? {} : { provider },
            ...model === undefined ? {} : { model },
            ...reasoningEffort === undefined ? {} : { reasoningEffort },
            executionPrompt,
            skillIds: catalogSkillIds(raw, source, warnings),
            ...toolPolicy === undefined ? {} : { toolPolicy },
            ...avatar === undefined ? {} : { avatar },
        },
    };
}
async function catalogSkillDirectory(directory) {
    try {
        const dirents = await readdir(join(directory, CATALOG_SKILL_DIRECTORY), { withFileTypes: true });
        return dirents.filter(dirent => !dirent.name.startsWith('.') && dirent.isDirectory()).map(dirent => dirent.name).sort();
    }
    catch (error) {
        if (isMissingFile(error))
            return [];
        throw error;
    }
}
async function readCatalogDirectory(root, warnings, skipped) {
    const entries = [];
    const dirents = (await readdir(root, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const dirent of dirents) {
        if (dirent.name.startsWith('.'))
            continue;
        if (dirent.isSymbolicLink()) {
            skipped.push({ source: dirent.name, reason: 'symbolic links are not imported' });
            continue;
        }
        if (!dirent.isDirectory())
            continue;
        const directory = join(root, dirent.name);
        let raw;
        try {
            raw = JSON.parse(await readFile(join(directory, AGENT_CATALOG_MANIFEST), 'utf8'));
        }
        catch (error) {
            skipped.push({ source: dirent.name, reason: isMissingFile(error) ? `${AGENT_CATALOG_MANIFEST} is missing` : `${AGENT_CATALOG_MANIFEST} is not valid JSON` });
            continue;
        }
        const manifest = asRecord(raw);
        if (manifest === undefined) {
            skipped.push({ source: dirent.name, reason: `${AGENT_CATALOG_MANIFEST} must be a JSON object` });
            continue;
        }
        const declaredPrompt = catalogString(manifest, ['instructionsFile', 'instructions_file', 'instructionsPath'], dirent.name, 'instructionsFile', warnings);
        const promptPath = declaredPrompt === undefined ? AGENT_CATALOG_INSTRUCTIONS : catalogRelativePath(declaredPrompt, 'instructionsFile');
        let instructions;
        try {
            instructions = await readFile(join(directory, promptPath), 'utf8');
        }
        catch (error) {
            if (!isMissingFile(error))
                throw error;
            warnings.push({
                source: dirent.name, field: 'instructions',
                message: declaredPrompt === undefined
                    ? `${AGENT_CATALOG_INSTRUCTIONS} is missing; the manifest prompt was used instead`
                    : `${declaredPrompt} is missing; the manifest prompt was used instead`,
            });
        }
        const parsed = catalogPresetInput(dirent.name, manifest, dirent.name, warnings, instructions);
        if ('reason' in parsed) {
            skipped.push({ source: dirent.name, reason: parsed.reason });
            continue;
        }
        if (parsed.input.skillIds.length === 0) {
            const skillIds = await catalogSkillDirectory(directory);
            if (skillIds.length > 0)
                parsed.input.skillIds = skillIds;
        }
        if (await pathExists(join(directory, 'avatars'))) {
            warnings.push({ source: dirent.name, field: 'avatars', message: 'avatar files are not imported; only builtin avatar references travel' });
        }
        entries.push({ source: dirent.name, input: parsed.input });
    }
    return entries;
}
async function readCatalogFile(file, warnings, skipped) {
    let parsed;
    try {
        parsed = JSON.parse(await readFile(file, 'utf8'));
    }
    catch (error) {
        if (isMissingFile(error))
            throw error;
        throw new Error(`agent catalog file is not valid JSON: ${file}`);
    }
    const entries = [];
    const record = asRecord(parsed);
    const collection = Array.isArray(parsed) ? parsed : Array.isArray(record?.['presets']) ? record['presets'] : undefined;
    const records = [];
    if (collection !== undefined) {
        collection.forEach((item, index) => {
            const entry = asRecord(item);
            if (entry === undefined) {
                skipped.push({ source: `${file}#${index}`, reason: 'entry must be a JSON object' });
                return;
            }
            records.push({ source: `${file}#${index}`, raw: entry });
        });
    }
    else if (record !== undefined) {
        records.push({ source: file, raw: record });
    }
    else {
        throw new Error('agent catalog file must contain one preset, an array of presets, or { schemaVersion, presets }');
    }
    for (const item of records) {
        const result = catalogPresetInput(item.source, item.raw, '', warnings);
        if ('reason' in result) {
            skipped.push({ source: item.source, reason: result.reason });
            continue;
        }
        entries.push({ source: item.source, input: result.input });
    }
    return entries;
}
/** Whether importing `input` over `preset` would change anything. */
function samePresetContent(preset, input) {
    return preset.name === input.name.trim()
        && preset.role === input.role.trim()
        && preset.provider === input.provider
        && preset.model === input.model
        && preset.reasoningEffort === input.reasoningEffort
        && preset.executionPrompt === input.executionPrompt
        && preset.toolPolicy === input.toolPolicy
        && preset.skillIds.length === input.skillIds.length
        && preset.skillIds.every((id, index) => id === input.skillIds[index])
        && JSON.stringify(preset.avatar ?? null) === JSON.stringify(input.avatar ?? null);
}
/**
 * Import a catalog directory (`agents/<name>/plugin.json` + `instructions.md`)
 * or one JSON file. Nothing in the catalog is executed; every entry is
 * validated field by field, and a broken entry is skipped with a reason while
 * the rest still import. Same-name presets are reported as conflicts unless
 * `overwrite` is true, and an identical overwrite leaves the revision alone.
 */
export async function importAgentCatalog(stateRoot, source, options = {}) {
    const target = resolve(source);
    const info = await stat(target).catch(() => undefined);
    if (info === undefined)
        throw new Error(`agent catalog source not found: ${source}`);
    const warnings = [], skipped = [];
    const entries = info.isDirectory()
        ? await readCatalogDirectory(target, warnings, skipped)
        : await readCatalogFile(target, warnings, skipped);
    const library = await loadAgentLibrary(stateRoot);
    const byName = new Map(library.presets.map(preset => [preset.name.trim().toLowerCase(), preset]));
    const imported = [], unchanged = [], conflicts = [];
    for (const entry of entries) {
        const problem = options.validate?.(entry.input);
        if (problem !== undefined) {
            skipped.push({ source: entry.source, reason: problem });
            continue;
        }
        const existing = byName.get(entry.input.name.trim().toLowerCase());
        if (existing !== undefined && options.overwrite !== true) {
            conflicts.push({ name: existing.name, existingId: existing.id, existingRevision: existing.revision });
            continue;
        }
        if (existing !== undefined && samePresetContent(existing, entry.input)) {
            unchanged.push(existing.name);
            continue;
        }
        try {
            const preset = await saveAgentPreset(stateRoot, { ...entry.input, ...existing === undefined ? {} : { id: existing.id } });
            imported.push({ name: preset.name, id: preset.id, revision: preset.revision });
        }
        catch (error) {
            skipped.push({ source: entry.source, reason: error instanceof Error ? error.message : String(error) });
        }
    }
    return { imported, unchanged, conflicts, skipped, warnings };
}
function catalogDirectoryName(name, id) {
    const slug = name.trim().toLowerCase()
        .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
        .replace(/\.{2,}/g, '-')
        .replace(/^[.\s]+/, '')
        .replace(/\s+/g, '-');
    if (slug !== '')
        return slug;
    const fallback = id.replace(/[^a-z0-9-]+/gi, '').slice(0, 8);
    return fallback === '' ? 'agent' : `agent-${fallback}`;
}
async function pathExists(path) {
    return (await stat(path).catch(() => undefined)) !== undefined;
}
/**
 * Export presets into `agents/<name>/{plugin.json,instructions.md}` so the same
 * tree imports back without loss. Existing entries are never replaced unless
 * `overwrite` is true.
 */
export async function exportAgentCatalog(stateRoot, target, options = {}) {
    const presets = [...(options.presets ?? (await loadAgentLibrary(stateRoot)).presets)].sort((left, right) => left.name.localeCompare(right.name));
    const root = resolve(target);
    await mkdir(root, { recursive: true });
    const exported = [], warnings = [];
    const used = new Set();
    for (const preset of presets) {
        const base = catalogDirectoryName(preset.name, preset.id);
        let directoryName = base, suffix = 2;
        while (used.has(directoryName))
            directoryName = `${base}-${suffix++}`;
        used.add(directoryName);
        const directory = join(root, directoryName);
        if (options.overwrite !== true && await pathExists(directory))
            throw new Error(`catalog entry "${directoryName}" already exists; pass overwrite: true`);
        await mkdir(directory, { recursive: true });
        const manifest = {
            schemaVersion: 1,
            id: preset.id,
            revision: preset.revision,
            name: preset.name,
            role: preset.role,
            ...preset.provider === undefined ? {} : { provider: preset.provider },
            ...preset.model === undefined ? {} : { model: preset.model },
            ...preset.reasoningEffort === undefined ? {} : { reasoningEffort: preset.reasoningEffort },
            ...preset.toolPolicy === undefined ? {} : { toolPolicy: preset.toolPolicy },
            skills: [...preset.skillIds],
            ...preset.avatar === undefined ? {} : { avatar: preset.avatar },
        };
        await writeFile(join(directory, AGENT_CATALOG_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        await writeFile(join(directory, AGENT_CATALOG_INSTRUCTIONS), `${preset.executionPrompt}\n`, 'utf8');
        exported.push({ name: preset.name, directory: directoryName });
    }
    return { exported, warnings };
}
/** Resolve one preset by exact name, case-insensitively; the summon gesture's only layer. */
export function resolvePresetByName(presets, name) {
    const wanted = name.trim().toLowerCase();
    if (wanted === '')
        return undefined;
    return presets.find(preset => preset.name.trim().toLowerCase() === wanted);
}
/** Load the library and resolve one preset by name. */
export async function resolveAgentPresetByName(stateRoot, name) {
    return resolvePresetByName((await loadAgentLibrary(stateRoot)).presets, name);
}
