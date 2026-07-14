/**
 * Outcome follow-through rollup over usage.log entries.
 *
 * Pure aggregation — no I/O. Consumers read the log via readUsageLog() in
 * routing.ts and pass the entries here.
 *
 * The question this answers: when ToM ASSERTS a preference key in a session
 * (injected at SessionStart, or surfaced by an ambiguity-consultation), does
 * that key survive the session UN-corrected (followed through / confirmed), or
 * does the user override it (corrected)? This is the task-usefulness signal
 * /tom-effectiveness reports.
 *
 * The join is per host session id: SessionStart injection, ambiguity
 * consultation, and the Stop-hook correction all stamp the same sanitized
 * sessionId (getSessionId -> sanitizeSessionId), so asserted keys for a session
 * join against that session's corrections directly.
 *
 * Stated confounds (surfaced, not hidden):
 * - "Confirmed" means only that the asserted key was NOT overridden in the same
 *   session — it does NOT prove the assertion improved an answer or saved a
 *   re-prompt. It is the honest signal available from the log: absence of a
 *   correction is acceptance, presence is rejection (see README acceptance loop).
 * - Only real preference keys (category:key) can be corrected, so only
 *   injection keys and USER-MODEL-sourced consultation keys are counted as
 *   assertions; bm25-sourced consultation keys are provenance ids
 *   (session:/model:/user-model) that can never appear in a correction and
 *   would otherwise inflate the confirmed count.
 * - Exposure unit is the ANALYSIS RUN, not the host session — matching the
 *   preference-correction telemetry. The Stop analyzer
 *   re-runs per turn, so one host session can emit several
 *   preference-follow-through records; each is one analysis run's assertions,
 *   and the rate is reported per analysis run, not deduped per session.
 *   Sessions analyzed before this instrument existed carry no record, so the
 *   rate is forward-looking.
 */

import { usageDetailStringArray, type UsageLogEntry } from './routing.js'

// --- Types ---

export interface FollowThroughSplit {
  /** Asserted keys the user did NOT correct in-session. */
  readonly confirmed: readonly string[]
  /** Asserted keys the user corrected in-session. */
  readonly corrected: readonly string[]
}

export interface FollowThroughSummary {
  readonly hasData: boolean
  /** Analysis runs that asserted at least one preference key (exposure unit). */
  readonly analyses: number
  /** Total (key, analysis-run) assertions across all runs. */
  readonly assertedKeys: number
  readonly confirmedKeys: number
  readonly correctedKeys: number
  /** confirmedKeys / assertedKeys * 100 (0 when nothing asserted). */
  readonly followThroughRate: number
}

// --- Helpers ---

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// --- Per-session join ---

/**
 * Collects the preference keys (category:key) ASSERTED during one session:
 * every key injected at SessionStart plus every key surfaced by a user-model
 * ambiguity-consultation. Deduplicated. bm25-sourced consultation keys are
 * excluded (they are provenance ids, never correctable).
 */
export function assertedKeysForSession(
  entries: readonly UsageLogEntry[],
  sessionId: string
): string[] {
  const keys = new Set<string>()
  for (const entry of entries) {
    if (entry.sessionId !== sessionId) continue
    if (entry.operation === 'session-start-injection') {
      for (const key of usageDetailStringArray(entry, 'injectedKeys')) keys.add(key)
    } else if (
      entry.operation === 'ambiguity-consultation' &&
      entry.detail?.['source'] === 'user-model'
    ) {
      for (const key of usageDetailStringArray(entry, 'suggestionKeys')) keys.add(key)
    }
  }
  return [...keys]
}

/**
 * Splits asserted keys into confirmed (not corrected in-session) and corrected.
 * Corrections on keys that were never asserted are ignored — this measures the
 * outcome of ASSERTIONS, not the full correction stream.
 */
export function splitFollowThrough(
  asserted: readonly string[],
  correctedKeys: readonly string[]
): FollowThroughSplit {
  const correctedSet = new Set(correctedKeys)
  const confirmed: string[] = []
  const corrected: string[] = []
  for (const key of asserted) {
    if (correctedSet.has(key)) corrected.push(key)
    else confirmed.push(key)
  }
  return { confirmed, corrected }
}

// --- Aggregation ---

/**
 * Aggregates the per-analysis-run `preference-follow-through` records into a
 * single follow-through rate. Each record already carries the
 * confirmed/corrected split for its run (computed at Stop by splitFollowThrough),
 * so this is a pure sum — the join logic lives in one place. The exposure unit
 * is the analysis run (one host session can contribute several records across
 * re-analysis turns), matching the preference-correction telemetry.
 */
export function computeFollowThroughSummary(
  entries: readonly UsageLogEntry[]
): FollowThroughSummary {
  let analyses = 0
  let assertedKeys = 0
  let confirmedKeys = 0
  let correctedKeys = 0

  for (const entry of entries) {
    if (entry.operation !== 'preference-follow-through') continue
    analyses += 1
    assertedKeys += usageDetailStringArray(entry, 'asserted').length
    confirmedKeys += usageDetailStringArray(entry, 'confirmed').length
    correctedKeys += usageDetailStringArray(entry, 'corrected').length
  }

  return {
    hasData: analyses > 0,
    analyses,
    assertedKeys,
    confirmedKeys,
    correctedKeys,
    followThroughRate:
      assertedKeys > 0 ? round2((confirmedKeys / assertedKeys) * 100) : 0,
  }
}

// --- Formatting ---

/**
 * Renders the follow-through summary as markdown lines. Returns an empty array
 * when there is nothing recorded yet (section omitted).
 */
export function formatFollowThrough(summary: FollowThroughSummary): string[] {
  if (!summary.hasData) return []

  return [
    '## Follow-through (injected/consulted keys, confirmed vs corrected in-session)',
    `- Follow-through rate: ${summary.followThroughRate}% ` +
      `(${summary.confirmedKeys}/${summary.assertedKeys} asserted keys survived ` +
      `un-corrected across ${summary.analyses} analysis runs; ${summary.correctedKeys} corrected).`,
    '- Confirmed = asserted and not overridden in the same session; measures ' +
      'whether asserting a preference held up, not that it improved an answer.',
    '- Exposure unit is the analysis run (per-turn Stop analysis), matching the ' +
      'correction/promotion rates, not the host session.',
    '',
  ]
}
