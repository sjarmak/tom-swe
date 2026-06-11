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

import type { SessionLog, SessionModel, UserModel } from '../schemas.js'
import { SessionLogSchema } from '../schemas.js'
import { readUserModel, writeSessionModel, writeUserModel, globalTomDir } from '../memory-io.js'
import { aggregateSessionIntoModel } from '../aggregation.js'
import { readTomConfig, isTomEnabled } from '../config.js'
import { buildMemoryIndex } from '../agent/tools.js'
import { getModelForOperation, logUsage } from '../routing.js'
import { analyzeSessionWithLlm } from '../llm-analyze.js'
import { extractSessionModel } from '../session-extract.js'
import { runPromotion } from '../promotion.js'
import { readHookInput, getSessionId, isInternalInvocation } from './hook-input.js'

// --- Configuration ---

/** Logged when no model was spawned (heuristic fallback / error paths). */
const NO_MODEL = 'none'

// --- Helpers ---

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
 * 4. Promote stable high-confidence preferences into CLAUDE.md marker blocks
 * 5. Rebuild BM25 index
 *
 * @param cwd - Session working directory (from the hook payload), used to
 *   route project-scoped promotions to the project's CLAUDE.md.
 */
export async function analyzeCompletedSession(
  sessionId: string,
  cwd: string = process.cwd()
): Promise<AnalysisResult> {
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

  const config = readTomConfig()
  const aggregatedUserModel = aggregateSessionIntoModel(
    currentUserModel ?? emptyModel,
    sessionModel,
    config.preferenceDecayDays,
    config.correctionPenalty
  )
  writeUserModel(aggregatedUserModel, 'global')

  // Telemetry for the external memory-eval harness: one entry per
  // correction batch, listing category:key pairs and the applied penalty.
  const corrections = sessionModel.corrections ?? []
  if (corrections.length > 0) {
    logUsage({
      timestamp: new Date().toISOString(),
      operation: 'preference-correction',
      model: NO_MODEL,
      tokenCount: 0,
      sessionId,
      reason: JSON.stringify({
        corrections: corrections.map((c) => `${c.category}:${c.key}`),
        penalty: config.correctionPenalty,
      }),
    })
  }

  // Step 4: Promote stable high-confidence preferences into CLAUDE.md
  // marker blocks and retire them from injection. Promotion failures must
  // never break the analysis pipeline (catch, log, continue).
  try {
    const promotion = runPromotion(aggregatedUserModel, config.promotion, cwd)
    // runPromotion returns the same reference when promotion is disabled;
    // otherwise persist the updated promoted/retired flags.
    if (promotion.model !== aggregatedUserModel) {
      writeUserModel(promotion.model, 'global')
    }
    if (promotion.promoted.length > 0) {
      logUsage({
        timestamp: new Date().toISOString(),
        operation: 'preference-promotion',
        model: NO_MODEL,
        tokenCount: 0,
        sessionId,
        reason: JSON.stringify({
          promoted: promotion.promoted.map((p) => `${p.category}:${p.key}`),
          targets: promotion.targets,
        }),
      })
    }
  } catch (error) {
    logUsage({
      timestamp: new Date().toISOString(),
      operation: 'promotion-error',
      model: NO_MODEL,
      tokenCount: 0,
      sessionId,
      reason: error instanceof Error ? error.message : String(error),
    })
  }

  // Step 5: Rebuild BM25 index
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
    await analyzeCompletedSession(sessionId, input?.cwd ?? process.cwd())
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
