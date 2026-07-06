/**
 * Store pruning: count- and time-bounded Tier 1, time-expired Tier 2.
 *
 * Tier 1 session logs leave the store when EITHER bound is hit: the count cap
 * (keep at most maxSessionsRetained, evicting oldest last-activity first) or
 * the retention window (a log whose last activity predates the decay window,
 * so its redacted content does not outlive the window in which its evidence
 * matters). Last activity is file mtime, including the .jsonl capture sidecar.
 * An active-session guard protects BOTH removal paths so a long-running
 * session is never unlinked mid-use — even a small (misconfigured) retention
 * window cannot expire a log whose last activity is within the guard window.
 *
 * Tier 2 session models — and their user-model-history snapshots — are NOT
 * deleted with their logs: they are the evidence Tier 3 rebuilds fold, and
 * deleting them with the log collapsed the memory horizon to the Tier 1
 * window (~15h at observed volume) instead of the configured decay window
 * (174 of 180 models were evicted this way). They expire independently once
 * older than the decay window, keyed on the model's endedAt — the same
 * timestamp that grounds decay — so evidence leaves the store only when its
 * contribution has decayed out.
 *
 * BM25 index rebuilding is the caller's job (the Stop hook builds the index
 * once, after pruning); pruning itself only removes files.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  readSessionModel,
  globalTomDir,
  projectTomDir,
} from './memory-io'

// --- Types ---

export interface PruneResult {
  readonly prunedSessionIds: readonly string[]
  readonly expiredModelIds: readonly string[]
  readonly sessionsBeforePrune: number
  readonly sessionsAfterPrune: number
  readonly staleTempFilesRemoved: number
}

// A temp file from atomicWriteFileSync/atomicWriteFile is renamed onto its
// target within milliseconds. One that still exists an hour later was orphaned
// by a process killed between write and rename. The generous threshold also
// guarantees we never unlink a temp that a concurrent write is still using.
const STALE_TEMP_MS = 60 * 60 * 1000

// An in-flight analysis lock (session-models/<id>.lock) outlives its owner
// only when the owning process died mid-analysis; the LLM call is bounded at
// 90s, so a lock this old is certainly orphaned.
const STALE_LOCK_MS = 10 * 60 * 1000

// Never prune a session log whose last activity is this recent: a session
// can be open longer than the retention window spans at high volume, and
// unlinking a live log makes the next capture silently recreate an amputated
// stub (startedAt=now, no userMessages) that Stop then models.
const ACTIVE_SESSION_GUARD_MS = 2 * 60 * 60 * 1000

const MS_PER_DAY = 24 * 60 * 60 * 1000

// Directories under the tom dir where atomic writes place temp siblings: the
// root (user-model.json, bm25-index.json, config.json) plus the per-id dirs.
// Keep in sync with the atomicWrite* call sites that target the tom dir tree
// (the cwd export in tom-forget-export.ts is intentionally out of scope).
const TEMP_SWEEP_SUBDIRS = ['', 'sessions', 'session-models', 'user-model-history']

// --- Helpers ---

function safeReaddir(dirPath: string): readonly string[] {
  try {
    return fs.readdirSync(dirPath)
  } catch {
    return []
  }
}

function listJsonFiles(dirPath: string): readonly string[] {
  return safeReaddir(dirPath).filter(f => f.endsWith('.json'))
}

/**
 * Removes stale `*.tmp` files orphaned when a process was killed between the
 * temp write and the rename in tom/fs-atomic.ts, and stale `*.lock` in-flight
 * analysis locks orphaned when a Stop hook died mid-analysis. Both are
 * age-gated so an in-flight write's temp (or a live analysis's lock) is
 * never touched. Returns the count removed.
 */
