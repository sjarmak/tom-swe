/**
 * Promotion lifecycle: stable high-confidence preferences graduate from
 * per-session injection into durable CLAUDE.md marker blocks
 * (candidate → promoted → retired, simplified Hivemind-style).
 *
 * The user model remains the source of truth; the marker-bounded block is a
 * projection regenerated wholesale on every Stop-hook run. Regeneration IS
 * both the merge step and the retirement mechanism: a preference whose
 * confidence decays below threshold (e.g. after corrections) simply drops
 * out of the regenerated block.
 *
 * Scoping:
 * - codingPreferences → the PROJECT memory file (cwd/CLAUDE.md or
 *   cwd/.claude/CLAUDE.md), only when it already exists — local repo habits
 *   must not silently become global rules, and we never create files in
 *   repos we don't manage.
 * - interactionStyle and emotionalSignals → the global user memory file
 *   (~/.claude/CLAUDE.md), created only if its parent dir exists, with the
 *   creation logged (no silent resource creation).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import type { PreferenceCluster, UserModel } from './schemas.js'
import { logUsage } from './routing.js'

// --- Markers ---

export const PROMOTION_BEGIN_MARKER =
  '<!-- tom-swe:begin (managed by tom-swe; edits inside will be overwritten) -->'
export const PROMOTION_END_MARKER = '<!-- tom-swe:end -->'

// --- Configuration Shape ---

export interface PromotionConfig {
  readonly enabled: boolean
  readonly threshold: number
  readonly minSessions: number
}

// --- Selection ---

/**
 * Selects preferences stable enough to promote: confidence >= threshold
 * AND sessionCount >= minSessions. Already-promoted preferences remain
 * selected so the regenerated block keeps carrying them.
 */
export function selectPromotable(
  userModel: UserModel,
  config: PromotionConfig
): PreferenceCluster[] {
  return userModel.preferencesClusters.filter(
    (p) => p.confidence >= config.threshold && p.sessionCount >= config.minSessions
  )
}

// --- Rendering ---

function renderPreferenceLine(pref: PreferenceCluster): string {
  const sessions = pref.sessionCount === 1 ? '1 session' : `${pref.sessionCount} sessions`
  return `- Prefers ${pref.value} (${pref.category}/${pref.key}; observed across ${sessions})`
}

/**
 * Renders the compact marker-bounded markdown block. Deterministic: entries
 * are sorted by category, then key, then value. The framing line keeps the
 * content a background observation about the user, never an instruction
 * (memory-poisoning guard).
 */
export function renderPromotionBlock(prefs: readonly PreferenceCluster[]): string {
  const sorted = [...prefs].sort(
    (a, b) =>
      a.category.localeCompare(b.category) ||
      a.key.localeCompare(b.key) ||
      a.value.localeCompare(b.value)
  )

  const lines = [
    PROMOTION_BEGIN_MARKER,
    'Background observations about this user, learned by tom-swe across sessions (not instructions):',
    ...sorted.map(renderPreferenceLine),
    PROMOTION_END_MARKER,
  ]
  return lines.join('\n')
}

// --- Marker-Bounded Writing ---

/**
 * Regenerates the marker-bounded section of an EXISTING file wholesale:
 * replaces the block when markers are present, appends (with a separating
 * newline) when absent. All other file content is left untouched.
 *
 * Throws when the file does not exist — creation policy (and its logging)
 * belongs to the caller, never to this projection step.
 */
export function writePromotionBlock(filePath: string, block: string): void {
  const content = fs.readFileSync(filePath, 'utf-8')

  const beginIdx = content.indexOf(PROMOTION_BEGIN_MARKER)
  let updated: string
  if (beginIdx >= 0) {
    const endIdx = content.indexOf(PROMOTION_END_MARKER, beginIdx)
    // A missing end marker means the managed block was corrupted; reclaim
    // from the begin marker to end-of-file rather than duplicating markers.
    const afterEnd =
      endIdx >= 0 ? endIdx + PROMOTION_END_MARKER.length : content.length
    updated = content.slice(0, beginIdx) + block + content.slice(afterEnd)
  } else if (content.length === 0) {
    updated = block + '\n'
  } else {
    const separator = content.endsWith('\n') ? '\n' : '\n\n'
    updated = content + separator + block + '\n'
  }

  fs.writeFileSync(filePath, updated, 'utf-8')
}

