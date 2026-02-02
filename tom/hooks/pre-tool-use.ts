/**
 * PreToolUse hook TypeScript helper: Consults the ToM agent when ambiguity is detected.
 *
 * 1. Checks if ToM is enabled
 * 2. Runs ambiguity detection from ambiguity.ts against current tool call
 * 3. If ambiguity exceeds threshold, searches memory for relevant preferences
 * 4. Produces ToMSuggestion and writes to stdout for Claude Code hook injection
 * 5. Logs consultation to tom/usage.log
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import type { ToMSuggestion } from '../schemas.js'
import { ToMSuggestionSchema } from '../schemas.js'
import { detectAmbiguity } from '../ambiguity.js'
import type { AmbiguityThreshold, AmbiguityResult } from '../ambiguity.js'
import { readUserModel, globalTomDir } from '../memory-io.js'
import { search } from '../bm25.js'
import type { BM25Index, BM25SearchResult } from '../bm25.js'

// --- Configuration ---

const DEFAULT_CONSULTATION_MODEL = 'sonnet'
const DEFAULT_THRESHOLD: AmbiguityThreshold = 'medium'

// --- Settings ---

interface TomSettings {
  readonly enabled: boolean
  readonly consultThreshold: AmbiguityThreshold
}

export function readTomSettings(): TomSettings {
  try {
    const configPath = path.join(os.homedir(), '.claude', 'tom', 'config.json')
    const content = fs.readFileSync(configPath, 'utf-8')
    const config = JSON.parse(content) as Record<string, unknown>
    const enabled = config['enabled'] === true
    const threshold = config['consultThreshold']
    const validThresholds: readonly AmbiguityThreshold[] = ['low', 'medium', 'high']
    const consultThreshold = typeof threshold === 'string' && validThresholds.includes(threshold as AmbiguityThreshold)
      ? threshold as AmbiguityThreshold
      : DEFAULT_THRESHOLD
    return { enabled, consultThreshold }
  } catch {
    return { enabled: false, consultThreshold: DEFAULT_THRESHOLD }
  }
}

export function isTomEnabled(): boolean {
  return readTomSettings().enabled
}

// --- Session & Environment ---

export function getSessionId(): string {
  return process.env['CLAUDE_SESSION_ID'] ?? `pid-${process.pid}`
}

function parseToolInput(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

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

function buildSuggestionFromSearch(
  searchResults: readonly BM25SearchResult[],
  ambiguityResult: AmbiguityResult,
  toolName: string
): ToMSuggestion | null {
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
    `the user may have preferences relevant to this ${toolName} operation. ` +
    `Ambiguity reason: ${ambiguityResult.reason}.`

  const suggestion: ToMSuggestion = {
    type: ambiguityResult.reason.includes('style') || ambiguityResult.reason.includes('preference')
      ? 'style'
      : 'disambiguation',
    content,
    confidence: Math.round(ambiguityResult.score * 100) / 100,
    sourceSessions,
  }

  const parseResult = ToMSuggestionSchema.safeParse(suggestion)
  return parseResult.success ? parseResult.data : null
}

function buildSuggestionFromUserModel(
  ambiguityResult: AmbiguityResult,
  toolName: string
): ToMSuggestion | null {
  const userModel = readUserModel('merged')
  if (!userModel || userModel.preferencesClusters.length === 0) {
    return null
  }

  const topPrefs = [...userModel.preferencesClusters]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5)

  const prefSummary = topPrefs
    .map(p => `${p.key}=${p.value} (${Math.round(p.confidence * 100)}%)`)
    .join(', ')

  const content = `User preferences: ${prefSummary}. ` +
    `Consider these for the current ${toolName} operation. ` +
    `Ambiguity reason: ${ambiguityResult.reason}.`

  const suggestion: ToMSuggestion = {
    type: 'preference',
    content,
    confidence: Math.round(ambiguityResult.score * 100) / 100,
    sourceSessions: [],
  }

  const parseResult = ToMSuggestionSchema.safeParse(suggestion)
  return parseResult.success ? parseResult.data : null
}

// --- Usage Logging ---

interface UsageLogEntry {
  readonly timestamp: string
  readonly operation: string
  readonly model: string
  readonly tokenCount: number
  readonly sessionId: string
}

export function logUsage(entry: UsageLogEntry): void {
  const logPath = path.join(globalTomDir(), 'usage.log')
  const dir = path.dirname(logPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  const line = JSON.stringify(entry) + '\n'
  fs.appendFileSync(logPath, line, 'utf-8')
}

// --- Consultation Pipeline ---

export interface ConsultationResult {
  readonly consulted: boolean
  readonly ambiguityResult: AmbiguityResult
  readonly suggestion: ToMSuggestion | null
}

/**
 * Runs the full consultation pipeline:
 * 1. Detect ambiguity
 * 2. If ambiguous, search memory or read user model
 * 3. Generate suggestion
 * 4. Log consultation
 */
export function consultToM(
  toolName: string,
  toolInput: Record<string, unknown>,
  recentMessages: readonly string[],
  threshold: AmbiguityThreshold
): ConsultationResult {
  const hasUserModel = readUserModel('global') !== null

  const ambiguityResult = detectAmbiguity({
    toolName,
    toolParameters: toolInput,
    recentUserMessages: recentMessages,
    threshold,
    hasUserModel,
  })

  if (!ambiguityResult.isAmbiguous) {
    return {
      consulted: false,
      ambiguityResult,
      suggestion: null,
    }
  }

  // Try BM25 search first
  const cachedIndex = loadCachedIndex()
  let suggestion: ToMSuggestion | null = null

  if (cachedIndex) {
    const query = [toolName, ...recentMessages].join(' ')
    const results = search(cachedIndex, query, 3)
    suggestion = buildSuggestionFromSearch(results, ambiguityResult, toolName)
  }

  // Fall back to direct user model reading if no BM25 results
  if (!suggestion) {
    suggestion = buildSuggestionFromUserModel(ambiguityResult, toolName)
  }

  const sessionId = getSessionId()
  logUsage({
    timestamp: new Date().toISOString(),
    operation: 'consultation',
    model: DEFAULT_CONSULTATION_MODEL,
    tokenCount: 0,
    sessionId,
  })

  return {
    consulted: true,
    ambiguityResult,
    suggestion,
  }
}

// --- CLI Entry Point ---

export function main(): void {
  if (!isTomEnabled()) {
    return
  }

  const toolName = process.env['TOOL_NAME'] ?? ''
  const toolInputRaw = process.env['TOOL_INPUT'] ?? '{}'

  if (!toolName) {
    return
  }

  const toolInput = parseToolInput(toolInputRaw)
  const settings = readTomSettings()

  // Recent messages not available in env; use empty array
  // The ambiguity detection will still work based on tool parameters
  const recentMessages: readonly string[] = []

  try {
    const result = consultToM(toolName, toolInput, recentMessages, settings.consultThreshold)

    if (result.consulted && result.suggestion) {
      // Write suggestion to stdout for Claude Code hook system injection
      const output = JSON.stringify(result.suggestion)
      process.stdout.write(output)
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const sessionId = getSessionId()
    logUsage({
      timestamp: new Date().toISOString(),
      operation: 'consultation-error',
      model: DEFAULT_CONSULTATION_MODEL,
      tokenCount: 0,
      sessionId,
    })
    process.stderr.write(`ToM pre-tool-use error: ${errorMessage}\n`)
  }
}

// Run if executed directly
if (require.main === module) {
  main()
}
