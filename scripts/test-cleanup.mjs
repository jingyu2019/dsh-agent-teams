/**
 * Shared fixture cleanup for scheduler/inbox tests.
 *
 * Some tests kick a scheduler and then delete their temporary workspace. A
 * background write can publish just after the kick returns, so a single
 * recursive remove occasionally loses the race with ENOTEMPTY. Retrying is
 * bounded and only applies to transient filesystem races; every other error
 * still surfaces.
 */
import { rm } from 'node:fs/promises'

/** Error codes that mean "the tree changed while it was being removed". */
export const REMOVE_TEST_TREE_CODES = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE'])

/**
 * Remove a temporary fixture tree, retrying only transient filesystem races.
 *
 * Windows holds a directory handle briefly after the last writer closes it, so
 * a scheduler that publishes a final write just after a test returns can keep
 * re-creating entries for noticeably longer than the POSIX case. The delay
 * therefore grows linearly from `delayMs`. With the defaults (20 attempts of
 * 25ms..475ms) the total wait is about 4.7s: long enough for the Windows
 * handle-release tail, short enough that a genuine permission problem still
 * fails fast.
 *
 * @param {string} path - absolute fixture directory.
 * @param {{ attempts?: number, delayMs?: number, primitives?: { rm: typeof rm } }} [options]
 */
export async function removeTestTree(path, options = {}) {
  const attempts = options.attempts ?? 20
  const delayMs = options.delayMs ?? 25
  const remove = options.primitives?.rm ?? rm
  let lastError
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await remove(path, { recursive: true, force: true, maxRetries: 0 })
      return
    } catch (error) {
      lastError = error
      if (!REMOVE_TEST_TREE_CODES.has(error?.code)) throw error
      if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, delayMs + attempt * delayMs))
    }
  }
  throw lastError
}
