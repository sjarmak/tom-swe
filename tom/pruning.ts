/**
 * Session pruning for Tier 1.
 *
 * Prunes old sessions when maxSessionsRetained is exceeded
 * to prevent unbounded storage growth. Also removes corresponding
 * Tier 2 session models and rebuilds the BM25 index.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  readSessionLog,
  globalTomDir,
  projectTomDir,
} from './memory-io'
import { atomicWriteFileSync } from './fs-atomic'
import { buildMemoryIndex } from './agent/tools'
import type { BM25Index } from './bm25'

// --- Types ---

export interface PruneResult {
  readonly prunedSessionIds: readonly string[]
  readonly sessionsBeforePrune: number
  readonly sessionsAfterPrune: number
  readonly indexRebuilt: boolean
  readonly staleTempFilesRemoved: number
}

// A temp file from atomicWriteFileSync/atomicWriteFile is renamed onto its
// target within milliseconds. One that still exists an hour later was orphaned
// by a process killed between write and rename. The generous threshold also
// guarantees we never unlink a temp that a concurrent write is still using.
const STALE_TEMP_MS = 60 * 60 * 1000

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
 * temp write and the rename in tom/fs-atomic.ts. Age-gated so an in-flight
 * write's temp is never touched. Returns the count removed.
 */
function sweepStaleTempFiles(scope: 'global' | 'project'): number {
  const tomDir = scope === 'global' ? globalTomDir() : projectTomDir()
  const now = Date.now()
  let removed = 0

  for (const sub of TEMP_SWEEP_SUBDIRS) {
    const dir = sub ? path.join(tomDir, sub) : tomDir
    for (const name of safeReaddir(dir)) {
      if (!name.endsWith('.tmp')) continue
      const filePath = path.join(dir, name)
      try {
        // lstat (not stat): inspect the directory entry itself, so a symlink
        // named *.tmp is skipped (isFile() is false) rather than followed.
        const stat = fs.lstatSync(filePath)
        if (!stat.isFile() || now - stat.mtimeMs < STALE_TEMP_MS) continue
        fs.unlinkSync(filePath)
        removed++
      } catch {
        // Raced with the owning rename (ENOENT) or a concurrent sweep — ignore.
      }
    }
  }

  return removed
}

interface SessionTimestamp {
  readonly sessionId: string
  readonly startedAt: string
}

function getSessionTimestamps(
  scope: 'global' | 'project'
): readonly SessionTimestamp[] {
  const tomDir = scope === 'global' ? globalTomDir() : projectTomDir()
  const sessionsDir = path.join(tomDir, 'sessions')
  const files = listJsonFiles(sessionsDir)

  const timestamps: SessionTimestamp[] = []
  for (const file of files) {
    const sessionId = file.replace('.json', '')
    const session = readSessionLog(sessionId, scope)
    if (session) {
      timestamps.push({
        sessionId: session.sessionId,
        startedAt: session.startedAt,
      })
    }
  }

  return timestamps
}

function deleteSessionFile(sessionId: string, scope: 'global' | 'project'): void {
  const tomDir = scope === 'global' ? globalTomDir() : projectTomDir()
  const sessionPath = path.join(tomDir, 'sessions', `${sessionId}.json`)
  try {
    fs.unlinkSync(sessionPath)
  } catch {
    // File may not exist — ignore
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

function saveIndex(index: BM25Index, scope: 'global' | 'project'): void {
  const tomDir = scope === 'global' ? globalTomDir() : projectTomDir()
  const indexPath = path.join(tomDir, 'bm25-index.json')
  atomicWriteFileSync(indexPath, JSON.stringify(index))
}

// --- Main Pruning Function ---

/**
 * Prunes old Tier 1 sessions when count exceeds maxSessionsRetained.
 * Also deletes corresponding Tier 2 session models.
 * Rebuilds BM25 index after pruning.
 *
 * Returns list of pruned session IDs.
 */
export function pruneOldSessions(
  maxSessionsRetained: number,
  scope: 'global' | 'project' = 'global'
): PruneResult {
  // Always sweep orphaned temps — they accumulate independent of session count.
  const staleTempFilesRemoved = sweepStaleTempFiles(scope)

  const sessions = getSessionTimestamps(scope)
  const sessionsBeforePrune = sessions.length

  if (sessions.length <= maxSessionsRetained) {
    return {
      prunedSessionIds: [],
      sessionsBeforePrune,
      sessionsAfterPrune: sessionsBeforePrune,
      indexRebuilt: false,
      staleTempFilesRemoved,
    }
  }

  // Sort by startedAt ascending (oldest first)
  const sorted = [...sessions].sort((a, b) =>
    a.startedAt.localeCompare(b.startedAt)
  )

  const countToRemove = sorted.length - maxSessionsRetained
  const toRemove = sorted.slice(0, countToRemove)
  const prunedIds: string[] = []

  for (const session of toRemove) {
    deleteSessionFile(session.sessionId, scope)
    deleteSessionModelFile(session.sessionId, scope)
    deleteSnapshotFile(session.sessionId, scope)
    prunedIds.push(session.sessionId)
  }

  // Rebuild BM25 index after pruning
  const index = buildMemoryIndex(scope)
  saveIndex(index, scope)

  return {
    prunedSessionIds: prunedIds,
    sessionsBeforePrune,
    sessionsAfterPrune: sessionsBeforePrune - countToRemove,
    indexRebuilt: true,
    staleTempFilesRemoved,
  }
}
