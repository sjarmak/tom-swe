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
import {
  readSessionLog,
  readUserModel,
  readSessionModel,
  writeSessionModel,
  writeUserModel,
  globalTomDir,
} from '../memory-io.js'
import { rebuildUserModelFromTier2, carryPromotedFlags } from '../rebuild.js'
import { readTomConfig, isTomEnabled } from '../config.js'
import { buildMemoryIndex } from '../agent/tools.js'
import { getModelForOperation, logUsage, prefKeyForTelemetry, readUsageLog, rotateUsageLogIfNeeded } from '../routing.js'
import { sanitizeValue } from '../secrets.js'
import { assertedKeysForSession, splitFollowThrough } from '../follow-through.js'
import { readTranscriptUsage } from '../transcript-usage.js'
import { analyzeSessionWithLlm } from '../llm-analyze.js'
import { computeVocabularyEcho } from '../vocabulary-echo.js'
import { extractSessionModel } from '../session-extract.js'
import { runPromotion } from '../promotion.js'
import {
  isLegacyGenericKey,
  canonicalCategoryByKey,
  dropRefiledCorrections,
  reconcileCrossCategorySplits,
} from '../preferences.js'
import { deriveStyleSummaries } from '../aggregation.js'
import { judgeDerivability } from '../promotion-gate.js'
import type { GateCandidate } from '../promotion-gate.js'
import { pruneOldSessions } from '../pruning.js'
import { atomicWriteFileSync } from '../fs-atomic.js'
import { readHookInput, getSessionId, isExcludedSession } from './hook-input.js'

// --- Configuration ---

/** Logged when no model was spawned (heuristic fallback / error paths). */
const NO_MODEL = 'none'

/**
 * Minimum age of a session's Tier 2 model before re-analysis. Stop fires
 * per turn-end; without this, long sessions burn one LLM analysis per turn.
 */
const ANALYSIS_DEBOUNCE_MS = 90_000

// --- Session Analysis ---

/**
 * Reads the Tier 1 session log — the folded view of the .json stub (or a
 * complete pre-sidecar log) plus the append-only capture sidecar.
 */
