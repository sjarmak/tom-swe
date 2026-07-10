/**
 * Promotion-effectiveness rollup over usage.log entries.
 *
 * Pure aggregation — no I/O. Consumers read the log via readUsageLog() in
 * routing.ts and pass the entries here.
 *
 * The question this answers: does promoting a preference into CLAUDE.md (pinned
 * confidence, asserted every session) reduce how often it gets CORRECTED versus
 * its pre-promotion life (soft SessionStart injection, confidence still moving)?
 *
 * Exposure unit is the ANALYSIS RUN, not the host session. preference-correction
 * and preference-promotion are both emitted only inside the Stop-hook analyzer;
 * the large majority of host sessions never run an analysis (they only hit the
 * prompt hook), so a per-session denominator is dominated by sessions that had
 * zero chance to produce a correction. Rates below are per 100 analyses.
 *
 * Stated confounds (surfaced, not hidden):
 * - Late-promoted keys have a short after-window (few analyses); analysesAfter is
 *   reported per row so thin windows are visible. thinAfterWindow flags them.
 * - The log does not record which specific keys were asserted in a given analysis,
 *   so the denominator is global. Pre-promotion assertion is confidence-gated, so
 *   before-exposure is biased low — the test is CONSERVATIVE (fewer pre-promotion
 *   chances to be corrected), and a drop in the after-rate is a real signal.
 * - Correction rate measures internal consistency (did the memory stop
 *   flip-flopping), NOT task usefulness (did asserting the preference change an
 *   outcome). Near-zero post-promotion corrections means promoted memory is stable
 *   and accepted, not that it improved any answer.
 */

import { usageDetailStringArray, type UsageLogEntry } from './routing.js'

// --- Types ---

/** Below this many post-promotion analyses, the after-rate is too thin to trust. */
export const THIN_AFTER_WINDOW = 15

export interface KeyPromotionEffect {
  /** `category:key` as recorded in the correction/promotion detail arrays. */
  readonly key: string
  /** ISO timestamp of the FIRST promotion for this key. */
  readonly firstPromotedAt: string
  /** Number of promotion events for this key (re-promotions included). */
  readonly promotionEvents: number
  readonly correctionsBefore: number
  readonly correctionsAfter: number
  readonly analysesBefore: number
  readonly analysesAfter: number
  /** correctionsBefore / analysesBefore * 100 (0 when no analyses before). */
  readonly rateBefore: number
  /** correctionsAfter / analysesAfter * 100 (0 when no analyses after). */
  readonly rateAfter: number
  /** analysesAfter < THIN_AFTER_WINDOW — rateAfter has wide error. */
  readonly thinAfterWindow: boolean
}

export interface WeeklyCorrectionRate {
  /** ISO year-week label, e.g. "2026-W28". */
  readonly week: string
  readonly corrections: number
  readonly analyses: number
  /** corrections / analyses * 100 (0 when no analyses that week). */
  readonly rate: number
}

export interface EffectivenessSummary {
  readonly hasData: boolean
  /** Total analysis runs (LLM + fallback) = the exposure denominator. */
  readonly totalAnalyses: number
  readonly totalCorrections: number
  readonly correctedKeys: number
  readonly promotedKeys: number
  /** Per-key before/after, only for keys that were both promoted and corrected. */
  readonly perKey: readonly KeyPromotionEffect[]
  readonly pooledCorrectionsBefore: number
  readonly pooledCorrectionsAfter: number
  /**
   * Corrections landing on keys that were NEVER promoted. The headline: if this
   * dominates, the promotion gate is filtering unstable inferences out before
   * they reach CLAUDE.md.
   */
  readonly correctionsOnNeverPromoted: number
  readonly weekly: readonly WeeklyCorrectionRate[]
}

// --- Helpers ---

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function ratePer100(count: number, denominator: number): number {
  return denominator > 0 ? round2((count / denominator) * 100) : 0
}

