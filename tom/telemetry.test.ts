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
    // Durations split by outcome: pooling ~90s timeout fallbacks with
    // successful runs described neither population.
    expect(summary.analysis.avgDurationMs).toBe(7000)
    expect(summary.analysis.maxDurationMs).toBe(8000)
    expect(summary.analysis.fallbackAvgDurationMs).toBe(45000)
  })

  it('windows analysis counts so historical clusters cannot mask live rates', () => {
    const now = new Date('2026-06-20T12:00:00.000Z')
    const summary = computeTelemetrySummary(
      [
        // Historical fallback cluster, 9 days old: lifetime-only.
        entry({
          operation: 'session-analysis-fallback',
          timestamp: '2026-06-11T12:00:00.000Z',
          detail: { path: 'heuristic', failure: 'timeout' },
        }),
        // Recent success within 24h.
        entry({
          operation: 'session-analysis',
          timestamp: '2026-06-20T08:00:00.000Z',
          model: 'haiku',
          detail: { path: 'llm' },
        }),
        // Success 3 days old: 7d window only.
        entry({
          operation: 'session-analysis',
          timestamp: '2026-06-17T12:00:00.000Z',
          model: 'haiku',
          detail: { path: 'llm' },
        }),
      ],
      0,
      now
    )

    expect(summary.analysis.last24h).toEqual({ llmRuns: 1, fallbackRuns: 0 })
    expect(summary.analysis.last7d).toEqual({ llmRuns: 2, fallbackRuns: 0 })
    expect(summary.analysis.fallbackRuns).toBe(1)
  })

  it('counts derivability-gate spawns and includes their tokens in the ToM share', () => {
    const summary = computeTelemetrySummary([
      entry({
        operation: 'derivability-gate',
        model: 'haiku',
        tokenCount: 700,
        detail: { outcome: 'ok', candidates: 2, passed: 1 },
      }),
      entry({
        operation: 'derivability-gate',
        model: 'haiku',
        tokenCount: 0,
        detail: { outcome: 'unavailable', candidates: 1 },
      }),
      entry({
        operation: 'session-usage',
        sessionId: 's1',
        detail: { inputTokens: 6000, outputTokens: 1000 },
      }),
    ])

    expect(summary.gate.count).toBe(2)
    expect(summary.gate.okCount).toBe(1)
    expect(summary.gate.unavailableCount).toBe(1)
    expect(summary.gate.totalTokens).toBe(700)
    // 700 gate tokens / 7000 host in+out = 10%
    expect(summary.sessionUsage.tomShareOfInOutPercent).toBe(10)
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
        sessionId: 'session-a',
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
        sessionId: 'session-b',
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

  it('dedupes per-fire session-usage entries by session, last entry wins', () => {
    // Entries are logged once per Stop FIRE with cumulative totals (one
    // session logged 99 of them); summing inflated the denominator ~5x.
    const summary = computeTelemetrySummary([
      entry({
        operation: 'session-usage',
        sessionId: 'session-a',
        timestamp: '2026-06-10T10:00:00.000Z',
        detail: { inputTokens: 1000, outputTokens: 200 },
      }),
      entry({
        operation: 'session-usage',
        sessionId: 'session-a',
        timestamp: '2026-06-10T11:00:00.000Z',
        detail: { inputTokens: 5000, outputTokens: 900 },
      }),
    ])

    expect(summary.sessionUsage.sessions).toBe(1)
    expect(summary.sessionUsage.inputTokens).toBe(5000)
    expect(summary.sessionUsage.outputTokens).toBe(900)
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