export function readRawSessionLog(sessionId: string): SessionLog | null {
  return readSessionLog(sessionId, 'global')
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
 * Collapses any preference key split across categories to a single canonical
 * category and returns the reconciled model, emitting one
 * `preference-cross-category-collapse` telemetry entry per collapse that
 * represents NEW information.
 *
 * The store rebuilds from Tier 2 every Stop, so a persistently-split key (its
 * oldest session tagged the key under two categories) re-forms the split on
 * every rebuild; naive per-rebuild logging would spam. A collapse is suppressed
 * only when the previous model already resolved the key to the SAME winner AND
 * the SAME value — i.e. genuine steady state. A changed resolved value (fresh
 * losing-category evidence winning by recency) re-logs, so the audit trail
 * never goes silent on a real preference change even when the winning category
 * is unchanged.
 *
 * Runs AFTER carryPromotedFlags (so a restored promoted flag rides the re-filed
 * cluster onto the winner) and BEFORE runPromotion (so promotion never sees a
 * still-split key).
 */
export function reconcilePreferenceCategories(
  rebuiltModel: UserModel,
  previousModel: UserModel | null,
  sessionId: string
): UserModel {
  const { preferences: reconciledClusters, collapses } =
    reconcileCrossCategorySplits(rebuiltModel.preferencesClusters)
  if (collapses.length === 0) {
    return rebuiltModel
  }

  const reconciledModel: UserModel = {
    ...rebuiltModel,
    preferencesClusters: reconciledClusters,
    // Summaries were derived pre-reconcile; re-derive so neither lists a value
    // that was recategorized away.
    ...deriveStyleSummaries(reconciledClusters),
  }

  const priorCanonical = canonicalCategoryByKey(
    previousModel?.preferencesClusters ?? []
  )
  const priorValueByGroup = new Map(
    (previousModel?.preferencesClusters ?? []).map((p) => [
      `${p.category}::${p.key}`,
      p.value,
    ])
  )
  const resolvedValueByGroup = new Map(
    reconciledClusters.map((p) => [`${p.category}::${p.key}`, p.value])
  )
  const novelCollapses = collapses.filter((c) => {
    const group = `${c.winner}::${c.key}`
    const alreadyResolved =
      priorCanonical.get(c.key) === c.winner &&
      priorValueByGroup.get(group) === resolvedValueByGroup.get(group)
    return !alreadyResolved
  })

  if (novelCollapses.length > 0) {
    logUsage({
      timestamp: new Date().toISOString(),
      operation: 'preference-cross-category-collapse',
      model: NO_MODEL,
      tokenCount: 0,
      sessionId,
      detail: {
        // Sanitize the key and every value before they land in the durable
        // usage.log — this is the one collapse-telemetry path that logs raw
        // preference VALUES, so it applies the same structured-secret backstop
        // as the category:key sites.
        collapses: novelCollapses.map((c) => ({
          key: sanitizeValue(c.key),
          winner: c.winner,
          // resolveConflicts guarantees exactly one cluster per winner::key, so
          // this lookup always hits; the `?? ''` only satisfies the string type.
          resolvedValue: sanitizeValue(
            resolvedValueByGroup.get(`${c.winner}::${c.key}`) ?? ''
          ),
          refiled: c.refiled.map((r) => ({
            ...r,
            value: sanitizeValue(r.value),
          })),
        })),
      },
    })
  }

  return reconciledModel
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
  const modelsDir = path.join(globalTomDir(), 'session-models')
  const tier2Path = path.join(modelsDir, `${sessionId}.json`)
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

  // Watermark: re-analysis needs new evidence, not just elapsed time. The
  // debounce alone re-analyzed unchanged sessions on every >90s turn (78%
  // of analysis spend went to sessions already analyzed). userMessages are
  // the analyzer's primary evidence source, so an unchanged count means a
  // tool-only continuation with nothing new to learn. The watermark only
  // advances on successful extraction, so a failed analysis stays
  // retryable on the next turn without new messages.
  const priorModel = readSessionModel(sessionId, 'global')
  const userMessageCount = sessionLog.userMessages?.length ?? 0
  if (
    priorModel?.analyzedUserMessageCount !== undefined &&
    userMessageCount <= priorModel.analyzedUserMessageCount
  ) {
    logUsage({
      timestamp: new Date().toISOString(),
      operation: 'analysis-skipped-no-new-evidence',
      model: NO_MODEL,
      tokenCount: 0,
      sessionId,
      detail: {
        userMessageCount,
        analyzedUserMessageCount: priorModel.analyzedUserMessageCount,
      },
    })
    return {
      success: true,
      sessionId,
      sessionModel: null,
      userModelUpdated: false,
      indexRebuilt: false,
    }
  }

  // In-flight lock: the debounce stats a file only written AFTER the LLM
  // call completes (up to 90s), so concurrent Stop fires for the same
  // session each passed it and spawned duplicate analyses (~2.3% of spend,
  // and the stale snapshot could publish last). O_EXCL creation is the
  // arbiter; orphaned locks are age-swept by pruning.
  const lockPath = path.join(modelsDir, `${sessionId}.lock`)
  let lockFd: number | null = null
  try {
    fs.mkdirSync(modelsDir, { recursive: true })
    lockFd = fs.openSync(lockPath, 'wx')
    fs.writeSync(lockFd, `${process.pid} ${new Date().toISOString()}`)
  } catch {
    logUsage({
      timestamp: new Date().toISOString(),
      operation: 'analysis-in-flight',
      model: NO_MODEL,
      tokenCount: 0,
      sessionId,
      detail: { lockPath },
    })
    return {
      success: true,
      sessionId,
      sessionModel: null,
      userModelUpdated: false,
      indexRebuilt: false,
    }
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
  let sessionModel: SessionModel
  try {
    const analysisStartedAt = Date.now()
    const llmResult = await analyzeSessionWithLlm(sessionLog, configuredModel, {
      vocabulary,
    })
    const analysisDurationMs = Date.now() - analysisStartedAt

    // Observable truncation: when the log was bounded for the prompt, record
    // how many interactions and user messages were dropped (never silent —
    // see anti-slop).
    if (llmResult.dropped > 0 || llmResult.droppedUserMessages > 0) {
      logUsage({
        timestamp: new Date().toISOString(),
        operation: 'analysis-log-truncated',
        model: NO_MODEL,
        tokenCount: 0,
        sessionId,
        detail: {
          dropped: llmResult.dropped,
          droppedUserMessages: llmResult.droppedUserMessages,
        },
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
      // Vocabulary-anchoring instrument: measure how much of this fresh
      // extraction is a verbatim echo of the vocabulary we injected. Logged
      // only when vocabulary was actually injected, and only on the LLM path
      // (a preserved prior model is not this session's analysis). Purely
      // observational — the number feeds a future prompt-change evaluation.
      if (vocabulary.length > 0) {
        const echo = computeVocabularyEcho(vocabulary, extracted)
        logUsage({
          timestamp: new Date().toISOString(),
          operation: 'analysis-vocabulary-echo',
          model: NO_MODEL,
          tokenCount: 0,
          sessionId,
          detail: {
            injected: echo.injected,
            returned: echo.returned,
            echoedKeyValue: echo.echoedKeyValue,
            echoedKey: echo.echoedKey,
          },
        })
      }
    } else {
      // Preserve-on-failure: post-0.5.1 the residual failures are uncorrelated
      // timeouts (see tom-swe-j7c). A transient failure must not DOWNGRADE an
      // existing Tier 2 model to the heuristic extractor — keep the prior model
      // when one exists, and only synthesize a heuristic for a session never
      // analyzed before (no regression). Leaving the prior file untouched also
      // keeps its watermark and mtime aged, so a fresh LLM attempt is
      // permitted next turn (81% of timed-out sessions recover on a later turn).
      preservedPrior = priorModel !== null
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
      extracted = priorModel ?? extractSessionModel(sessionLog)
    }
    // endedAt and the userMessage watermark are stamped mechanically from
    // the Tier 1 log (never produced by the LLM): endedAt grounds decay in
    // Tier 3 rebuilds; the watermark gates re-analysis. On preservation the
    // prior model is kept exactly as persisted (its own stamps) so the
    // in-memory model never diverges from disk.
    sessionModel = preservedPrior
      ? extracted
      : {
          ...extracted,
          endedAt: sessionLog.endedAt,
          analyzedUserMessageCount: userMessageCount,
        }
    // On preservation the on-disk Tier 2 model is already authoritative; skip the
    // rewrite so its mtime stays aged (re-attempt next turn) and avoid a
    // redundant non-atomic write (tom-swe-ur0).
    if (!preservedPrior) {
      writeSessionModel(sessionModel, 'global')
    }
  } finally {
    // Release the in-flight lock as soon as Tier 2 is published — the
    // downstream rebuild/promotion/index steps are idempotent and safe to
    // overlap across sessions.
    try {
      if (lockFd !== null) {
        fs.closeSync(lockFd)
        fs.unlinkSync(lockPath)
      }
    } catch {
      // Already swept as stale by a concurrent prune — nothing to release.
    }
  }

  // Step 3: Rebuild Tier 3 from ALL Tier 2 models. Stop fires per turn-end,
  // so incremental aggregation re-reinforced the same session every turn
  // (confidence inflated ~2-3x in dogfooding). A rebuild is idempotent: the
  // latest analysis of a session REPLACES its contribution.
  const previousUserModel = readUserModel('global')
  const config = readTomConfig()
  const rebuiltModel = carryPromotedFlags(
    rebuildUserModelFromTier2(
      'global',
      config.preferenceDecayDays,
      config.correctionPenalty,
      previousUserModel
    ),
    previousUserModel
  )

  // Collapse any key split across categories to a single canonical category
  // (keeps the persisted model single-category) and emit a telemetry trace of
  // real collapses. See reconcilePreferenceCategories for the ordering and
  // suppression rationale.
  const aggregatedUserModel = reconcilePreferenceCategories(
    rebuiltModel,
    previousUserModel,
    sessionId
  )
  writeUserModel(aggregatedUserModel, 'global')

  // Telemetry for the external memory-eval harness: one entry per
  // correction batch, listing category:key pairs and the applied penalty.
  // Cross-category re-files (the analyzer correcting its own prior-category
  // inference, not a user override) are dropped so a mere re-file emits no
  // correction event.
  //
  // The canonical categories here come from previousUserModel (last Stop's
  // persisted Tier 3), which APPROXIMATES the basis aggregation actually used.
  // The fold in aggregateSessionIntoModel drops this session's corrections
  // against the canonical of the store as it stood BEFORE folding this session
  // (its pre-session `decayed` state). Because the rebuild folds each session
  // with asOf = its own endedAt, decay is deterministic for a fixed session
  // set, so on a session's FIRST analysis previousUserModel equals that
  // pre-session state exactly and the filter matches the fold. The two diverge
  // only when this session is RE-ANALYZED across turns: previousUserModel then
  // already carries this session's own earlier-turn categories, while the fresh
  // rebuild folds the session exactly once. For a brand-new key this session
  // both introduced (under category X) and re-filed a correction for (under
  // Y != X) between turns, the filter drops that correction (prior canonical
  // says X) though the single fold kept it (its pre-session canonical had no
  // entry for the key). The effect is telemetry-only: one genuine correction
  // event under-reported. The persisted Tier 3 model uses the fold's own
  // canonical and is unaffected. Low frequency; sharing the fold's mid-fold
  // per-session canonical would mean threading it out of the pure rebuild, so
  // the approximation stands rather than couple the two modules.
  const corrections = dropRefiledCorrections(
    sessionModel.corrections ?? [],
    canonicalCategoryByKey(previousUserModel?.preferencesClusters ?? [])
  )
  // Derived from the FILTERED corrections so follow-through's "corrected" set
  // also excludes self-refiles (a re-filed key is not a user override).
  const correctedKeys = corrections.map((c) => prefKeyForTelemetry(c.category, c.key))
  if (corrections.length > 0) {
    logUsage({
      timestamp: new Date().toISOString(),
      operation: 'preference-correction',
      model: NO_MODEL,
      tokenCount: 0,
      sessionId,
      detail: {
        corrections: correctedKeys,
        penalty: config.correctionPenalty,
      },
    })
  }

  // Outcome follow-through: tie the preference keys ASSERTED this session
  // (SessionStart injection + user-model consultation, read back from the log
  // stream — no new runtime state threaded) to whether the user corrected or
  // confirmed (left un-corrected) each one in-session. One record per session
  // that asserted anything; the confirmed case is the majority, so this is NOT
  // gated on corrections existing (see follow-through.ts for the metric).
  // Session-scoped read: only this session's lines are parsed (the whole
  // usage.log grows to ~5MB between rotations, and this runs on every Stop).
  const asserted = assertedKeysForSession(
    readUsageLog({ sessionId }).entries,
    sessionId
  )
  if (asserted.length > 0) {
    const { confirmed, corrected } = splitFollowThrough(asserted, correctedKeys)
    logUsage({
      timestamp: new Date().toISOString(),
      operation: 'preference-follow-through',
      model: NO_MODEL,
      tokenCount: 0,
      sessionId,
      detail: { asserted, confirmed, corrected },
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
    // Log only when a memory file actually changed: idempotent block
    // regenerations used to fire this event on every qualifying Stop
    // (452 spurious rewrites in 24 days).
    if (promotion.promoted.length > 0 && promotion.targets.length > 0) {
      logUsage({
        timestamp: new Date().toISOString(),
        operation: 'preference-promotion',
        model: NO_MODEL,
        tokenCount: 0,
        sessionId,
        detail: {
          promoted: promotion.promoted.map((p) => prefKeyForTelemetry(p.category, p.key)),
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
      atomicWriteFileSync(
        path.join(historyDir, `${sessionId}.json`),
        JSON.stringify(finalModel, null, 2)
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

  // Step 6: Prune Tier 1 past the retention cap and expire Tier 2 models
  // (and snapshots) past the decay window. Runs BEFORE the index build so
  // the single build below reflects the post-prune store — pruning used to
  // rebuild the index internally, duplicating the build every fire.
  try {
    pruneOldSessions(
      config.maxSessionsRetained,
      'global',
      config.preferenceDecayDays
    )
    // usage.log is the one store file pruning doesn't govern: archive it
    // past the size threshold (archives preserved for eval consumers).
    rotateUsageLogIfNeeded()
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

  // Step 7: Rebuild the BM25 index once per qualifying Stop.
  const index = buildMemoryIndex('global')
  const indexPath = path.join(globalTomDir(), 'bm25-index.json')
  atomicWriteFileSync(indexPath, JSON.stringify(index))

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
