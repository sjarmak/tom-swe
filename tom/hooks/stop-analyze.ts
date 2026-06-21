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

import type { SessionLog, SessionModel } from '../schemas.js'
import { SessionLogSchema } from '../schemas.js'
import {
  readUserModel,
  readSessionModel,
  writeSessionModel,
  writeUserModel,
  globalTomDir,
} from '../memory-io.js'
import { rebuildUserModelFromTier2, carryPromotedFlags } from '../rebuild.js'
import { readTomConfig, isTomEnabled } from '../config.js'
import { buildMemoryIndex } from '../agent/tools.js'
import { getModelForOperation, logUsage } from '../routing.js'
import { readTranscriptUsage } from '../transcript-usage.js'
import { analyzeSessionWithLlm } from '../llm-analyze.js'
import { extractSessionModel } from '../session-extract.js'
import { runPromotion } from '../promotion.js'
import { isLegacyGenericKey } from '../preferences.js'
import { judgeDerivability } from '../promotion-gate.js'
import type { GateCandidate } from '../promotion-gate.js'
import { pruneOldSessions } from '../pruning.js'
import { readHookInput, getSessionId, isExcludedSession } from './hook-input.js'

// --- Configuration ---

/** Logged when no model was spawned (heuristic fallback / error paths). */
const NO_MODEL = 'none'

/**
 * Minimum age of a session's Tier 2 model before re-analysis. Stop fires
 * per turn-end; without this, long sessions burn one LLM analysis per turn.
 */
const ANALYSIS_DEBOUNCE_MS = 90_000

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
 * @param transcriptPath - Path to the session transcript JSONL (from the
 *   hook payload); when present, host-session token usage is parsed from it
 *   and logged as the cost-overhead denominator.
 */
