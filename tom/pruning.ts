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
import { buildMemoryIndex } from './agent/tools'
import type { BM25Index } from './bm25'

// --- Types ---

export interface PruneResult {
  readonly prunedSessionIds: readonly string[]
  readonly sessionsBeforePrune: number
  readonly sessionsAfterPrune: number
  readonly indexRebuilt: boolean
}

// --- Helpers ---

function listJsonFiles(dirPath: string): readonly string[] {
  try {
    return fs.readdirSync(dirPath)
      .filter(f => f.endsWith('.json'))
  } catch {
    return []
  }
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

function saveIndex(index: BM25Index, scope: 'global' | 'project'): void {
  const tomDir = scope === 'global' ? globalTomDir() : projectTomDir()
  const indexPath = path.join(tomDir, 'bm25-index.json')
  const dir = path.dirname(indexPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(indexPath, JSON.stringify(index), 'utf-8')
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
  const sessions = getSessionTimestamps(scope)
  const sessionsBeforePrune = sessions.length

  if (sessions.length <= maxSessionsRetained) {
    return {
      prunedSessionIds: [],
      sessionsBeforePrune,
      sessionsAfterPrune: sessionsBeforePrune,
      indexRebuilt: false,
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
  }
}