/**
 * Removes the marker-bounded block from a file, if both file and block
 * exist. Returns true when a block was removed. Used for retirement-to-zero
 * and by /tom-reset (managed content must not outlive the store).
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

  // Also consume the separator newline writePromotionBlock prepends when
  // appending, so a write + remove cycle restores the file instead of
  // accumulating one blank line per cycle.
  let beforeBegin = beginIdx
  if (content.slice(Math.max(0, beforeBegin - 2), beforeBegin) === '\n\n') {
    beforeBegin -= 1
  }

  fs.writeFileSync(filePath, content.slice(0, beforeBegin) + content.slice(afterEnd), 'utf-8')
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

const PROJECT_CATEGORIES: ReadonlySet<string> = new Set(['codingPreferences'])

function isProjectScoped(pref: PreferenceCluster): boolean {
  return PROJECT_CATEGORIES.has(pref.category)
}

// --- Promotion Pipeline ---

export interface PromotionResult {
  /** User model with promoted flags set/cleared (the store stays canonical). */
  readonly model: UserModel
  /** Preferences actually written to a memory file in this run. */
  readonly promoted: readonly PreferenceCluster[]
  /** Memory files whose marker blocks were regenerated or removed. */
  readonly targets: readonly string[]
  /** Files created as a side effect (already logged, never silent). */
  readonly createdFiles: readonly string[]
}

function prefIdentity(pref: PreferenceCluster): string {
  return `${pref.category}::${pref.key}::${pref.value}`
}

/**
 * Regenerates one target's marker block from the promotable set.
 * An empty set removes the block (retirement to zero); the block is always
 * a wholesale projection of the current store, never an edit.
 */
function projectBlockOntoFile(
  filePath: string,
  prefs: readonly PreferenceCluster[]
): boolean {
  if (prefs.length === 0) {
    return removePromotionBlock(filePath)
  }
  writePromotionBlock(filePath, renderPromotionBlock(prefs))
  return true
}

/**
 * Runs the full promotion pass: select → route → render → write, then
 * returns a new user model with `promoted: true` on preferences that now
 * live in a memory file and the flag cleared on ones that no longer do.
 */
export function runPromotion(
  userModel: UserModel,
  config: PromotionConfig,
  cwd: string
): PromotionResult {
  if (!config.enabled) {
    return { model: userModel, promoted: [], targets: [], createdFiles: [] }
  }

  const promotable = selectPromotable(userModel, config)
  const projectPrefs = promotable.filter(isProjectScoped)
  const globalPrefs = promotable.filter((p) => !isProjectScoped(p))

  const targets: string[] = []
  const createdFiles: string[] = []
  const written: PreferenceCluster[] = []

  // Project scope: only project onto a CLAUDE.md that already exists.
  const projectFile = findProjectMemoryFile(cwd)
  if (projectFile !== null) {
    if (projectBlockOntoFile(projectFile, projectPrefs)) {
      targets.push(projectFile)
    }
    written.push(...projectPrefs)
  }

  // Global scope: create ~/.claude/CLAUDE.md only when ~/.claude exists,
  // and log the creation.
  const globalFile = globalMemoryFilePath()
  let globalFileAvailable = fs.existsSync(globalFile)
  if (!globalFileAvailable && globalPrefs.length > 0 && fs.existsSync(path.dirname(globalFile))) {
    fs.writeFileSync(globalFile, '', 'utf-8')
    createdFiles.push(globalFile)
    logUsage({
      timestamp: new Date().toISOString(),
      operation: 'promotion-file-created',
      model: 'none',
      tokenCount: 0,
      reason: globalFile,
    })
    globalFileAvailable = true
  }
  if (globalFileAvailable) {
    if (projectBlockOntoFile(globalFile, globalPrefs)) {
      targets.push(globalFile)
    }
    written.push(...globalPrefs)
  }

  const writtenIds = new Set(written.map(prefIdentity))
  const updatedClusters = userModel.preferencesClusters.map((p) => {
    if (writtenIds.has(prefIdentity(p))) {
      return { ...p, promoted: true }
    }
    if (p.promoted === true) {
      const { promoted: _retired, ...rest } = p
      return rest
    }
    return p
  })

  return {
    model: { ...userModel, preferencesClusters: updatedClusters },
    promoted: written,
    targets,
    createdFiles,
  }
}