export async function analyzeCompletedSession(
  sessionId: string,
  cwd: string = process.cwd(),
  transcriptPath?: string
): Promise<AnalysisResult> {
  // Host-session usage first: it must land even if analysis fails, and its
  // own failure must not break the pipeline (typed log entry, continue).
  if (transcriptPath) {
    const usage = readTranscriptUsage(transcriptPath)
    if (usage) {
      // Join fields ride along so the external work-audit graph can map
      // this session to a work item without reading Tier 1.
      const earlyLog = readRawSessionLog(sessionId)
      logUsage({
        timestamp: new Date().toISOString(),
        operation: 'session-usage',
        model: NO_MODEL,
        tokenCount: 0,
        sessionId,
        detail: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheCreationTokens: usage.cacheCreationTokens,
          cacheReadTokens: usage.cacheReadTokens,
          assistantMessages: usage.assistantMessages,
          cwd: earlyLog?.cwd ?? cwd,
          gitBranch: earlyLog?.gitBranch ?? null,
        },
      })
    } else {
      logUsage({
        timestamp: new Date().toISOString(),
        operation: 'session-usage-error',
        model: NO_MODEL,
        tokenCount: 0,
        sessionId,
        reason: `transcript unreadable: ${transcriptPath}`,
      })
    }
  }

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

  // Debounce: Stop fires on every turn-end, not once per session. Skip
  // re-analysis when this session was analyzed moments ago — the rebuild
  // keeps Tier 3 idempotent, so the only loss is at most the debounce
  // window's worth of tail content, replaced by the next qualifying fire.
  const tier2Path = path.join(globalTomDir(), 'session-models', `${sessionId}.json`)
  try {
    const ageMs = Date.now() - fs.statSync(tier2Path).mtimeMs
    if (ageMs < ANALYSIS_DEBOUNCE_MS) {
      logUsage({
        timestamp: new Date().toISOString(),
        operation: 'analysis-debounced',
        model: NO_MODEL,
        tokenCount: 0,
        sessionId,
        detail: { ageMs: Math.round(ageMs), debounceMs: ANALYSIS_DEBOUNCE_MS },
      })
      return {
        success: true,
        sessionId,
        sessionModel: null,
        userModelUpdated: false,
        indexRebuilt: false,
      }
    }
  } catch {
    // No Tier 2 model yet — first analysis for this session, proceed.
  }

  // Step 2: Extract Tier 2 session model — headless claude with the
  // configured memoryUpdate model, falling back loudly to the heuristic
  // extractor when the LLM path fails for any reason.
  const configuredModel = getModelForOperation('memoryUpdate')
  // Vocabulary anchoring: pass the current model's keys/values so the
  // analyzer reuses them — exact matches are what reinforcement needs.
  // Legacy generic keys are excluded: anchoring to 'preference'/'pattern'
  // would instruct the model to reuse exactly the keys the discipline
  // rules forbid, re-entrenching the fragmentation this fixes.
  const vocabulary = (readUserModel('global')?.preferencesClusters ?? [])
    .filter((p) => !isLegacyGenericKey(p.key))
    .map((p) => ({ category: p.category, key: p.key, value: p.value }))
  const analysisStartedAt = Date.now()
  const llmResult = await analyzeSessionWithLlm(sessionLog, configuredModel, {
    vocabulary,
  })
  const analysisDurationMs = Date.now() - analysisStartedAt

  // Observable truncation: when the log was bounded for the prompt, record
  // how many interactions were dropped (never silent — see anti-slop).
  if (llmResult.dropped > 0) {
    logUsage({
      timestamp: new Date().toISOString(),
      operation: 'analysis-log-truncated',
      model: NO_MODEL,
      tokenCount: 0,
      sessionId,
      detail: { dropped: llmResult.dropped },
    })
  }

  let extracted: SessionModel
  let preservedPrior = false
  if (llmResult.ok) {
    extracted = llmResult.model
    logUsage({
      timestamp: new Date().toISOString(),
      operation: 'session-analysis',
      model: configuredModel,
      tokenCount: llmResult.tokensUsed ?? 0,
      sessionId,
      durationMs: analysisDurationMs,
      detail: { path: 'llm' },
    })
  } else {
    // Preserve-on-failure: post-0.5.1 the residual failures are uncorrelated
    // timeouts (see tom-swe-j7c). A transient failure must not DOWNGRADE an
    // existing Tier 2 model to the heuristic extractor — keep the prior model
    // when one exists, and only synthesize a heuristic for a session never
    // analyzed before (no regression). Leaving the prior file untouched also
    // keeps its mtime aged, so the debounce permits a fresh LLM attempt next
    // turn (81% of timed-out sessions recover on a later turn).
    const prior = readSessionModel(sessionId, 'global')
    preservedPrior = prior !== null
    logUsage({
      timestamp: new Date().toISOString(),
      operation: 'session-analysis-fallback',
      model: NO_MODEL,
      tokenCount: 0,
      sessionId,
      durationMs: analysisDurationMs,
      reason: `${llmResult.reason}: ${llmResult.detail}`,
      detail: {
        path: preservedPrior ? 'preserved' : 'heuristic',
        failure: llmResult.reason,
      },
    })
    extracted = prior ?? extractSessionModel(sessionLog)
  }
  // endedAt is stamped mechanically from the Tier 1 log (never produced by
  // the LLM): it grounds decay when Tier 3 is rebuilt from Tier 2. On
  // preservation the prior model is kept exactly as persisted (its own
  // endedAt) so the in-memory model never diverges from disk; only a freshly
  // extracted (LLM or heuristic) model is stamped with this turn's endedAt.
  const sessionModel: SessionModel = preservedPrior
    ? extracted
    : { ...extracted, endedAt: sessionLog.endedAt }
  // On preservation the on-disk Tier 2 model is already authoritative; skip the
  // rewrite so its mtime stays aged (re-attempt next turn) and avoid a
  // redundant non-atomic write (tom-swe-ur0).
  if (!preservedPrior) {
    writeSessionModel(sessionModel, 'global')
  }

  // Step 3: Rebuild Tier 3 from ALL Tier 2 models. Stop fires per turn-end,
  // so incremental aggregation re-reinforced the same session every turn
  // (confidence inflated ~2-3x in dogfooding). A rebuild is idempotent: the
  // latest analysis of a session REPLACES its contribution.
  const previousUserModel = readUserModel('global')
  const config = readTomConfig()
  const aggregatedUserModel = carryPromotedFlags(
    rebuildUserModelFromTier2(
      'global',
      config.preferenceDecayDays,
      config.correctionPenalty,
      previousUserModel
    ),
    previousUserModel
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
      detail: {
        corrections: corrections.map((c) => `${c.category}:${c.key}`),
        penalty: config.correctionPenalty,
      },
    })
  }

  // Step 4: Promote stable high-confidence preferences into CLAUDE.md
  // marker blocks and retire them from injection. Promotion failures must
  // never break the analysis pipeline (catch, log, continue).
  try {
    const gate = (candidates: readonly GateCandidate[]): ReadonlySet<string> | null =>
      judgeDerivability(candidates, cwd, configuredModel)
    const promotion = runPromotion(aggregatedUserModel, config.promotion, cwd, gate)
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
        detail: {
          promoted: promotion.promoted.map((p) => `${p.category}:${p.key}`),
          targets: promotion.targets,
        },
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

  // Step 5: Snapshot the post-session user model for as-of queries.
  // The live user-model.json is overwritten every session; temporal
  // leave-one-out evaluation needs the model exactly as it stood after
  // each session. One JSON per session, pruned with the session files.
  try {
    const finalModel = readUserModel('global')
    if (finalModel) {
      const historyDir = path.join(globalTomDir(), 'user-model-history')
      if (!fs.existsSync(historyDir)) {
        fs.mkdirSync(historyDir, { recursive: true })
      }
      fs.writeFileSync(
        path.join(historyDir, `${sessionId}.json`),
        JSON.stringify(finalModel, null, 2),
        'utf-8'
      )
    }
  } catch (error) {
    logUsage({
      timestamp: new Date().toISOString(),
      operation: 'snapshot-error',
      model: NO_MODEL,
      tokenCount: 0,
      sessionId,
      reason: error instanceof Error ? error.message : String(error),
    })
  }

  // Step 6: Rebuild BM25 index
  const index = buildMemoryIndex('global')
  const indexPath = path.join(globalTomDir(), 'bm25-index.json')
  const indexDir = path.dirname(indexPath)
  if (!fs.existsSync(indexDir)) {
    fs.mkdirSync(indexDir, { recursive: true })
  }
  fs.writeFileSync(indexPath, JSON.stringify(index), 'utf-8')

  // Step 7: Prune Tier 1/2 (and matching snapshots) past the retention cap.
  // Designed for this hook since US-013 but never wired until now.
  try {
    pruneOldSessions(config.maxSessionsRetained)
  } catch (error) {
    logUsage({
      timestamp: new Date().toISOString(),
      operation: 'prune-error',
      model: NO_MODEL,
      tokenCount: 0,
      sessionId,
      reason: error instanceof Error ? error.message : String(error),
    })
  }

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
  if (isExcludedSession()) {
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
    await analyzeCompletedSession(
      sessionId,
      input?.cwd ?? process.cwd(),
      input?.transcript_path
    )
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
