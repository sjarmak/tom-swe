/**
 * Telemetry rollup over usage.log entries.
 *
 * Pure aggregation — no I/O. Consumers (the /tom-status skill, the external
 * mem eval harness, future analysis agents) read the log via readUsageLog()
 * in routing.ts and pass the entries here.
 */

import type { UsageLogEntry } from './routing.js'

// --- Types ---

/** llm/fallback counts within a trailing time window. */
export interface WindowedAnalysisCounts {
  readonly llmRuns: number
  readonly fallbackRuns: number
}

/**
 * Vocabulary-anchoring echo rollup: how much of what the analyzer returns is a
 * verbatim echo of the injected vocabulary. A baseline to evaluate any future
 * anti-anchoring prompt change against — not a control input.
 */
export interface VocabularyEchoTelemetry {
  /** Successful analyses that had vocabulary injected. */
  readonly analyses: number
  readonly injectedTotal: number
  readonly returnedTotal: number
  readonly echoedKeyValueTotal: number
  readonly echoedKeyTotal: number
  /** echoedKeyValueTotal / returnedTotal, as a percentage (null if no returns). */
  readonly keyValueEchoRate: number | null
  /** echoedKeyTotal / returnedTotal, as a percentage (null if no returns). */
  readonly keyEchoRate: number | null
}

