import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'

/**
 * Atomic file writes via temp-file + rename.
 *
 * The Stop hook is `async:true` and the 90s ANALYSIS_DEBOUNCE_MS only guards
 * once before the LLM spawn, so two Stop fires (separate processes) can overlap
 * and interleave writes to the same JSON file. `fs.writeFileSync` truncates the
 * target then streams bytes, so a concurrent reader can observe a half-written
 * file and `readJsonFile` silently parses it as null. Writing to a unique temp
 * sibling and `rename`-ing it over the target makes every publish atomic: a
 * reader always sees the complete previous or the complete new file, never a
 * torn one.
 *
 * The temp lives in the SAME directory as the target so it shares a filesystem,
 * which is what makes `rename(2)` atomic on Linux. Durability (fsync) is not a
 * goal here — only atomicity. This is POSIX-correct, not portable-atomic.
 */

/**
 * Owner-only modes for the tom store. It holds redacted-but-sensitive
 * interaction data — the same data class as Claude Code's own transcript
 * store (700 dirs / 600 files). Modes are applied at creation time only:
 * mkdir and open honor them for new paths, and the atomic rename publishes
 * the temp's 0o600 onto a replaced target. A umask can only clear bits, so
 * owner-only modes survive any umask. Exported so setup's one-time
 * hardening pass uses the same values.
 */
export const TOM_DIR_MODE = 0o700
export const TOM_FILE_MODE = 0o600

let tempCounter = 0

/**
 * A collision-free temp sibling path for `filePath`, in the same directory so
 * `rename(2)` stays atomic. pid disambiguates live concurrent processes, the
 * counter disambiguates writes within one process, and the random suffix
 * removes any doubt about pid reuse across process lifetimes. Exported so the
 * memory-file writer (promotion.ts) shares the same unique-temp scheme instead
 * of a stable name that concurrent writers would race on.
 */
export function tempPathFor(filePath: string): string {
  const suffix = `${process.pid}.${tempCounter++}.${crypto.randomBytes(4).toString('hex')}`
  return `${filePath}.${suffix}.tmp`
}

function ensureDirectoryExists(filePath: string): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: TOM_DIR_MODE })
  }
}

/**
 * Synchronously write `data` to `filePath` atomically. On any failure the temp
 * file is removed so partial writes never leak onto disk.
 */
export function atomicWriteFileSync(
  filePath: string,
  data: string
): void {
  ensureDirectoryExists(filePath)
  const tempPath = tempPathFor(filePath)
  try {
    fs.writeFileSync(tempPath, data, { encoding: 'utf-8', mode: TOM_FILE_MODE })
    fs.renameSync(tempPath, filePath)
  } catch (error) {
    try {
      fs.unlinkSync(tempPath)
    } catch {
      // Temp may not exist if writeFileSync itself failed — ignore.
    }
    throw error
  }
}

/**
 * Asynchronously write `data` to `filePath` atomically. Mirrors the callback
 * shape of `fs.writeFile` so non-blocking callers keep their error-on-stderr
 * surface. The temp file is removed on failure.
 */
export function atomicWriteFile(
  filePath: string,
  data: string,
  onError: (err: NodeJS.ErrnoException) => void
): void {
  let tempPath: string
  try {
    // Directory creation is synchronous; route its failure through onError so
    // a fire-and-forget caller never sees an uncaught throw.
    ensureDirectoryExists(filePath)
    tempPath = tempPathFor(filePath)
  } catch (err) {
    onError(err as NodeJS.ErrnoException)
    return
  }
  fs.writeFile(tempPath, data, { encoding: 'utf-8', mode: TOM_FILE_MODE }, (writeErr) => {
    if (writeErr) {
      onError(writeErr)
      return
    }
    fs.rename(tempPath, filePath, (renameErr) => {
      if (renameErr) {
        fs.unlink(tempPath, () => onError(renameErr))
      }
    })
  })
}
