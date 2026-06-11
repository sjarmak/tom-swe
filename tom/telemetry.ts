/**
 * Telemetry rollup over usage.log entries.
 *
 * Pure aggregation — no I/O. Consumers (the /tom-status skill, the external
 * mem eval harness, future analysis agents) read the log via readUsageLog()
 * in routing.ts and pass the entries here.
 */

import type { UsageLogEntry } from './routing.js'

// --- Types ---

export interface AnalysisTelemetry {
  readonly llmRuns: number
  readonly fallbackRuns: number
  readonly fallbackReasons: Readonly<Record<string, number>>
  readonly avgDurationMs: number | null
  readonly maxDurationMs: number | null
  readonly totalTokens: number
}

export interface PromptHookTelemetry {
  readonly count: number
  readonly p50DurationMs: number | null
  readonly maxDurationMs: number | null
}

export interface ConsultationTelemetry {
  readonly count: number
  readonly injected: number
  readonly bySource: Readonly<Record<string, number>>
  readonly avgScore: number | null
}

export interface InjectionTelemetry {
  readonly count: number
  readonly avgChars: number | null
}

export interface SessionUsageTelemetry {
  readonly sessions: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheCreationTokens: number
  readonly cacheReadTokens: number
  /**
   * ToM analysis tokens over host-session input+output tokens, as a
   * percentage. Unweighted by per-model pricing — cache buckets are
   * excluded from the denominator; consumers needing cost-true overhead
   * should weight the raw buckets themselves.
   */
  readonly tomShareOfInOutPercent: number | null
}

export interface TelemetrySummary {
  readonly totalEntries: number
  readonly invalidLines: number
  readonly analysis: AnalysisTelemetry
  readonly promptHook: PromptHookTelemetry
  readonly consultations: ConsultationTelemetry
  readonly sessionStartInjections: InjectionTelemetry
  readonly sessionUsage: SessionUsageTelemetry
  readonly correctionBatches: number
  readonly correctionKeys: number
  readonly promotionEvents: number
  readonly promotionKeys: number
  readonly promotionErrors: number
  readonly analysisErrors: number
}

// --- Helpers ---

function durations(entries: readonly UsageLogEntry[]): number[] {
  return entries
    .map((e) => e.durationMs)
    .filter((d): d is number => typeof d === 'number')
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length)
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const lower = sorted[mid - 1] ?? 0
  const upper = sorted[mid] ?? 0
  return sorted.length % 2 === 0 ? Math.round((lower + upper) / 2) : upper
}

function detailNumber(entry: UsageLogEntry, key: string): number | null {
  const value = entry.detail?.[key]
  return typeof value === 'number' ? value : null
}

function detailArrayLength(entry: UsageLogEntry, key: string): number {
  const value = entry.detail?.[key]
  return Array.isArray(value) ? value.length : 0
}

function countByDetailString(
  entries: readonly UsageLogEntry[],
  key: string
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const entry of entries) {
    const value = entry.detail?.[key]
    if (typeof value === 'string') {
      counts[value] = (counts[value] ?? 0) + 1
    }
  }
  return counts
}

// --- Aggregation ---

export function computeTelemetrySummary(
  entries: readonly UsageLogEntry[],
  invalidLines: number = 0
): TelemetrySummary {
  const byOp = (op: string): UsageLogEntry[] =>
    entries.filter((e) => e.operation === op)

  const llm = byOp('session-analysis')
  const fallback = byOp('session-analysis-fallback')
  const analysisDurations = durations([...llm, ...fallback])

  const promptHook = byOp('prompt-hook')
  const promptDurations = durations(promptHook)

  const consultations = byOp('ambiguity-consultation')
  const consultScores = consultations
    .map((e) => detailNumber(e, 'score'))
    .filter((s): s is number => s !== null)

  const injections = byOp('session-start-injection')
  const injectionChars = injections
    .map((e) => detailNumber(e, 'chars'))
    .filter((c): c is number => c !== null)

  const corrections = byOp('preference-correction')
  const promotions = byOp('preference-promotion')

  const usageEntries = byOp('session-usage')
  const sumDetail = (key: string): number =>
    usageEntries.reduce((sum, e) => sum + (detailNumber(e, key) ?? 0), 0)
  const hostInOut = sumDetail('inputTokens') + sumDetail('outputTokens')
  const tomTokens = llm.reduce((sum, e) => sum + e.tokenCount, 0)

  return {
    totalEntries: entries.length,
    invalidLines,
    analysis: {
      llmRuns: llm.length,
      fallbackRuns: fallback.length,
      fallbackReasons: countByDetailString(fallback, 'failure'),
      avgDurationMs: average(analysisDurations),
      maxDurationMs:
        analysisDurations.length > 0 ? Math.max(...analysisDurations) : null,
      totalTokens: llm.reduce((sum, e) => sum + e.tokenCount, 0),
    },
    promptHook: {
      count: promptHook.length,
      p50DurationMs: median(promptDurations),
      maxDurationMs:
        promptDurations.length > 0 ? Math.max(...promptDurations) : null,
    },
    consultations: {
      count: consultations.length,
      injected: consultations.filter(
        (e) => e.detail?.['suggestionType'] != null
      ).length,
      bySource: countByDetailString(consultations, 'source'),
      avgScore:
        consultScores.length > 0
          ? Math.round(average(consultScores.map((s) => s * 100)) ?? 0) / 100
          : null,
    },
    sessionStartInjections: {
      count: injections.length,
      avgChars: average(injectionChars),
    },
    sessionUsage: {
      sessions: usageEntries.length,
      inputTokens: sumDetail('inputTokens'),
      outputTokens: sumDetail('outputTokens'),
      cacheCreationTokens: sumDetail('cacheCreationTokens'),
      cacheReadTokens: sumDetail('cacheReadTokens'),
      tomShareOfInOutPercent:
        hostInOut > 0
          ? Math.round((tomTokens / hostInOut) * 1000) / 10
          : null,
    },
    correctionBatches: corrections.length,
    correctionKeys: corrections.reduce(
      (sum, e) => sum + detailArrayLength(e, 'corrections'),
      0
    ),
    promotionEvents: promotions.length,
    promotionKeys: promotions.reduce(
      (sum, e) => sum + detailArrayLength(e, 'promoted'),
      0
    ),
    promotionErrors: byOp('promotion-error').length,
    analysisErrors: byOp('session-analysis-error').length,
  }
}