export interface AnalysisTelemetry {
  readonly llmRuns: number
  readonly fallbackRuns: number
  readonly fallbackReasons: Readonly<Record<string, number>>
  /** Duration stats for successful LLM analyses only — pooling them with
   * timeout fallbacks (fixed ~90s each) described neither population. */
  readonly avgDurationMs: number | null
  readonly maxDurationMs: number | null
  /** Average duration of fallback runs (dominated by the timeout ceiling). */
  readonly fallbackAvgDurationMs: number | null
  readonly totalTokens: number
  /** Trailing windows so a fixed historical cluster can't mask (or fake) a
   * live regression — the lifetime rate once read 19% while live was 1%. */
  readonly last24h: WindowedAnalysisCounts
  readonly last7d: WindowedAnalysisCounts
  readonly vocabularyEcho: VocabularyEchoTelemetry
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
   * ToM tokens (headless analysis spawns) over host-session input+output
   * tokens, as a percentage. The denominator dedupes the
   * per-fire cumulative session-usage entries by session (last wins).
   * Unweighted by per-model pricing — cache buckets are excluded; consumers
   * needing cost-true overhead should weight the raw buckets themselves.
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
  invalidLines: number = 0,
  now: Date = new Date()
): TelemetrySummary {
  const byOp = (op: string): UsageLogEntry[] =>
    entries.filter((e) => e.operation === op)

  const llm = byOp('session-analysis')
  const fallback = byOp('session-analysis-fallback')
  const llmDurations = durations(llm)
  const fallbackDurations = durations(fallback)

  const windowCounts = (windowMs: number): WindowedAnalysisCounts => {
    const cutoff = new Date(now.getTime() - windowMs).toISOString()
    return {
      llmRuns: llm.filter((e) => e.timestamp >= cutoff).length,
      fallbackRuns: fallback.filter((e) => e.timestamp >= cutoff).length,
    }
  }

  const echoEntries = byOp('analysis-vocabulary-echo')
  const echoSum = (key: string): number =>
    echoEntries.reduce((sum, e) => sum + (detailNumber(e, key) ?? 0), 0)
  const echoReturnedTotal = echoSum('returned')
  const echoedKeyValueTotal = echoSum('echoedKeyValue')
  const echoedKeyTotal = echoSum('echoedKey')
  // One decimal place; null when there is nothing to divide by.
  const echoRate = (n: number): number | null =>
    echoReturnedTotal > 0 ? Math.round((n / echoReturnedTotal) * 1000) / 10 : null

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

  // session-usage entries hold CUMULATIVE transcript totals and are logged
  // once per Stop FIRE, not per session (max 99 for one session on this
  // rig): summing them inflated the host-token denominator ~5x, flattering
  // the overhead metric. Dedupe by session — the last entry carries the
  // session's final totals.
  const usageBySession = new Map<string, UsageLogEntry>()
  for (const e of byOp('session-usage')) {
    usageBySession.set(e.sessionId ?? '', e)
  }
  const usageEntries = [...usageBySession.values()]
  const sumDetail = (key: string): number =>
    usageEntries.reduce((sum, e) => sum + (detailNumber(e, key) ?? 0), 0)
  const hostInOut = sumDetail('inputTokens') + sumDetail('outputTokens')
  // Numerator covers every headless spawn (session-analysis).
  const tomTokens = llm.reduce((sum, e) => sum + e.tokenCount, 0)

  return {
    totalEntries: entries.length,
    invalidLines,
    analysis: {
      llmRuns: llm.length,
      fallbackRuns: fallback.length,
      fallbackReasons: countByDetailString(fallback, 'failure'),
      avgDurationMs: average(llmDurations),
      maxDurationMs: llmDurations.length > 0 ? Math.max(...llmDurations) : null,
      fallbackAvgDurationMs: average(fallbackDurations),
      totalTokens: llm.reduce((sum, e) => sum + e.tokenCount, 0),
      last24h: windowCounts(24 * 60 * 60 * 1000),
      last7d: windowCounts(7 * 24 * 60 * 60 * 1000),
      vocabularyEcho: {
        analyses: echoEntries.length,
        injectedTotal: echoSum('injected'),
        returnedTotal: echoReturnedTotal,
        echoedKeyValueTotal,
        echoedKeyTotal,
        keyValueEchoRate: echoRate(echoedKeyValueTotal),
        keyEchoRate: echoRate(echoedKeyTotal),
      },
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
    const rate = (w: WindowedAnalysisCounts): string => {
      const total = w.llmRuns + w.fallbackRuns
      if (total === 0) return 'no runs'
      return `${w.llmRuns} LLM / ${w.fallbackRuns} fallback (${Math.round((w.fallbackRuns / total) * 100)}%)`
    }
    const fallbackPercent = Math.round((a.fallbackRuns / analysisRuns) * 100)
    const reasonList = Object.entries(a.fallbackReasons)
      .map(([reason, count]) => `${reason}×${count}`)
      .join(', ')
    lines.push(
      `- Session analysis (lifetime): ${a.llmRuns} LLM / ${a.fallbackRuns} fallback (${fallbackPercent}%)` +
        (reasonList ? ` [${reasonList}]` : '')
    )
    lines.push(`- Session analysis (24h): ${rate(a.last24h)}; (7d): ${rate(a.last7d)}`)
    if (a.avgDurationMs !== null || a.fallbackAvgDurationMs !== null) {
      const llmPart =
        a.avgDurationMs !== null
          ? `LLM avg ${a.avgDurationMs}ms, max ${a.maxDurationMs}ms`
          : 'no successful LLM runs'
      const fallbackPart =
        a.fallbackAvgDurationMs !== null ? `; fallback avg ${a.fallbackAvgDurationMs}ms` : ''
      lines.push(
        `- Analysis duration: ${llmPart}${fallbackPart}; total tokens: ${a.totalTokens}`
      )
    }
    const ve = a.vocabularyEcho
    if (ve.analyses > 0) {
      lines.push(
        `- Vocabulary anchoring: ${ve.analyses} analyses; ` +
          `${ve.echoedKeyValueTotal}/${ve.returnedTotal} returned prefs echo injected vocab ` +
          `(${ve.keyValueEchoRate ?? '?'}% key+value, ${ve.keyEchoRate ?? '?'}% key)`
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
      `- Host sessions: ${u.sessions} distinct measured; in ${u.inputTokens} / out ${u.outputTokens} (cache: +${u.cacheCreationTokens} created, ${u.cacheReadTokens} read)`
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
  if (summary.analysisErrors > 0) {
    lines.push(`- Errors: ${summary.analysisErrors} analysis`)
  }

  lines.push('')
  return lines
}
