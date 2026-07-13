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
 * - interactionStyle → the global user memory file
 *   (~/.claude/CLAUDE.md), created only if its parent dir exists, with the
 *   creation logged (no silent resource creation).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import type { PreferenceCluster, UserModel } from './schemas.js'
import type { DerivabilityGate } from './promotion-gate.js'
import { isLegacyGenericKey } from './preferences.js'
import { sanitizeForInjection } from './render-guard.js'
import { logUsage } from './routing.js'
import { sanitizeValue } from './secrets.js'

// --- Markers ---

export const PROMOTION_BEGIN_MARKER =
  '<!-- tom-swe:begin (managed by tom-swe; edits inside will be overwritten) -->'
export const PROMOTION_END_MARKER = '<!-- tom-swe:end -->'

// --- Budget ---

/**
 * Per-target cap on promoted preference lines. CLAUDE.md is a ~200-line
 * file by discipline; a tool-managed guest block claims a small fixed
 * slice, ranked, with overflow dropped — never whatever crossed a
 * threshold.
 */
export const MAX_BLOCK_PREFERENCES = 10

/**
 * Line budget of the host file (excluding our own block). A file already
 * over budget receives no NEW promotions — the tool must not contribute
 * to the bloat it exists to prevent.
 */
export const FILE_LINE_BUDGET = 200

// --- Configuration Shape ---

export interface PromotionConfig {
  readonly enabled: boolean
  readonly threshold: number
  readonly minSessions: number
  /**
   * Hysteresis floor: an already-promoted preference stays promoted until
   * its confidence falls below this (not the entry threshold). Promotion
   * is documented as durable; without the gap, boundary churn at the
   * entry threshold flapped blocks in and out of CLAUDE.md within hours.
   */
  readonly retireThreshold: number
}

/**
 * How long a derivability-gate rejection stays authoritative for an
 * unchanged value before the candidate may be re-judged.
 */
const GATE_REJECTION_TTL_DAYS = 30
const MS_PER_DAY = 24 * 60 * 60 * 1000

function hasFreshGateRejection(pref: PreferenceCluster): boolean {
  if (pref.gateRejectedValue !== pref.value || pref.gateRejectedAt === undefined) {
    return false
  }
  const ageMs = Date.now() - Date.parse(pref.gateRejectedAt)
  return Number.isFinite(ageMs) && ageMs < GATE_REJECTION_TTL_DAYS * MS_PER_DAY
}

// --- Selection ---

/**
 * Categories eligible for promotion — the two that carry standing guidance for
 * agents. Every tracked category is promotable today; the set stays explicit so
 * a future non-promotable category (e.g. transient runtime state) is opt-in.
 */
const PROMOTABLE_CATEGORIES: ReadonlySet<string> = new Set([
  'codingPreferences',
  'interactionStyle',
])

/**
 * Selects preferences stable enough to promote: an eligible category,
 * confidence >= threshold, AND sessionCount >= minSessions.
 * Already-promoted preferences get hysteresis instead of the entry gate:
 * they remain selected until confidence falls below retireThreshold, so
 * the "durable memory" contract survives boundary churn while explicit
 * corrections (which halve confidence) still retire them promptly.
 * The result is priority-ordered: correction-derived first (non-obvious
 * by construction), then confidence × sessions.
 */
export function selectPromotable(
  userModel: UserModel,
  config: PromotionConfig
): PreferenceCluster[] {
  return userModel.preferencesClusters
    .filter(
      (p) =>
        PROMOTABLE_CATEGORIES.has(p.category) &&
        // Legacy generic keys ('preference'/'pattern') are collapsed noise —
        // never promote them into a CLAUDE.md marker block.
        !isLegacyGenericKey(p.key) &&
        (p.promoted === true
          ? p.confidence >= config.retireThreshold
          : p.confidence >= config.threshold &&
            p.sessionCount >= config.minSessions)
    )
    .sort((a, b) => {
      const aCorrection = a.learnedVia === 'correction' ? 1 : 0
      const bCorrection = b.learnedVia === 'correction' ? 1 : 0
      if (aCorrection !== bCorrection) {
        return bCorrection - aCorrection
      }
      const score = b.confidence * b.sessionCount - a.confidence * a.sessionCount
      if (score !== 0) {
        return score
      }
      return prefIdentity(a).localeCompare(prefIdentity(b))
    })
}