/** ISO-week label without pulling in a date library. */
function isoWeekLabel(timestamp: string): string {
  const date = new Date(timestamp)
  // Copy to UTC midnight of the given day, then shift to the Thursday of the
  // ISO week (ISO weeks are Monday-based; the year is the year of the Thursday).
  const target = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  )
  const dayNumber = (target.getUTCDay() + 6) % 7 // Mon=0 .. Sun=6
  target.setUTCDate(target.getUTCDate() - dayNumber + 3) // to Thursday
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4))
  const firstDayNumber = (firstThursday.getUTCDay() + 6) % 7
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNumber + 3)
  const week =
    1 +
    Math.round(
      (target.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000)
    )
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

// --- Aggregation ---

export function computeEffectivenessSummary(
  entries: readonly UsageLogEntry[]
): EffectivenessSummary {
  const analysisTimestamps: string[] = []
  const firstPromotedAt = new Map<string, string>()
  const promotionEventCount = new Map<string, number>()
  const correctionsByKey = new Map<string, string[]>()

  for (const entry of entries) {
    const ts = entry.timestamp
    if (typeof ts !== 'string' || ts.length === 0) continue

    switch (entry.operation) {
      case 'session-analysis':
      case 'session-analysis-fallback':
        analysisTimestamps.push(ts)
        break
      case 'preference-promotion':
        for (const key of usageDetailStringArray(entry, 'promoted')) {
          promotionEventCount.set(key, (promotionEventCount.get(key) ?? 0) + 1)
          const prior = firstPromotedAt.get(key)
          if (prior === undefined || ts < prior) firstPromotedAt.set(key, ts)
        }
        break
      case 'preference-correction':
        for (const key of usageDetailStringArray(entry, 'corrections')) {
          const list = correctionsByKey.get(key) ?? []
          list.push(ts)
          correctionsByKey.set(key, list)
        }
        break
      default:
        break
    }
  }

  analysisTimestamps.sort()
  const totalAnalyses = analysisTimestamps.length

  const analysesBefore = (cutoff: string): number => {
    // analysisTimestamps is sorted; count strictly-before via binary search.
    let lo = 0
    let hi = analysisTimestamps.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((analysisTimestamps[mid] ?? '') < cutoff) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  const perKey: KeyPromotionEffect[] = []
  let pooledCorrectionsBefore = 0
  let pooledCorrectionsAfter = 0

  for (const [key, firstAt] of firstPromotedAt) {
    const corrections = correctionsByKey.get(key)
    if (corrections === undefined || corrections.length === 0) continue

    const before = corrections.filter((t) => t < firstAt).length
    const after = corrections.length - before
    const nBefore = analysesBefore(firstAt)
    const nAfter = totalAnalyses - nBefore

    pooledCorrectionsBefore += before
    pooledCorrectionsAfter += after

    perKey.push({
      key,
      firstPromotedAt: firstAt,
      promotionEvents: promotionEventCount.get(key) ?? 0,
      correctionsBefore: before,
      correctionsAfter: after,
      analysesBefore: nBefore,
      analysesAfter: nAfter,
      rateBefore: ratePer100(before, nBefore),
      rateAfter: ratePer100(after, nAfter),
      thinAfterWindow: nAfter < THIN_AFTER_WINDOW,
    })
  }

  // Most corrections first, then most-recent promotion for stable ordering.
  perKey.sort((a, b) => {
    const totalA = a.correctionsBefore + a.correctionsAfter
    const totalB = b.correctionsBefore + b.correctionsAfter
    if (totalA !== totalB) return totalB - totalA
    return b.firstPromotedAt.localeCompare(a.firstPromotedAt)
  })

  let totalCorrections = 0
  let correctionsOnNeverPromoted = 0
  for (const [key, list] of correctionsByKey) {
    totalCorrections += list.length
    if (!firstPromotedAt.has(key)) correctionsOnNeverPromoted += list.length
  }

  // Weekly rollup: corrections and analyses per ISO week.
  const weekCorrections = new Map<string, number>()
  const weekAnalyses = new Map<string, number>()
  for (const entry of entries) {
    const ts = entry.timestamp
    if (typeof ts !== 'string' || ts.length === 0) continue
    const week = isoWeekLabel(ts)
    if (entry.operation === 'preference-correction') {
      weekCorrections.set(
        week,
        (weekCorrections.get(week) ?? 0) + usageDetailStringArray(entry, 'corrections').length
      )
    } else if (
      entry.operation === 'session-analysis' ||
      entry.operation === 'session-analysis-fallback'
    ) {
      weekAnalyses.set(week, (weekAnalyses.get(week) ?? 0) + 1)
    }
  }
  const weekly: WeeklyCorrectionRate[] = [
    ...new Set([...weekCorrections.keys(), ...weekAnalyses.keys()]),
  ]
    .sort()
    .map((week) => {
      const corrections = weekCorrections.get(week) ?? 0
      const analyses = weekAnalyses.get(week) ?? 0
      return { week, corrections, analyses, rate: ratePer100(corrections, analyses) }
    })

  return {
    hasData: totalAnalyses > 0 || totalCorrections > 0,
    totalAnalyses,
    totalCorrections,
    correctedKeys: correctionsByKey.size,
    promotedKeys: firstPromotedAt.size,
    perKey,
    pooledCorrectionsBefore,
    pooledCorrectionsAfter,
    correctionsOnNeverPromoted,
    weekly,
  }
}

// --- Formatting ---

/**
 * Renders the effectiveness summary as markdown lines. Returns an empty array
 * when there is nothing recorded yet.
 */
export function formatEffectiveness(summary: EffectivenessSummary): string[] {
  if (!summary.hasData) return []

  const lines: string[] = []
  lines.push('# ToM Promotion Effectiveness')
  lines.push('')
  lines.push(
    `Exposure unit: analysis run (${summary.totalAnalyses} total). ` +
      'Rate = corrections per 100 analyses. Correction rate measures memory ' +
      'stability, not task usefulness.'
  )
  lines.push('')

  const promotedShare =
    summary.totalCorrections > 0
      ? Math.round(
          (summary.correctionsOnNeverPromoted / summary.totalCorrections) * 100
        )
      : 0
  lines.push('## Headline')
  lines.push(
    `- ${summary.correctionsOnNeverPromoted}/${summary.totalCorrections} corrections ` +
      `(${promotedShare}%) land on keys that were NEVER promoted — the promotion ` +
      'gate filters unstable inferences out before they reach CLAUDE.md.'
  )
  lines.push(
    `- Pooled across ${summary.perKey.length} promoted+corrected keys: ` +
      `${summary.pooledCorrectionsBefore} corrections before promotion, ` +
      `${summary.pooledCorrectionsAfter} after.`
  )
  lines.push('')

  if (summary.perKey.length > 0) {
    lines.push('## Per-key (corrections per 100 analyses, before → after promotion)')
    for (const k of summary.perKey) {
      const direction =
        k.rateAfter < k.rateBefore
          ? 'improved'
          : k.rateAfter > k.rateBefore
            ? 'worse'
            : 'flat'
      const thin = k.thinAfterWindow ? ' [thin after-window]' : ''
      lines.push(
        `- ${k.key} (promoted ${k.firstPromotedAt.slice(0, 10)}): ` +
          `${k.correctionsBefore}→${k.correctionsAfter} corrections, ` +
          `${k.rateBefore}→${k.rateAfter}/100 — ${direction}${thin}`
      )
    }
    lines.push('')
  }

  if (summary.weekly.length > 0) {
    lines.push('## Weekly correction rate (per 100 analyses)')
    for (const w of summary.weekly) {
      lines.push(
        `- ${w.week}: ${w.corrections} corrections / ${w.analyses} analyses = ${w.rate}`
      )
    }
    lines.push('')
  }

  return lines
}
