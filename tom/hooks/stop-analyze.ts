/**
 * Stop hook TypeScript helper: Analyzes the completed session and updates memory.
 *
 * 1. Reads current session's Tier 1 log
 * 2. Extracts Tier 2 session model via headless claude (configured memoryUpdate
 *    model); falls back to heuristic extraction on any LLM failure, logging the
 *    fallback and its reason to tom/usage.log
 * 3. Aggregates new session model into Tier 3 user model
 * 4. Rebuilds BM25 search index
 * 5. Logs completion status to tom/usage.log
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import type { SessionLog, SessionModel, UserModel } from '../schemas.js'
import { SessionLogSchema } from '../schemas.js'
import { readUserModel, writeSessionModel, writeUserModel, globalTomDir } from '../memory-io.js'
import { aggregateSessionIntoModel } from '../aggregation.js'
import { buildMemoryIndex } from '../agent/tools.js'
import { getModelForOperation, logUsage } from '../routing.js'
import { analyzeSessionWithLlm } from '../llm-analyze.js'
import { extractSessionModel } from '../session-extract.js'
import { readHookInput, getSessionId, isInternalInvocation } from './hook-input.js'

// --- Configuration ---

/** Logged when no model was spawned (heuristic fallback / error paths). */
const NO_MODEL = 'none'

// --- Helpers ---

export function isTomEnabled(): boolean {
  try {
    const configPath = path.join(os.homedir(), '.claude', 'tom', 'config.json')
    const content = fs.readFileSync(configPath, 'utf-8')
    const config = JSON.parse(content) as Record<string, unknown>
    return config['enabled'] === true
  } catch {
    return false
  }
}

function getSessionFilePath(sessionId: string): string {
  return path.join(globalTomDir(), 'sessions', `${sessionId}.json`)
}

// --- Session Analysis ---

/**
 * Reads a raw Tier 1 session log from disk.
 */
export function readRawSessionLog(sessionId: string): SessionLog | null {
  try {
    const filePath = getSessionFilePath(sessionId)
    const content = fs.readFileSync(filePath, 'utf-8')
    const raw = JSON.parse(content) as unknown
    const result = SessionLogSchema.safeParse(raw)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

// --- Main Analysis Pipeline ---

export interface AnalysisResult {
  readonly success: boolean
  readonly sessionId: string
  readonly sessionModel: SessionModel | null
  readonly userModelUpdated: boolean
  readonly indexRebuilt: boolean
  readonly error?: string
}

/**
 * Runs the full session analysis pipeline:
 * 1. Read Tier 1 session log
 * 2. Extract Tier 2 session model (LLM first, heuristic fallback) and log
 *    which path ran to usage.log
 * 3. Aggregate into Tier 3 user model
 * 4. Rebuild BM25 index
 */
export async function analyzeCompletedSession(sessionId: string): Promise<AnalysisResult> {
  // Step 1: Read Tier 1 session log
  const sessionLog = readRawSessionLog(sessionId)
  if (!sessionLog) {
    return {
      success: false,
      sessionId,
      sessionModel: null,
      userModelUpdated: false,
      indexRebuilt: false,
      error: `Session log not found for ${sessionId}`,
    }
  }

  // Step 2: Extract Tier 2 session model — headless claude with the
  // configured memoryUpdate model, falling back loudly to the heuristic
  // extractor when the LLM path fails for any reason.
  const configuredModel = getModelForOperation('memoryUpdate')
  const llmResult = await analyzeSessionWithLlm(sessionLog, configuredModel)

  let sessionModel: SessionModel
  if (llmResult.ok) {
    sessionModel = llmResult.model
    logUsage({
      timestamp: new Date().toISOString(),
      operation: 'session-analysis',
      model: configuredModel,
      tokenCount: llmResult.tokensUsed ?? 0,
      sessionId,
    })
  } else {
    logUsage({
      timestamp: new Date().toISOString(),
      operation: 'session-analysis-fallback',
      model: NO_MODEL,
      tokenCount: 0,
      sessionId,
      reason: `${llmResult.reason}: ${llmResult.detail}`,
    })
    sessionModel = extractSessionModel(sessionLog)
  }
  writeSessionModel(sessionModel, 'global')

  // Step 3: Aggregate into Tier 3 user model
  const currentUserModel = readUserModel('global')
  const emptyModel: UserModel = {
    preferencesClusters: [],
    interactionStyleSummary: '',
    codingStyleSummary: '',
    projectOverrides: {},
  }

  const updatedUserModel = aggregateSessionIntoModel(
    currentUserModel ?? emptyModel,
    sessionModel
  )
  writeUserModel(updatedUserModel, 'global')

  // Step 4: Rebuild BM25 index
  const index = buildMemoryIndex('global')
  const indexPath = path.join(globalTomDir(), 'bm25-index.json')
  const indexDir = path.dirname(indexPath)
  if (!fs.existsSync(indexDir)) {
    fs.mkdirSync(indexDir, { recursive: true })
  }
  fs.writeFileSync(indexPath, JSON.stringify(index), 'utf-8')

  return {
    success: true,
    sessionId,
    sessionModel,
    userModelUpdated: true,
    indexRebuilt: true,
  }
}

// --- CLI Entry Point ---

export async function main(
  stream: NodeJS.ReadableStream = process.stdin
): Promise<void> {
  if (isInternalInvocation()) {
    return
  }
  if (!isTomEnabled()) {
    return
  }

  const input = await readHookInput(stream)

  // Loop guard: when Claude Code re-fires Stop after a stop hook already
  // ran in this turn, exit immediately without output.
  if (input?.stop_hook_active === true) {
    return
  }

  const sessionId = getSessionId(input)

  try {
    await analyzeCompletedSession(sessionId)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logUsage({
      timestamp: new Date().toISOString(),
      operation: 'session-analysis-error',
      model: NO_MODEL,
      tokenCount: 0,
      sessionId,
      reason: errorMessage,
    })
    // Write error to stderr but don't throw — this runs in background
    process.stderr.write(`ToM stop-analyze error: ${errorMessage}\n`)
  }
}

// Run if executed directly
if (require.main === module) {
  void main()
}
