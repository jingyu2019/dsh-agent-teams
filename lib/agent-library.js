/** Versioned, plugin-owned global agent preset library. No live sessions. */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