// --- Formatting ---

/**
 * Renders the summary as markdown lines for /tom-status. Returns an empty
 * array when there is nothing recorded yet (section omitted).
 */
export function formatTelemetry(summary: TelemetrySummary): string[] {
  if (summary.totalEntries === 0) {
    return []
  }

  const lines: string[] = []
  lines.push('## Telemetry (usage.log)')
  lines.push(`- Entries: ${summary.totalEntries}` +
    (summary.invalidLines > 0 ? ` (${summary.invalidLines} invalid lines skipped)` : ''))

  const a = summary.analysis
  const analysisRuns = a.llmRuns + a.fallbackRuns
  if (analysisRuns > 0) {
    const fallbackPercent = Math.round((a.fallbackRuns / analysisRuns) * 100)
    const reasonList = Object.entries(a.fallbackReasons)
      .map(([reason, count]) => `${reason}×${count}`)
      .join(', ')
    lines.push(
      `- Session analysis: ${a.llmRuns} LLM / ${a.fallbackRuns} fallback (${fallbackPercent}%)` +
        (reasonList ? ` [${reasonList}]` : '')
    )
    if (a.avgDurationMs !== null) {
      lines.push(
        `- Analysis duration: avg ${a.avgDurationMs}ms, max ${a.maxDurationMs}ms; total tokens: ${a.totalTokens}`
      )
    }
  }

  if (summary.promptHook.count > 0) {
    lines.push(
      `- Prompt hook: ${summary.promptHook.count} prompts, p50 ${summary.promptHook.p50DurationMs}ms, max ${summary.promptHook.maxDurationMs}ms`
    )
  }

  const c = summary.consultations
  if (c.count > 0) {
    const sourceList = Object.entries(c.bySource)
      .map(([source, count]) => `${source}×${count}`)
      .join(', ')
    lines.push(
      `- Consultations: ${c.count} (${c.injected} injected; avg score ${c.avgScore ?? '?'})` +
        (sourceList ? ` [${sourceList}]` : '')
    )
  }

  if (summary.sessionStartInjections.count > 0) {
    lines.push(
      `- SessionStart injections: ${summary.sessionStartInjections.count}, avg ${summary.sessionStartInjections.avgChars} chars`
    )
  }

  const u = summary.sessionUsage
  if (u.sessions > 0) {
    lines.push(
      `- Host sessions: ${u.sessions} measured; in ${u.inputTokens} / out ${u.outputTokens} (cache: +${u.cacheCreationTokens} created, ${u.cacheReadTokens} read)`
    )
    if (u.tomShareOfInOutPercent !== null) {
      lines.push(
        `- ToM token share: ${u.tomShareOfInOutPercent}% of host in+out (unweighted; cache excluded)`
      )
    }
  }

  if (summary.correctionBatches > 0) {
    lines.push(
      `- Corrections: ${summary.correctionKeys} across ${summary.correctionBatches} sessions`
    )
  }
  if (summary.promotionEvents > 0) {
    lines.push(
      `- Promotions: ${summary.promotionKeys} across ${summary.promotionEvents} events`
    )
  }
  if (summary.promotionErrors > 0 || summary.analysisErrors > 0) {
    lines.push(
      `- Errors: ${summary.analysisErrors} analysis, ${summary.promotionErrors} promotion`
    )
  }

  lines.push('')
  return lines
}