// --- Rendering ---

function renderPreferenceLine(pref: PreferenceCluster): string {
  // Render-boundary sanitization: these strings are LLM-extracted from
  // attacker-influenceable session content and land in persistent
  // instruction space — flatten newlines, neutralize marker sequences,
  // cap length (see render-guard.ts).
  const key = sanitizeForInjection(pref.key)
  const value = sanitizeForInjection(pref.value)
  const category = sanitizeForInjection(pref.category)
  const sessions = pref.sessionCount === 1 ? '1 session' : `${pref.sessionCount} sessions`
  if (pref.learnedVia === 'correction') {
    // The negative surface is the valuable half: what the agent got wrong.
    return pref.correctedFrom !== undefined
      ? `- Avoid ${sanitizeForInjection(pref.correctedFrom)} for ${key}; use ${value} instead (user corrected this; ${sessions})`
      : `- ${key}: ${value} (learned via user correction; ${sessions})`
  }
  return `- Prefers ${value} (${category}/${key}; observed across ${sessions})`
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
 * Atomically replaces a memory file's content, preserving its existing
 * mode (CLAUDE.md is a user-facing file — never chmod it to the tom
 * store's 0600). The temp name is stable and hidden, so a crashed write
 * leaves at most one dotfile that the next successful write reclaims.
 */
function atomicWriteMemoryFile(filePath: string, data: string): void {
  let mode = 0o644
  try {
    mode = fs.statSync(filePath).mode & 0o777
  } catch {
    // New file: default user-facing mode.
  }
  const tempPath = path.join(
    path.dirname(filePath),
    `.tom-swe.${path.basename(filePath)}.tmp`
  )
  fs.writeFileSync(tempPath, data, { encoding: 'utf-8', mode })
  fs.renameSync(tempPath, filePath)
}

/**
 * Regenerates the marker-bounded section of an EXISTING file wholesale:
 * replaces the block when markers are present, appends (with a separating
 * newline) when absent. All other file content is left untouched.
 *
 * Idempotent: returns false without writing when the regenerated content
 * is byte-identical (the common case — the block was rewritten 452 times
 * in 24 days with no change, each a truncate-then-stream on a file every
 * session start reads).
 *
 * Throws when the file does not exist — creation policy (and its logging)
 * belongs to the caller, never to this projection step.
 */
export function writePromotionBlock(filePath: string, block: string): boolean {
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

  if (updated === content) {
    return false
  }
  atomicWriteMemoryFile(filePath, updated)
  return true
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

const PROJECT_CATEGORIES: ReadonlySet<string> = new Set(['codingPreferences'])

function isProjectScoped(pref: PreferenceCluster): boolean {
  return PROJECT_CATEGORIES.has(pref.category)
}

// --- Promotion Pipeline ---

export interface PromotionResult {
  /** User model with promoted flags set/cleared (the store stays canonical). */
  readonly model: UserModel
  /** Preferences projected into a memory file's block in this run. */
  readonly promoted: readonly PreferenceCluster[]
  /**
   * Memory files whose content actually CHANGED this run (block written or
   * removed). Idempotent regenerations don't appear — telemetry keys on
   * this, so a stable block no longer logs a promotion event per Stop.
   */
  readonly targets: readonly string[]
  /** Files created as a side effect (already logged, never silent). */
  readonly createdFiles: readonly string[]
}

function prefIdentity(pref: PreferenceCluster): string {
  return `${pref.category}::${pref.key}::${pref.value}`
}

/**
 * Identity string for the durable usage.log, with the key and value passed
 * through secret detection first. Distinct from prefIdentity, which is the
 * in-memory join key for gate verdicts and MUST keep the real value — only the
 * logged emission is redacted (see prefKeyForTelemetry in routing.ts for why
 * sanitization lives at the emission site, not the coining site).
 */
function redactedPrefIdentity(pref: PreferenceCluster): string {
  return `${pref.category}::${sanitizeValue(pref.key)}::${sanitizeValue(pref.value)}`
}

/**
 * Regenerates one target's marker block from the promotable set.
 * An empty set removes the block (retirement to zero); the block is always
 * a wholesale projection of the current store, never an edit. Returns
 * whether the file's content actually changed.
 */
function projectBlockOntoFile(
  filePath: string,
  prefs: readonly PreferenceCluster[]
): boolean {
  if (prefs.length === 0) {
    return removePromotionBlock(filePath)
  }
  return writePromotionBlock(filePath, renderPromotionBlock(prefs))
}

/**
 * Counts the lines a host file would have WITHOUT our managed block —
 * the budget the surrounding content already consumes.
 */
function countHostLines(filePath: string): number {
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf-8')
  } catch {
    return 0
  }
  const beginIdx = content.indexOf(PROMOTION_BEGIN_MARKER)
  if (beginIdx >= 0) {
    const endIdx = content.indexOf(PROMOTION_END_MARKER, beginIdx)
    const afterEnd = endIdx >= 0 ? endIdx + PROMOTION_END_MARKER.length : content.length
    content = content.slice(0, beginIdx) + content.slice(afterEnd)
  }
  return content.split('\n').filter((l) => l.trim() !== '').length
}

function logSkipped(
  target: string,
  reason: string,
  skipped: readonly PreferenceCluster[]
): void {
  logUsage({
    timestamp: new Date().toISOString(),
    operation: 'promotion-skipped',
    model: 'none',
    tokenCount: 0,
    reason,
    detail: { target, reason, skipped: skipped.map(redactedPrefIdentity) },
  })
}

interface GatedCandidates {
  readonly eligible: PreferenceCluster[]
  /**
   * Candidates the gate actively judged derivable THIS run. Rejections
   * from an unavailable gate are excluded — unavailability is not a
   * verdict, and persisting it would wrongly cache a non-judgment.
   */
  readonly newlyRejected: readonly PreferenceCluster[]
}

/**
 * Applies the per-target gates to a priority-ordered candidate list:
 * 1. Derivability (project targets only, via the model gate): new
 *    observation-derived candidates must state something the repo doesn't;
 *    correction-derived and already-promoted entries bypass, as do
 *    candidates whose unchanged value carries a fresh persisted rejection
 *    (one candidate used to be re-judged 64 times — each an LLM spawn).
 *    Gate unavailable (null) → conservative: only corrections pass.
 * 2. Host-file line budget: a file already over ~200 lines accepts no NEW
 *    entries (existing ones keep regenerating so retirement still works).
 * 3. Block cap: at most MAX_BLOCK_PREFERENCES lines, priority-ordered.
 * Every drop is logged — silent truncation reads as coverage. (A fresh
 * persisted rejection was logged when it happened; re-logging it every
 * Stop is the noise this cache removes.)
 */
function applyTargetGates(
  prefs: readonly PreferenceCluster[],
  target: string,
  gate: DerivabilityGate | null,
  applyDerivability: boolean
): GatedCandidates {
  let eligible = [...prefs]
  let newlyRejected: readonly PreferenceCluster[] = []

  if (applyDerivability) {
    eligible = eligible.filter(
      (p) => p.promoted === true || p.learnedVia === 'correction' || !hasFreshGateRejection(p)
    )
    const needsJudgment = eligible.filter(
      (p) => p.promoted !== true && p.learnedVia !== 'correction'
    )
    if (needsJudgment.length > 0) {
      const verdict =
        gate === null
          ? null
          : gate(
              needsJudgment.map((p) => ({
                id: prefIdentity(p),
                statement: renderPreferenceLine(p),
              }))
            )
      const passed =
        verdict ?? new Set<string>() // unavailable → conservative: none pass
      const rejected = needsJudgment.filter((p) => !passed.has(prefIdentity(p)))
      if (rejected.length > 0) {
        logSkipped(
          target,
          verdict === null ? 'derivability-gate-unavailable' : 'statically-derivable',
          rejected
        )
      }
      newlyRejected = verdict !== null ? rejected : []
      const rejectedIds = new Set(rejected.map(prefIdentity))
      eligible = eligible.filter((p) => !rejectedIds.has(prefIdentity(p)))
    }
  }

  if (countHostLines(target) > FILE_LINE_BUDGET) {
    const newOnes = eligible.filter((p) => p.promoted !== true)
    if (newOnes.length > 0) {
      logSkipped(target, 'file-line-budget', newOnes)
    }
    eligible = eligible.filter((p) => p.promoted === true)
  }

  if (eligible.length > MAX_BLOCK_PREFERENCES) {
    logSkipped(target, 'block-cap', eligible.slice(MAX_BLOCK_PREFERENCES))
    eligible = eligible.slice(0, MAX_BLOCK_PREFERENCES)
  }

  return { eligible, newlyRejected }
}

/**
 * Runs the full promotion pass: select → gate → route → render → write,
 * then returns a new user model with `promoted: true` on preferences that
 * now live in a memory file and the flag cleared on ones that no longer do.
 *
 * @param gate - Derivability judge for project-scoped candidates; null
 *   means judgment unavailable, which conservatively limits new project
 *   promotions to correction-derived preferences.
 */
export function runPromotion(
  userModel: UserModel,
  config: PromotionConfig,
  cwd: string,
  gate: DerivabilityGate | null = null
): PromotionResult {
  if (!config.enabled) {
    return { model: userModel, promoted: [], targets: [], createdFiles: [] }
  }

  const promotable = selectPromotable(userModel, config)
  const projectCandidates = promotable.filter(isProjectScoped)
  const globalCandidates = promotable.filter((p) => !isProjectScoped(p))

  const targets: string[] = []
  const createdFiles: string[] = []
  const written: PreferenceCluster[] = []
  const newlyRejected: PreferenceCluster[] = []

  // Project scope: only project onto a CLAUDE.md that already exists.
  const projectFile = findProjectMemoryFile(cwd)
  if (projectFile !== null) {
    const gated = applyTargetGates(projectCandidates, projectFile, gate, true)
    if (projectBlockOntoFile(projectFile, gated.eligible)) {
      targets.push(projectFile)
    }
    written.push(...gated.eligible)
    newlyRejected.push(...gated.newlyRejected)
  }

  // Global scope: create ~/.claude/CLAUDE.md only when ~/.claude exists,
  // and log the creation. No derivability gate here — interaction style is
  // never written down in a repository.
  const globalFile = globalMemoryFilePath()
  const globalPrefs = applyTargetGates(globalCandidates, globalFile, gate, false).eligible
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
      detail: { path: globalFile },
    })
    globalFileAvailable = true
  }
  if (globalFileAvailable) {
    if (projectBlockOntoFile(globalFile, globalPrefs)) {
      targets.push(globalFile)
    }
    written.push(...globalPrefs)
  }

  // Flag lifecycle is scope-local: a Stop from a cwd WITHOUT a CLAUDE.md
  // never projected the project scope, so project-scoped promoted flags
  // must survive — their lines still live in the owning repo's file.
  // Clearing them from here caused double injection and re-gating (and an
  // extra LLM spawn) back in the owning repo.
  const projectProjected = projectFile !== null
  const globalProjected = globalFileAvailable
  const nowIso = new Date().toISOString()
  const writtenIds = new Set(written.map(prefIdentity))
  const rejectedIds = new Set(newlyRejected.map(prefIdentity))
  const updatedClusters = userModel.preferencesClusters.map((p) => {
    // Persist active gate verdicts so unchanged values skip re-judgment.
    const cluster = rejectedIds.has(prefIdentity(p))
      ? { ...p, gateRejectedValue: p.value, gateRejectedAt: nowIso }
      : p
    if (writtenIds.has(prefIdentity(cluster))) {
      return { ...cluster, promoted: true }
    }
    const scopeProjected = isProjectScoped(cluster) ? projectProjected : globalProjected
    if (cluster.promoted === true && scopeProjected) {
      const { promoted: _retired, ...rest } = cluster
      return rest
    }
    return cluster
  })

  return {
    model: { ...userModel, preferencesClusters: updatedClusters },
    promoted: written,
    targets,
    createdFiles,
  }
}
