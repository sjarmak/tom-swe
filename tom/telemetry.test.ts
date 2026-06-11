import { describe, it, expect } from 'vitest'

import { computeTelemetrySummary, formatTelemetry } from './telemetry'
import type { UsageLogEntry } from './routing'

function entry(partial: Partial<UsageLogEntry> & { operation: string }): UsageLogEntry {
  return {
    timestamp: '2026-06-10T12:00:00.000Z',
    model: 'none',
    tokenCount: 0,
    ...partial,
  }
}

describe('computeTelemetrySummary', () => {
  it('returns an all-zero summary for no entries', () => {
    const summary = computeTelemetrySummary([])
    expect(summary.totalEntries).toBe(0)
    expect(summary.analysis.llmRuns).toBe(0)
    expect(summary.promptHook.p50DurationMs).toBeNull()
    expect(summary.consultations.avgScore).toBeNull()
    expect(summary.sessionStartInjections.avgChars).toBeNull()
  })

  it('aggregates analysis runs, durations, tokens, and fallback reasons', () => {
    const summary = computeTelemetrySummary([
      entry({
        operation: 'session-analysis',
        model: 'haiku',
        tokenCount: 1200,
        durationMs: 8000,
        detail: { path: 'llm' },
      }),
      entry({
        operation: 'session-analysis',
        model: 'haiku',
        tokenCount: 800,
        durationMs: 6000,
        detail: { path: 'llm' },
      }),
      entry({
        operation: 'session-analysis-fallback',
        durationMs: 45000,
        detail: { path: 'heuristic', failure: 'timeout' },
      }),
    ])

    expect(summary.analysis.llmRuns).toBe(2)
    expect(summary.analysis.fallbackRuns).toBe(1)
    expect(summary.analysis.fallbackReasons).toEqual({ timeout: 1 })
    expect(summary.analysis.totalTokens).toBe(2000)
    expect(summary.analysis.avgDurationMs).toBe(Math.round((8000 + 6000 + 45000) / 3))
    expect(summary.analysis.maxDurationMs).toBe(45000)
  })

  it('computes prompt-hook latency percentiles', () => {
    const summary = computeTelemetrySummary([
      entry({ operation: 'prompt-hook', durationMs: 10 }),
      entry({ operation: 'prompt-hook', durationMs: 30 }),
      entry({ operation: 'prompt-hook', durationMs: 500 }),
    ])
    expect(summary.promptHook.count).toBe(3)
    expect(summary.promptHook.p50DurationMs).toBe(30)
    expect(summary.promptHook.maxDurationMs).toBe(500)
  })

  it('aggregates consultations by source with average score', () => {
    const summary = computeTelemetrySummary([
      entry({
        operation: 'ambiguity-consultation',
        detail: { score: 0.6, source: 'bm25', suggestionType: 'style' },
      }),
      entry({
        operation: 'ambiguity-consultation',
        detail: { score: 0.4, source: 'none', suggestionType: null },
      }),
    ])
    expect(summary.consultations.count).toBe(2)
    expect(summary.consultations.injected).toBe(1)
    expect(summary.consultations.bySource).toEqual({ bm25: 1, none: 1 })
    expect(summary.consultations.avgScore).toBe(0.5)
  })

  it('counts corrections and promotions by key totals', () => {
    const summary = computeTelemetrySummary([
      entry({
        operation: 'preference-correction',
        detail: { corrections: ['a:b', 'c:d'], penalty: 0.5 },
      }),
      entry({
        operation: 'preference-promotion',
        detail: { promoted: ['a:b'], targets: ['/tmp/CLAUDE.md'] },
      }),
      entry({ operation: 'promotion-error', reason: 'boom' }),
    ])
    expect(summary.correctionBatches).toBe(1)
    expect(summary.correctionKeys).toBe(2)
    expect(summary.promotionEvents).toBe(1)
    expect(summary.promotionKeys).toBe(1)
    expect(summary.promotionErrors).toBe(1)
  })

  it('aggregates host-session usage and computes the ToM token share', () => {
    const summary = computeTelemetrySummary([
      entry({
        operation: 'session-usage',
        detail: {
          inputTokens: 8000,
          outputTokens: 2000,
          cacheCreationTokens: 500,
          cacheReadTokens: 90000,
          assistantMessages: 12,
        },
      }),
      entry({
        operation: 'session-usage',
        detail: {
          inputTokens: 4000,
          outputTokens: 1000,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          assistantMessages: 3,
        },
      }),
      entry({
        operation: 'session-analysis',
        model: 'haiku',
        tokenCount: 1500,
        detail: { path: 'llm' },
      }),
    ])

    expect(summary.sessionUsage.sessions).toBe(2)
    expect(summary.sessionUsage.inputTokens).toBe(12000)
    expect(summary.sessionUsage.outputTokens).toBe(3000)
    expect(summary.sessionUsage.cacheReadTokens).toBe(90000)
    // 1500 ToM tokens / 15000 host in+out = 10%
    expect(summary.sessionUsage.tomShareOfInOutPercent).toBe(10)
  })

  it('leaves the ToM share null when no host usage is recorded', () => {
    const summary = computeTelemetrySummary([
      entry({
        operation: 'session-analysis',
        model: 'haiku',
        tokenCount: 1500,
        detail: { path: 'llm' },
      }),
    ])
    expect(summary.sessionUsage.sessions).toBe(0)
    expect(summary.sessionUsage.tomShareOfInOutPercent).toBeNull()
  })

  it('aggregates session-start injection volume', () => {
    const summary = computeTelemetrySummary([
      entry({
        operation: 'session-start-injection',
        detail: { chars: 200, lines: 8, preferences: 5 },
      }),
      entry({
        operation: 'session-start-injection',
        detail: { chars: 400, lines: 10, preferences: 7 },
      }),
    ])
    expect(summary.sessionStartInjections.count).toBe(2)
    expect(summary.sessionStartInjections.avgChars).toBe(300)
  })
})

describe('formatTelemetry', () => {
  it('returns no lines when nothing is recorded', () => {
    expect(formatTelemetry(computeTelemetrySummary([]))).toEqual([])
  })

  it('renders a markdown section with the recorded aggregates', () => {
    const lines = formatTelemetry(
      computeTelemetrySummary([
        entry({
          operation: 'session-analysis',
          model: 'haiku',
          tokenCount: 500,
          durationMs: 7000,
          detail: { path: 'llm' },
        }),
        entry({
          operation: 'session-analysis-fallback',
          durationMs: 100,
          detail: { path: 'heuristic', failure: 'spawn-error' },
        }),
        entry({ operation: 'prompt-hook', durationMs: 25 }),
      ])
    )

    const text = lines.join('\n')
    expect(text).toContain('## Telemetry (usage.log)')
    expect(text).toContain('1 LLM / 1 fallback (50%)')
    expect(text).toContain('spawn-error×1')
    expect(text).toContain('p50 25ms')
  })

  it('reports skipped invalid lines', () => {
    const lines = formatTelemetry(
      computeTelemetrySummary([entry({ operation: 'prompt-hook' })], 3)
    )
    expect(lines.join('\n')).toContain('3 invalid lines skipped')
  })
})
