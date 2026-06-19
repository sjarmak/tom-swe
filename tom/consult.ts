/**
 * Shared ambiguity-consultation pipeline.
 *
 * 1. Runs prompt-text ambiguity detection (ambiguity.ts)
 * 2. If ambiguous, searches the cached BM25 index over stored memory
 * 3. Falls back to reading the user model directly when search finds nothing
 * 4. Builds a ToMSuggestion and logs the consultation to usage.log
 *
 * Consultation is fully local — no model is spawned.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import type { ToMSuggestion } from './schemas.js'
import { ToMSuggestionSchema } from './schemas.js'
import { detectAmbiguity } from './ambiguity.js'
import type { AmbiguityThreshold, AmbiguityResult } from './ambiguity.js'
import { readUserModel, globalTomDir } from './memory-io.js'
import { search } from './bm25.js'
import type { BM25Index, BM25SearchResult } from './bm25.js'
import { logUsage } from './routing.js'

// --- Configuration ---

/** Consultation is fully local; no model is ever spawned on this path. */
const NO_MODEL = 'none'

// --- BM25 Index Loading ---

function loadCachedIndex(): BM25Index | null {
  try {
    const indexPath = path.join(globalTomDir(), 'bm25-index.json')
    const content = fs.readFileSync(indexPath, 'utf-8')
    return JSON.parse(content) as BM25Index
  } catch {
    return null
  }
}

// --- Suggestion Generation ---

/**
 * A built suggestion plus the preference keys (category:key) or memory ids
 * that fed it. The keys are logged with the consultation so a later
 * preference-correction on the same key can be joined against the
 * suggestion that preceded it (the acceptance signal).
 */
interface BuiltSuggestion {
  readonly suggestion: ToMSuggestion
  readonly keys: readonly string[]
}

function buildSuggestionFromSearch(
  searchResults: readonly BM25SearchResult[],
  ambiguityResult: AmbiguityResult
): BuiltSuggestion | null {
  if (searchResults.length === 0) {
    return null
  }

  const topResults = searchResults.slice(0, 3)
  const sourceSessions = topResults
    .map(r => r.id)
    .filter(id => id.startsWith('session:') || id.startsWith('model:'))
    .map(id => id.replace(/^(session|model):/, ''))

  const preferenceHints = topResults
    .map(r => r.id.startsWith('user-model')
      ? 'user model preferences'
      : `session ${r.id.replace(/^(session|model):/, '')}`)
    .join(', ')

  const content = `Based on past interactions (${preferenceHints}), ` +
    `the user may have preferences relevant to this request. ` +
    `Ambiguity reason: ${ambiguityResult.reason}.`

  const suggestion: ToMSuggestion = {
    type: ambiguityResult.triggers.includes('preference-sensitive')
      ? 'style'
      : 'disambiguation',
    content,
    confidence: Math.round(ambiguityResult.score * 100) / 100,
    sourceSessions,
  }

  const parseResult = ToMSuggestionSchema.safeParse(suggestion)
  return parseResult.success
    ? { suggestion: parseResult.data, keys: topResults.map(r => r.id) }
    : null
}

function buildSuggestionFromUserModel(
  ambiguityResult: AmbiguityResult
): BuiltSuggestion | null {
  const userModel = readUserModel('merged')
  if (!userModel || userModel.preferencesClusters.length === 0) {
    return null
  }

  // Promoted preferences already live in a CLAUDE.md marker block; a
  // suggestion built solely from them would double-inject, so skip them.
  const unpromoted = userModel.preferencesClusters.filter(
    (p) => p.promoted !== true
  )
  if (unpromoted.length === 0) {
    return null
  }

  const topPrefs = [...unpromoted]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5)

  const prefSummary = topPrefs
    .map(p => `${p.key}=${p.value} (${Math.round(p.confidence * 100)}%)`)
    .join(', ')

  const content = `User preferences: ${prefSummary}. ` +
    `Consider these for the current request. ` +
    `Ambiguity reason: ${ambiguityResult.reason}.`

  const suggestion: ToMSuggestion = {
    type: 'preference',
    content,
    confidence: Math.round(ambiguityResult.score * 100) / 100,
    sourceSessions: [],
  }

  const parseResult = ToMSuggestionSchema.safeParse(suggestion)
  return parseResult.success
    ? {
        suggestion: parseResult.data,
        keys: topPrefs.map(p => `${p.category}:${p.key}`),
      }
    : null
}

// --- Consultation Pipeline ---

export type ConsultationSource = 'bm25' | 'user-model'

export interface ConsultationResult {
  readonly consulted: boolean
  readonly ambiguityResult: AmbiguityResult
  readonly suggestion: ToMSuggestion | null
  readonly source: ConsultationSource | null
}

/**
 * Runs the full consultation pipeline against the user's prompt text:
 * 1. Detect ambiguity
 * 2. If ambiguous, search memory (BM25) or read the user model
 * 3. Generate suggestion
 * 4. Log the consultation with a structured reason
 */
export function consultToM(
  prompt: string,
  threshold: AmbiguityThreshold,
  sessionId: string
): ConsultationResult {
  const startedAt = Date.now()
  const hasUserModel = readUserModel('global') !== null

  const ambiguityResult = detectAmbiguity({
    prompt,
    threshold,
    hasUserModel,
  })

  if (!ambiguityResult.isAmbiguous) {
    return {
      consulted: false,
      ambiguityResult,
      suggestion: null,
      source: null,
    }
  }

  // Try BM25 search first
  const cachedIndex = loadCachedIndex()
  let built: BuiltSuggestion | null = null
  let source: ConsultationSource | null = null

  if (cachedIndex) {
    const results = search(cachedIndex, prompt, 3)
    built = buildSuggestionFromSearch(results, ambiguityResult)
    if (built) {
      source = 'bm25'
    }
  }

  // Fall back to direct user model reading if no BM25 results
  if (!built) {
    built = buildSuggestionFromUserModel(ambiguityResult)
    if (built) {
      source = 'user-model'
    }
  }

  logUsage({
    timestamp: new Date().toISOString(),
    operation: 'ambiguity-consultation',
    model: NO_MODEL,
    tokenCount: 0,
    sessionId,
    durationMs: Date.now() - startedAt,
    detail: {
      score: ambiguityResult.score,
      threshold,
      triggers: ambiguityResult.triggers,
      source: source ?? 'none',
      suggestionType: built?.suggestion.type ?? null,
      suggestionKeys: built?.keys ?? [],
      suggestionChars: built?.suggestion.content.length ?? 0,
    },
  })

  return {
    consulted: true,
    ambiguityResult,
    suggestion: built?.suggestion ?? null,
    source,
  }
}