function sweepStaleTempFiles(scope: 'global' | 'project'): number {
  const tomDir = scope === 'global' ? globalTomDir() : projectTomDir()
  const now = Date.now()
  let removed = 0

  for (const sub of TEMP_SWEEP_SUBDIRS) {
    const dir = sub ? path.join(tomDir, sub) : tomDir
    for (const name of safeReaddir(dir)) {
      const isTemp = name.endsWith('.tmp')
      const isLock = name.endsWith('.lock')
      if (!isTemp && !isLock) continue
      const maxAgeMs = isTemp ? STALE_TEMP_MS : STALE_LOCK_MS
      const filePath = path.join(dir, name)
      try {
        // lstat (not stat): inspect the directory entry itself, so a symlink
        // named *.tmp is skipped (isFile() is false) rather than followed.
        const stat = fs.lstatSync(filePath)
        if (!stat.isFile() || now - stat.mtimeMs < maxAgeMs) continue
        fs.unlinkSync(filePath)
        removed++
      } catch {
        // Raced with the owning rename (ENOENT) or a concurrent sweep — ignore.
      }
    }
  }

  return removed
}

interface SessionActivity {
  readonly sessionId: string
  readonly activityMs: number
}

/**
 * Last-activity time per Tier 1 session: the newer of the log's mtime and
 * its capture sidecar's mtime. mtime (not startedAt from the content) is the
 * activity signal — a long-lived session keeps writing while its startedAt
 * ages — and reading it avoids re-parsing every log on each Stop fire.
 */
function listSessionActivity(scope: 'global' | 'project'): readonly SessionActivity[] {
  const tomDir = scope === 'global' ? globalTomDir() : projectTomDir()
  const sessionsDir = path.join(tomDir, 'sessions')

  // Union of .json and .jsonl basenames: a session whose prompt arrived
  // before any tool call has only a sidecar, and must still be prunable.
  const latest = new Map<string, number>()
  for (const file of safeReaddir(sessionsDir)) {
    if (!file.endsWith('.json') && !file.endsWith('.jsonl')) continue
    const sessionId = file.replace(/\.jsonl?$/, '')
    let mtimeMs: number
    try {
      mtimeMs = fs.statSync(path.join(sessionsDir, file)).mtimeMs
    } catch {
      continue // Raced with a concurrent prune — the file is already gone.
    }
    const prior = latest.get(sessionId)
    latest.set(sessionId, prior === undefined ? mtimeMs : Math.max(prior, mtimeMs))
  }

  return [...latest.entries()].map(([sessionId, activityMs]) => ({
    sessionId,
    activityMs,
  }))
}

function deleteSessionFiles(sessionId: string, scope: 'global' | 'project'): void {
  const tomDir = scope === 'global' ? globalTomDir() : projectTomDir()
  const sessionsDir = path.join(tomDir, 'sessions')
  for (const name of [`${sessionId}.json`, `${sessionId}.jsonl`]) {
    try {
      fs.unlinkSync(path.join(sessionsDir, name))
    } catch {
      // File may not exist — ignore
    }
  }
}

function deleteSessionModelFile(sessionId: string, scope: 'global' | 'project'): void {
  const tomDir = scope === 'global' ? globalTomDir() : projectTomDir()
  const modelPath = path.join(tomDir, 'session-models', `${sessionId}.json`)
  try {
    fs.unlinkSync(modelPath)
  } catch {
    // File may not exist — ignore
  }
}

function deleteSnapshotFile(sessionId: string, scope: 'global' | 'project'): void {
  const tomDir = scope === 'global' ? globalTomDir() : projectTomDir()
  const snapshotPath = path.join(tomDir, 'user-model-history', `${sessionId}.json`)
  try {
    fs.unlinkSync(snapshotPath)
  } catch {
    // Snapshots only exist for sessions analyzed after the history feature — ignore
  }
}

/**
 * Tier 2 models whose evidence is older than the retention window. Age is
 * keyed on the model's endedAt (the timestamp that grounds decay); models
 * without one — pre-upgrade files, or ones that fail to parse — fall back to
 * file mtime so they still age out instead of living forever.
 */
