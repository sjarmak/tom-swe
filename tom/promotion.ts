/**
 * Marker-block cleanup for the retired CLAUDE.md promotion feature.
 *
 * tom-swe used to "promote" stable high-confidence preferences into durable
 * marker blocks inside CLAUDE.md files. That write-path has been retired in
 * favour of surfacing preferences directly through the SessionStart hook; this
 * module retains only the primitives needed to strip any block a prior version
 * wrote:
 * - the block markers,
 * - removePromotionBlock (idempotent marker-bounded removal),
 * - the target-path helpers (globalMemoryFilePath / findProjectMemoryFile), and
 * - cleanupPromotionArtifacts (the one-time upgrade sweep, run on every Stop).
 *
 * removePromotionBlock is also used by /tom-reset so managed content never
 * outlives the store.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import { tempPathFor } from './fs-atomic.js'

// --- Markers ---

export const PROMOTION_BEGIN_MARKER =
  '<!-- tom-swe:begin (managed by tom-swe; edits inside will be overwritten) -->'
export const PROMOTION_END_MARKER = '<!-- tom-swe:end -->'

// --- Marker-Bounded Writing ---

/**
 * Atomically replaces a memory file's content, preserving its existing
 * mode (CLAUDE.md is a user-facing file — never chmod it to the tom
 * store's 0600). Writes to a per-process-unique temp sibling (pid + counter
 * + random, via fs-atomic's tempPathFor) so concurrent Stop-hook writes from
 * separate processes never collide on one temp path — on this rig several
 * accounts share $HOME, so the global memory file is a shared target. Unique
 * names forfeit the stable-name self-reclaim, so a failed write unlinks its
 * own temp rather than leaking it.
 */
function atomicWriteMemoryFile(filePath: string, data: string): void {
  let mode = 0o644
  try {
    mode = fs.statSync(filePath).mode & 0o777
  } catch {
    // New file: default user-facing mode.
  }
  const tempPath = tempPathFor(filePath)
  try {
    fs.writeFileSync(tempPath, data, { encoding: 'utf-8', mode })
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
 * Removes the marker-bounded block from a file, if both file and block
 * exist. Returns true when a block was removed. Used by the upgrade cleanup
 * sweep and by /tom-reset (managed content must not outlive the store).
 */
export function removePromotionBlock(filePath: string): boolean {
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf-8')
  } catch {
    return false
  }

  const beginIdx = content.indexOf(PROMOTION_BEGIN_MARKER)
  if (beginIdx < 0) {
    return false
  }

  const endIdx = content.indexOf(PROMOTION_END_MARKER, beginIdx)
  let afterEnd = endIdx >= 0 ? endIdx + PROMOTION_END_MARKER.length : content.length
  // Also consume the newline that trailed the block so removal doesn't
  // leave a stray blank line behind.
  if (content[afterEnd] === '\n') {
    afterEnd += 1
  }

  // Also consume the separator newline the retired writer prepended when
  // appending a block, so removal restores the file instead of leaving one
  // blank line behind.
  let beforeBegin = beginIdx
  if (content.slice(Math.max(0, beforeBegin - 2), beforeBegin) === '\n\n') {
    beforeBegin -= 1
  }

  atomicWriteMemoryFile(filePath, content.slice(0, beforeBegin) + content.slice(afterEnd))
  return true
}

// --- Target Routing ---

/** The global user memory file Claude Code auto-loads: ~/.claude/CLAUDE.md */
export function globalMemoryFilePath(): string {
  return path.join(os.homedir(), '.claude', 'CLAUDE.md')
}

/**
 * Returns the project memory file Claude Code auto-loads for the given cwd
 * (cwd/CLAUDE.md, then cwd/.claude/CLAUDE.md), or null when neither exists.
 * Mirrors the codebase convention that the project root is the hook's cwd.
 */
export function findProjectMemoryFile(cwd: string): string | null {
  const rootCandidate = path.join(cwd, 'CLAUDE.md')
  if (fs.existsSync(rootCandidate)) {
    return rootCandidate
  }
  const dotClaudeCandidate = path.join(cwd, '.claude', 'CLAUDE.md')
  if (fs.existsSync(dotClaudeCandidate)) {
    return dotClaudeCandidate
  }
  return null
}

export interface PromotionCleanupResult {
  /** Files whose content actually changed (a block was removed). */
  readonly removed: readonly string[]
  /** Per-target failures — a target that could not be rewritten. */
  readonly errors: readonly { readonly file: string; readonly reason: string }[]
}

/**
 * One-time upgrade cleanup: strips the tom-swe marker block from every file a
 * prior promotion pass could have written it into — the global user memory
 * file (~/.claude/CLAUDE.md) and the project memory files (cwd/CLAUDE.md,
 * cwd/.claude/CLAUDE.md) — plus cwd/CLAUDE.local.md, which promotion never
 * targeted but is cleaned defensively. removePromotionBlock is idempotent and
 * safe on missing files and touches only marker-bounded content, so this runs
 * harmlessly on every Stop: it self-heals an upgraded install on the first
 * fire that still finds a block, then no-ops.
 *
 * Each target is attempted independently: a target that cannot be rewritten
 * (e.g. an atomic-write failure on the shared global file) is recorded in
 * `errors` but must not starve the remaining targets — otherwise a persistent
 * failure on an early target would block project-file cleanup on every Stop.
 * The caller owns telemetry (it holds the session id).
 */
export function cleanupPromotionArtifacts(cwd: string): PromotionCleanupResult {
  // De-duplicated because HOME and cwd can resolve to the same tree (the
  // global file then equals cwd/.claude/CLAUDE.md); listing a path twice would
  // otherwise report it twice.
  const targets = [
    ...new Set([
      globalMemoryFilePath(),
      path.join(cwd, 'CLAUDE.md'),
      path.join(cwd, '.claude', 'CLAUDE.md'),
      path.join(cwd, 'CLAUDE.local.md'),
    ]),
  ]
  const removed: string[] = []
  const errors: { file: string; reason: string }[] = []
  for (const filePath of targets) {
    try {
      if (removePromotionBlock(filePath)) {
        removed.push(filePath)
      }
    } catch (error) {
      errors.push({
        file: filePath,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { removed, errors }
}
