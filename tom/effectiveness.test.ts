import { describe, it, expect } from 'vitest'

import {
  computeEffectivenessSummary,
  formatEffectiveness,
  THIN_AFTER_WINDOW,
} from './effectiveness'
import type { UsageLogEntry } from './routing'

function entry(
  partial: Partial<UsageLogEntry> & { operation: string; timestamp: string }
): UsageLogEntry {
  return {
    model: 'none',
    tokenCount: 0,
    ...partial,
  }
}

function analysis(timestamp: string): UsageLogEntry {
  return entry({ operation: 'session-analysis', timestamp, detail: { path: 'llm' } })
}

function promotion(timestamp: string, ...keys: string[]): UsageLogEntry {
  return entry({ operation: 'preference-promotion', timestamp, detail: { promoted: keys } })
}

function correction(timestamp: string, ...keys: string[]): UsageLogEntry {
  return entry({
    operation: 'preference-correction',
    timestamp,
    detail: { corrections: keys },
  })
}

describe('computeEffectivenessSummary', () => {
  it('reports no data for an empty log', () => {
    const summary = computeEffectivenessSummary([])
    expect(summary.hasData).toBe(false)
    expect(summary.totalAnalyses).toBe(0)
    expect(summary.perKey).toEqual([])
  })

  it('splits corrections before and after the first promotion', () => {
    const entries = [
      analysis('2026-06-01T00:00:00.000Z'),
      correction('2026-06-02T00:00:00.000Z', 'codingPreferences:language'),
      analysis('2026-06-03T00:00:00.000Z'),
      promotion('2026-06-04T00:00:00.000Z', 'codingPreferences:language'),
      analysis('2026-06-05T00:00:00.000Z'),
      correction('2026-06-06T00:00:00.000Z', 'codingPreferences:language'),
    ]
    const summary = computeEffectivenessSummary(entries)
    expect(summary.perKey).toHaveLength(1)
    const k = summary.perKey[0]!
    expect(k.key).toBe('codingPreferences:language')
    expect(k.firstPromotedAt).toBe('2026-06-04T00:00:00.000Z')
    expect(k.correctionsBefore).toBe(1)
    expect(k.correctionsAfter).toBe(1)
    // 2 analyses before the promotion cutoff, 1 after.
    expect(k.analysesBefore).toBe(2)
    expect(k.analysesAfter).toBe(1)
    expect(k.rateBefore).toBe(50) // 1 / 2 * 100
    expect(k.rateAfter).toBe(100) // 1 / 1 * 100
  })

  it('uses the EARLIEST promotion as the cutoff when a key is re-promoted', () => {
    const entries = [
      promotion('2026-06-10T00:00:00.000Z', 'interactionStyle:x'),
      correction('2026-06-11T00:00:00.000Z', 'interactionStyle:x'),
      promotion('2026-06-12T00:00:00.000Z', 'interactionStyle:x'),
    ]
    const summary = computeEffectivenessSummary(entries)
    const k = summary.perKey[0]!
    expect(k.firstPromotedAt).toBe('2026-06-10T00:00:00.000Z')
    expect(k.promotionEvents).toBe(2)
    expect(k.correctionsBefore).toBe(0)
    expect(k.correctionsAfter).toBe(1)
  })

  it('counts corrections on never-promoted keys as the churn headline', () => {
    const entries = [
      analysis('2026-06-01T00:00:00.000Z'),
      correction('2026-06-02T00:00:00.000Z', 'codingPreferences:unstable'),
      correction('2026-06-03T00:00:00.000Z', 'codingPreferences:unstable'),
      promotion('2026-06-04T00:00:00.000Z', 'codingPreferences:stable'),
      correction('2026-06-05T00:00:00.000Z', 'codingPreferences:stable'),
    ]
    const summary = computeEffectivenessSummary(entries)
    expect(summary.totalCorrections).toBe(3)
    expect(summary.correctionsOnNeverPromoted).toBe(2)
    // Only 'stable' was both promoted and corrected, so only it appears per-key.
    expect(summary.perKey.map((k) => k.key)).toEqual(['codingPreferences:stable'])
  })

  it('excludes promoted keys that were never corrected from perKey', () => {
    const entries = [
      analysis('2026-06-01T00:00:00.000Z'),
      promotion('2026-06-02T00:00:00.000Z', 'interactionStyle:clean'),
    ]
    const summary = computeEffectivenessSummary(entries)
    expect(summary.promotedKeys).toBe(1)
    expect(summary.perKey).toEqual([])
  })

  it('flags a thin after-window', () => {
    const before = Array.from({ length: 40 }, (_, i) =>
      analysis(`2026-06-0${1}T00:00:${String(i).padStart(2, '0')}.000Z`)
    )
    const entries = [
      ...before,
      promotion('2026-06-02T00:00:00.000Z', 'codingPreferences:late'),
      correction('2026-06-01T00:00:30.000Z', 'codingPreferences:late'),
      analysis('2026-06-03T00:00:00.000Z'), // only 1 analysis after
    ]
    const summary = computeEffectivenessSummary(entries)
    const k = summary.perKey[0]!
    expect(k.analysesAfter).toBeLessThan(THIN_AFTER_WINDOW)
    expect(k.thinAfterWindow).toBe(true)
  })

  it('rolls corrections and analyses up by ISO week', () => {
    const entries = [
      analysis('2026-07-06T00:00:00.000Z'), // Monday of W28
      analysis('2026-07-07T00:00:00.000Z'),
      correction('2026-07-08T00:00:00.000Z', 'a:b', 'c:d'),
    ]
    const summary = computeEffectivenessSummary(entries)
    const w28 = summary.weekly.find((w) => w.week === '2026-W28')
    expect(w28).toBeDefined()
    expect(w28!.analyses).toBe(2)
    expect(w28!.corrections).toBe(2)
    expect(w28!.rate).toBe(100) // 2 corrections / 2 analyses * 100
  })

  it('counts fallback analyses in the exposure denominator', () => {
    const entries = [
      analysis('2026-06-01T00:00:00.000Z'),
      entry({ operation: 'session-analysis-fallback', timestamp: '2026-06-02T00:00:00.000Z' }),
    ]
    const summary = computeEffectivenessSummary(entries)
    expect(summary.totalAnalyses).toBe(2)
  })

  it('ignores entries with missing timestamps', () => {
    const entries = [
      entry({ operation: 'session-analysis', timestamp: '' }),
      analysis('2026-06-01T00:00:00.000Z'),
    ]
    const summary = computeEffectivenessSummary(entries)
    expect(summary.totalAnalyses).toBe(1)
  })
})

describe('formatEffectiveness', () => {
  it('returns no lines when there is no data', () => {
    expect(formatEffectiveness(computeEffectivenessSummary([]))).toEqual([])
  })

  it('renders the headline and per-key sections', () => {
    const entries = [
      analysis('2026-06-01T00:00:00.000Z'),
      correction('2026-06-02T00:00:00.000Z', 'codingPreferences:language'),
      promotion('2026-06-03T00:00:00.000Z', 'codingPreferences:language'),
      correction('2026-06-04T00:00:00.000Z', 'codingPreferences:churny'),
    ]
    const lines = formatEffectiveness(computeEffectivenessSummary(entries))
    const text = lines.join('\n')
    expect(text).toContain('# ToM Promotion Effectiveness')
    expect(text).toContain('NEVER promoted')
    expect(text).toContain('codingPreferences:language')
  })
})