function findExpiredModelIds(
  scope: 'global' | 'project',
  retentionDays: number
): readonly string[] {
  const tomDir = scope === 'global' ? globalTomDir() : projectTomDir()
  const modelsDir = path.join(tomDir, 'session-models')
  const cutoffMs = Date.now() - retentionDays * MS_PER_DAY

  const expired: string[] = []
  for (const file of listJsonFiles(modelsDir)) {
    const sessionId = file.replace('.json', '')
    const model = readSessionModel(sessionId, scope)
    const endedAtMs =
      model?.endedAt !== undefined ? Date.parse(model.endedAt) : Number.NaN
    let ageBasisMs: number
    if (Number.isFinite(endedAtMs)) {
      ageBasisMs = endedAtMs
    } else {
      try {
        ageBasisMs = fs.statSync(path.join(modelsDir, file)).mtimeMs
      } catch {
        continue // Raced with a concurrent expiry — already gone.
      }
    }
    if (ageBasisMs < cutoffMs) {
      expired.push(sessionId)
    }
  }

  return expired
}

// --- Main Pruning Function ---

/**
 * Prunes the store:
 * - Tier 1 logs (+ capture sidecars) past maxSessionsRetained (oldest
 *   activity first, never touching a session active within the guard window)
 *   OR past modelRetentionDays of inactivity, whichever bound hits first.
 * - Tier 2 models and their snapshots past modelRetentionDays (endedAt-keyed).
 * - Stale atomic-write temps and orphaned analysis locks.
 *
 * Does NOT rebuild the BM25 index — the caller builds it once after pruning.
 */
export function pruneOldSessions(
  maxSessionsRetained: number,
  scope: 'global' | 'project',
  modelRetentionDays: number
): PruneResult {
  // Always sweep orphaned temps — they accumulate independent of session count.
  const staleTempFilesRemoved = sweepStaleTempFiles(scope)

  const sessions = listSessionActivity(scope)
  const sessionsBeforePrune = sessions.length

  const now = Date.now()
  const activeCutoffMs = now - ACTIVE_SESSION_GUARD_MS
  const timeExpiredCutoffMs = now - modelRetentionDays * MS_PER_DAY
  const sorted = [...sessions].sort((a, b) => a.activityMs - b.activityMs)
  const excess = Math.max(0, sorted.length - maxSessionsRetained)

  // Single oldest-first pass: a session leaves as a count-cap victim (up to
  // `excess`, stopping at the active guard) OR because its activity predates
  // the retention window. Visiting each session once dedupes the overlap so a
  // log that is both over-cap and time-expired is removed a single time, and
  // preserves ascending-activity order in the result.
  const prunedIds: string[] = []
  let countCapRemaining = excess
  let countCapStopped = false
  for (const session of sorted) {
    let isCountVictim = false
    if (!countCapStopped && countCapRemaining > 0) {
      // The first session inside the active guard stops count-cap eviction:
      // every later one is at least as recent (the cap is deliberately soft
      // under a burst of live sessions).
      if (session.activityMs >= activeCutoffMs) {
        countCapStopped = true
      } else {
        isCountVictim = true
        countCapRemaining--
      }
    }
    // Time-expiry is also gated by the active guard: never unlink a session
    // whose last activity is within the guard window, even if a small
    // (misconfigured) retention window would otherwise mark it expired —
    // unlinking a live log recreates an amputated stub on the next capture.
    const isTimeExpired =
      session.activityMs < timeExpiredCutoffMs && session.activityMs < activeCutoffMs
    if (isCountVictim || isTimeExpired) {
      deleteSessionFiles(session.sessionId, scope)
      prunedIds.push(session.sessionId)
    }
  }

  const expiredModelIds = findExpiredModelIds(scope, modelRetentionDays)
  for (const sessionId of expiredModelIds) {
    deleteSessionModelFile(sessionId, scope)
    deleteSnapshotFile(sessionId, scope)
  }

  return {
    prunedSessionIds: prunedIds,
    expiredModelIds,
    sessionsBeforePrune,
    sessionsAfterPrune: sessionsBeforePrune - prunedIds.length,
    staleTempFilesRemoved,
  }
}
