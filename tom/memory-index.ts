/**
 * BM25 memory index builder.
 *
 * Builds a single BM25 index across all three memory tiers (session logs,
 * session models, user model) for a given scope. Consumed by the Stop hook
 * and the forget/export skill to refresh `bm25-index.json`.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  readSessionLog,
  readSessionModel,
  readUserModel,
  globalTomDir,
  projectTomDir,
} from './memory-io.js'
import { buildIndex } from './bm25.js'
import type { BM25Document, BM25Index } from './bm25.js'

function listJsonFiles(dirPath: string): readonly string[] {
  try {
    const files = fs.readdirSync(dirPath)
    return files.filter(f => f.endsWith('.json'))
  } catch {
    return []
  }
}

/**
 * Renders a Tier 2 preference entry as index text. Post-migration entries
 * are keyed objects ({key, value}); joining them raw would stringify to
 * '[object Object]', dropping the preference tokens from the index.
 */
function preferenceEntryText(
  entry: string | { readonly key: string; readonly value: string }
): string {
  return typeof entry === 'string' ? entry : `${entry.key} ${entry.value}`
}

/**
 * Builds a BM25 index from all available memory files across tiers.
 */
export function buildMemoryIndex(scope: 'global' | 'project' = 'global'): BM25Index {
  const tomDir = scope === 'global' ? globalTomDir() : projectTomDir()
  const documents: BM25Document[] = []

  // Tier 1: Session logs
  const sessionsDir = path.join(tomDir, 'sessions')
  const sessionFiles = listJsonFiles(sessionsDir)
  for (const file of sessionFiles) {
    const sessionId = file.replace('.json', '')
    const session = readSessionLog(sessionId, scope)
    if (session) {
      const content = session.interactions
        .map(i => `${i.toolName} ${Object.keys(i.parameterShape).join(' ')} ${i.outcomeSummary}`)
        .join(' ')
      documents.push({ id: `session:${sessionId}`, content, tier: 1 })
    }
  }

  // Tier 2: Session models
  const modelsDir = path.join(tomDir, 'session-models')
  const modelFiles = listJsonFiles(modelsDir)
  for (const file of modelFiles) {
    const sessionId = file.replace('.json', '')
    const model = readSessionModel(sessionId, scope)
    if (model) {
      const content = [
        model.intent,
        ...model.interactionPatterns.map(preferenceEntryText),
        ...model.codingPreferences.map(preferenceEntryText),
      ].join(' ')
      documents.push({ id: `model:${sessionId}`, content, tier: 2 })
    }
  }

  // Tier 3: User model
  const userModel = readUserModel(scope === 'global' ? 'global' : 'project')
  if (userModel) {
    const content = [
      userModel.interactionStyleSummary,
      userModel.codingStyleSummary,
      ...userModel.preferencesClusters.map(p => `${p.category} ${p.key} ${p.value}`),
    ].join(' ')
    documents.push({ id: 'user-model', content, tier: 3 })
  }

  return buildIndex(documents)
}
