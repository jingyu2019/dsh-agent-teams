/** Versioned, plugin-owned global agent preset library. No live sessions. */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AgentPresetV1 } from './types.ts'

export const AGENT_LIBRARY_FILE = 'agent-library/presets.json'
export const AGENT_LIBRARY_MAX_PRESETS = 100

interface AgentLibraryV1 {
  schemaVersion: 1
  presets: AgentPresetV1[]
}

const emptyLibrary = (): AgentLibraryV1 => ({ schemaVersion: 1, presets: [] })

function libraryPath(stateRoot: string): string {
  return join(stateRoot, AGENT_LIBRARY_FILE)
}

function isPreset(value: unknown): value is AgentPresetV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const preset = value as Record<string, unknown>
  return preset['schemaVersion'] === 1
    && typeof preset['id'] === 'string' && preset['id'] !== ''
    && Number.isSafeInteger(preset['revision']) && (preset['revision'] as number) >= 1
    && typeof preset['name'] === 'string' && preset['name'].trim() !== ''
    && typeof preset['role'] === 'string'
    && typeof preset['executionPrompt'] === 'string'
    && Array.isArray(preset['skillIds']) && preset['skillIds'].every(item => typeof item === 'string')
    && Number.isFinite(preset['createdAt']) && Number.isFinite(preset['updatedAt'])
}

export async function loadAgentLibrary(stateRoot: string): Promise<AgentLibraryV1> {
  try {
    const raw: unknown = JSON.parse(await readFile(libraryPath(stateRoot), 'utf8'))
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('agent library must be an object')
    const object = raw as Record<string, unknown>
    if (object['schemaVersion'] !== 1 || !Array.isArray(object['presets']) || !object['presets'].every(isPreset)) {
      throw new Error('agent library has an unsupported or invalid shape')
    }
    if ((object['presets'] as unknown[]).length > AGENT_LIBRARY_MAX_PRESETS) throw new Error('agent library exceeds its preset cap')
    return { schemaVersion: 1, presets: object['presets'] as AgentPresetV1[] }
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return emptyLibrary()
    throw error
  }
}

async function saveAgentLibrary(stateRoot: string, library: AgentLibraryV1): Promise<void> {
  const file = libraryPath(stateRoot)
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(library, null, 2), 'utf8')
  await rename(temporary, file)
}

export interface AgentPresetInput {
  id?: string
  name: string
  role: string
  provider?: string
  model?: string
  reasoningEffort?: string
  executionPrompt: string
  skillIds: string[]
  toolPolicy?: string
  avatar?: AgentPresetV1['avatar']
}

/** Create or update one revision; updates never mutate Teams that copied an older revision. */
export async function saveAgentPreset(stateRoot: string, input: AgentPresetInput): Promise<AgentPresetV1> {
  const library = await loadAgentLibrary(stateRoot)
  const now = Date.now()
  const id = input.id?.trim() || randomUUID()
  const existingIndex = library.presets.findIndex(preset => preset.id === id)
  if (existingIndex < 0 && library.presets.length >= AGENT_LIBRARY_MAX_PRESETS) {
    throw new Error(`agent library is at its ${AGENT_LIBRARY_MAX_PRESETS}-preset cap`)
  }
  if (library.presets.some((preset, index) => index !== existingIndex && preset.name.trim().toLowerCase() === input.name.trim().toLowerCase())) {
    throw new Error(`agent preset name "${input.name.trim()}" is already used`)
  }
  const existing = existingIndex < 0 ? undefined : library.presets[existingIndex]
  const preset: AgentPresetV1 = {
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
  }
  if (existingIndex < 0) library.presets.push(preset)
  else library.presets[existingIndex] = preset
  await saveAgentLibrary(stateRoot, library)
  return preset
}

export async function deleteAgentPreset(stateRoot: string, id: string): Promise<boolean> {
  const library = await loadAgentLibrary(stateRoot)
  const next = library.presets.filter(preset => preset.id !== id)
  if (next.length === library.presets.length) return false
  await saveAgentLibrary(stateRoot, { schemaVersion: 1, presets: next })
  return true
}
