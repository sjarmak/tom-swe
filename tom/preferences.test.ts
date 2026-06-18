import { describe, it, expect } from 'vitest'
import {
  reinforcePreference,
  decayPreferences,
  applyCorrections,
  resolveConflicts,
  DEFAULT_CORRECTION_PENALTY,
  type PreferenceCategory,
} from './preferences.js'
import type { Correction, PreferenceCluster } from './schemas.js'

function makePreference(
  overrides: Partial<PreferenceCluster> = {}
): PreferenceCluster {
  return {
    category: 'codingPreferences',
    key: 'language',
    value: 'TypeScript',
    confidence: 0.5,
    lastUpdated: '2026-01-15T00:00:00.000Z',
    sessionCount: 3,
    ...overrides,
  }
}

describe('reinforcePreference', () => {
  it('increases confidence by 0.1 for matching preference', () => {
    const existing = [makePreference({ confidence: 0.5 })]
    const observation = {
      category: 'codingPreferences' as PreferenceCategory,
      key: 'language',
      value: 'TypeScript',
    }
    const result = reinforcePreference(existing, observation)
    expect(result[0]?.confidence).toBeCloseTo(0.6)
  })

  it('caps confidence at 1.0', () => {
    const existing = [makePreference({ confidence: 0.95 })]
    const observation = {
      category: 'codingPreferences' as PreferenceCategory,
      key: 'language',
      value: 'TypeScript',
    }
    const result = reinforcePreference(existing, observation)
    expect(result[0]?.confidence).toBe(1.0)
  })

  it('increments sessionCount on reinforcement', () => {
    const existing = [makePreference({ sessionCount: 3 })]
    const observation = {
      category: 'codingPreferences' as PreferenceCategory,
      key: 'language',
      value: 'TypeScript',
    }
    const result = reinforcePreference(existing, observation)
    expect(result[0]?.sessionCount).toBe(4)
  })

  it('updates lastUpdated on reinforcement', () => {
    const existing = [makePreference({ lastUpdated: '2026-01-01T00:00:00.000Z' })]
    const observation = {
      category: 'codingPreferences' as PreferenceCategory,
      key: 'language',
      value: 'TypeScript',
    }
    const before = new Date().toISOString()
    const result = reinforcePreference(existing, observation)
    const updated = result[0]?.lastUpdated ?? ''
    expect(updated >= before).toBe(true)
  })

  it('adds new preference with confidence 0.1 if not found', () => {
    const existing = [makePreference()]
    const observation = {
      category: 'codingPreferences' as PreferenceCategory,
      key: 'testingApproach',
      value: 'TDD',
    }
    const result = reinforcePreference(existing, observation)
    expect(result).toHaveLength(2)
    const added = result.find((p) => p.key === 'testingApproach')
    expect(added?.confidence).toBeCloseTo(0.1)
    expect(added?.sessionCount).toBe(1)
  })

  it('does not mutate the original array', () => {
    const existing = [makePreference({ confidence: 0.5 })]
    const observation = {
      category: 'codingPreferences' as PreferenceCategory,
      key: 'language',
      value: 'TypeScript',
    }
    const result = reinforcePreference(existing, observation)
    expect(result).not.toBe(existing)
    expect(existing[0]?.confidence).toBe(0.5)
  })

  it('merges a reworded value into the existing category+key cluster (accumulates, not resets)', () => {
    const existing = [
      makePreference({ value: 'prefers TypeScript', confidence: 0.8, sessionCount: 4 }),
    ]
    const observation = {
      category: 'codingPreferences' as PreferenceCategory,
      key: 'language',
      value: 'likes TypeScript', // same observation, reworded
    }
    const result = reinforcePreference(existing, observation)

    // One cluster per category+key — the reword does not spawn a fresh cluster.
    const langPrefs = result.filter(
      (p) => p.category === 'codingPreferences' && p.key === 'language'
    )
    expect(langPrefs).toHaveLength(1)
    // Confidence accumulates rather than resetting to INITIAL_CONFIDENCE.
    expect(langPrefs[0]?.confidence).toBeCloseTo(0.9)
    expect(langPrefs[0]?.sessionCount).toBe(5)
    // Latest wording is retained.
    expect(langPrefs[0]?.value).toBe('likes TypeScript')
  })

  it('accumulates confidence and sessionCount across N reworded observations', () => {
    const wordings = [
      'prefers TypeScript',
      'likes TypeScript',
      'wants TS',
      'TypeScript please',
      'use TypeScript',
    ]
    let prefs: readonly PreferenceCluster[] = []
    for (const value of wordings) {
      prefs = reinforcePreference(prefs, {
        category: 'codingPreferences' as PreferenceCategory,
        key: 'language',
        value,
      })
    }

    expect(prefs).toHaveLength(1)
    const pref = prefs[0]
    // N=5: 0.1 initial + 4 increments of 0.1 = 0.5, monotonic up from INITIAL.
    expect(pref?.sessionCount).toBe(5)
    expect(pref?.confidence).toBeCloseTo(0.5)
    expect(pref?.confidence).toBeGreaterThan(0.1)
    // Latest wording retained.
    expect(pref?.value).toBe('use TypeScript')
  })
})

describe('decayPreferences', () => {
  it('applies exponential decay based on half-life', () => {
    const now = new Date('2026-02-15T00:00:00.000Z')
    const prefs = [
      makePreference({
        confidence: 1.0,
        lastUpdated: '2026-01-15T00:00:00.000Z', // 31 days ago
      }),
    ]
    // With decayDays=30 (half-life), confidence should be roughly halved
    const result = decayPreferences(prefs, 30, now)
    expect(result[0]?.confidence).toBeGreaterThan(0.4)
    expect(result[0]?.confidence).toBeLessThan(0.6)
  })

  it('does not decay recent preferences significantly', () => {
    const now = new Date('2026-01-16T00:00:00.000Z')
    const prefs = [
      makePreference({
        confidence: 0.8,
        lastUpdated: '2026-01-15T00:00:00.000Z', // 1 day ago
      }),
    ]
    const result = decayPreferences(prefs, 30, now)
    expect(result[0]?.confidence).toBeGreaterThan(0.75)
  })

  it('removes preferences that decay below 0.01', () => {
    const now = new Date('2027-01-01T00:00:00.000Z')
    const prefs = [
      makePreference({
        confidence: 0.1,
        lastUpdated: '2026-01-01T00:00:00.000Z', // ~365 days ago
      }),
    ]
    const result = decayPreferences(prefs, 30, now)
    expect(result).toHaveLength(0)
  })

  it('does not mutate the original array', () => {
    const now = new Date('2026-02-15T00:00:00.000Z')
    const prefs = [makePreference({ confidence: 1.0 })]
    const result = decayPreferences(prefs, 30, now)
    expect(result).not.toBe(prefs)
    expect(prefs[0]?.confidence).toBe(1.0)
  })
})

describe('applyCorrections', () => {
  function makeCorrection(overrides: Partial<Correction> = {}): Correction {
    return {
      category: 'codingPreferences',
      key: 'language',
      evidence: 'user re-edited the change away',
      ...overrides,
    }
  }

  it('multiplies confidence by the penalty factor for matching category+key', () => {
    const prefs = [makePreference({ confidence: 0.8 })]
    const result = applyCorrections(prefs, [makeCorrection()], 0.5)
    expect(result[0]?.confidence).toBeCloseTo(0.4)
  })

  it('defaults the penalty factor to 0.5', () => {
    expect(DEFAULT_CORRECTION_PENALTY).toBe(0.5)
    const prefs = [makePreference({ confidence: 0.6 })]
    const result = applyCorrections(prefs, [makeCorrection()])
    expect(result[0]?.confidence).toBeCloseTo(0.3)
  })

  it('updates lastUpdated on penalized preferences', () => {
    const prefs = [makePreference({ lastUpdated: '2026-01-01T00:00:00.000Z' })]
    const before = new Date().toISOString()
    const result = applyCorrections(prefs, [makeCorrection()])
    expect((result[0]?.lastUpdated ?? '') >= before).toBe(true)
  })

  it('leaves non-matching preferences untouched', () => {
    const prefs = [
      makePreference({ key: 'language', confidence: 0.8 }),
      makePreference({ key: 'testingApproach', value: 'TDD', confidence: 0.6 }),
      makePreference({
        category: 'interactionStyle',
        key: 'language',
        value: 'concise',
        confidence: 0.7,
      }),
    ]
    const result = applyCorrections(prefs, [makeCorrection()])
    expect(result.find((p) => p.key === 'testingApproach')?.confidence).toBe(0.6)
    expect(
      result.find((p) => p.category === 'interactionStyle')?.confidence
    ).toBe(0.7)
  })

  it('one correction at 0.5 penalty outweighs five +0.1 reinforcements from ~0.8', () => {
    const start = 0.8
    const base = makePreference({ confidence: start })

    let reinforced: readonly PreferenceCluster[] = [base]
    for (let i = 0; i < 5; i++) {
      reinforced = reinforcePreference(reinforced, {
        category: 'codingPreferences' as PreferenceCategory,
        key: 'language',
        value: 'TypeScript',
      })
    }
    const gain = (reinforced[0]?.confidence ?? 0) - start // capped at +0.2

    const corrected = applyCorrections([base], [makeCorrection()], 0.5)
    const drop = start - (corrected[0]?.confidence ?? 0) // -0.4

    expect(drop).toBeGreaterThan(gain)
  })

  it('reinforces the corrected-to value as a new observation', () => {
    const prefs = [makePreference({ value: 'JavaScript', confidence: 0.8 })]
    const result = applyCorrections(prefs, [
      makeCorrection({ correctedValue: 'TypeScript' }),
    ])

    const correctedTo = result.find((p) => p.value === 'TypeScript')
    expect(correctedTo).toBeDefined()
    expect(correctedTo?.confidence).toBeCloseTo(0.1)
    expect(correctedTo?.sessionCount).toBe(1)

    const old = result.find((p) => p.value === 'JavaScript')
    expect(old?.confidence).toBeCloseTo(0.4)
  })

  it('stamps correction provenance (learnedVia + correctedFrom) on the corrected-to cluster', () => {
    const prefs = [makePreference({ value: 'JavaScript', confidence: 0.8 })]
    const result = applyCorrections(prefs, [
      makeCorrection({ correctedValue: 'TypeScript' }),
    ])

    const correctedTo = result.find((p) => p.value === 'TypeScript')
    expect(correctedTo?.learnedVia).toBe('correction')
    expect(correctedTo?.correctedFrom).toBe('JavaScript')

    // The penalized original carries no provenance fields.
    const old = result.find((p) => p.value === 'JavaScript')
    expect(old?.learnedVia).toBeUndefined()
  })

  it('omits correctedFrom when no prior value existed for the key', () => {
    const result = applyCorrections([], [
      makeCorrection({ correctedValue: 'TypeScript' }),
    ])

    const correctedTo = result.find((p) => p.value === 'TypeScript')
    expect(correctedTo?.learnedVia).toBe('correction')
    expect(correctedTo?.correctedFrom).toBeUndefined()
  })

  it('does not penalize an existing preference matching the corrected-to value', () => {
    const prefs = [
      makePreference({ value: 'JavaScript', confidence: 0.8 }),
      makePreference({ value: 'TypeScript', confidence: 0.3 }),
    ]
    const result = applyCorrections(prefs, [
      makeCorrection({ correctedValue: 'TypeScript' }),
    ])

    const correctedTo = result.find((p) => p.value === 'TypeScript')
    // Exempt from the penalty and reinforced (+0.1) instead
    expect(correctedTo?.confidence).toBeCloseTo(0.4)
    expect(result.find((p) => p.value === 'JavaScript')?.confidence).toBeCloseTo(0.4)
  })

  it('does not prune even when confidence drops below the floor (decay handles removal)', () => {
    const prefs = [makePreference({ confidence: 0.015 })]
    const result = applyCorrections(prefs, [makeCorrection()], 0.5)
    expect(result).toHaveLength(1)
    expect(result[0]?.confidence).toBeCloseTo(0.0075)
  })

  it('does not mutate the original array', () => {
    const prefs = [makePreference({ confidence: 0.8, lastUpdated: '2026-01-01T00:00:00.000Z' })]
    const result = applyCorrections(prefs, [
      makeCorrection({ correctedValue: 'TypeScript' }),
    ])
    expect(result).not.toBe(prefs)
    expect(prefs).toHaveLength(1)
    expect(prefs[0]?.confidence).toBe(0.8)
    expect(prefs[0]?.lastUpdated).toBe('2026-01-01T00:00:00.000Z')
  })

  it('returns an equal array when there are no corrections', () => {
    const prefs = [makePreference()]
    const result = applyCorrections(prefs, [])
    expect(result).toEqual(prefs)
  })
})

describe('resolveConflicts', () => {
  it('resolves conflicts by keeping most recently updated preference', () => {
    const prefs: PreferenceCluster[] = [
      makePreference({
        key: 'language',
        value: 'JavaScript',
        confidence: 0.8,
        lastUpdated: '2026-01-10T00:00:00.000Z',
      }),
      makePreference({
        key: 'language',
        value: 'TypeScript',
        confidence: 0.6,
        lastUpdated: '2026-01-15T00:00:00.000Z',
      }),
    ]
    const result = resolveConflicts(prefs)
    const langPrefs = result.filter(
      (p) => p.category === 'codingPreferences' && p.key === 'language'
    )
    expect(langPrefs).toHaveLength(1)
    expect(langPrefs[0]?.value).toBe('TypeScript')
  })

  it('keeps both when category+key differ', () => {
    const prefs: PreferenceCluster[] = [
      makePreference({ key: 'language', value: 'TypeScript' }),
      makePreference({ key: 'testingApproach', value: 'TDD' }),
    ]
    const result = resolveConflicts(prefs)
    expect(result).toHaveLength(2)
  })

  it('does not mutate the original array', () => {
    const prefs: PreferenceCluster[] = [
      makePreference({ key: 'language', value: 'JS', lastUpdated: '2026-01-01T00:00:00.000Z' }),
      makePreference({ key: 'language', value: 'TS', lastUpdated: '2026-01-15T00:00:00.000Z' }),
    ]
    const result = resolveConflicts(prefs)
    expect(result).not.toBe(prefs)
    expect(prefs).toHaveLength(2)
  })

  it('breaks timestamp ties in favor of the later entry (corrected-to value wins)', () => {
    const ts = '2026-06-10T00:00:00.000Z'
    const prefs: PreferenceCluster[] = [
      makePreference({ key: 'language', value: 'JavaScript', confidence: 0.4, lastUpdated: ts }),
      makePreference({ key: 'language', value: 'TypeScript', confidence: 0.1, lastUpdated: ts }),
    ]
    const result = resolveConflicts(prefs)
    expect(result).toHaveLength(1)
    expect(result[0]?.value).toBe('TypeScript')
  })
})

describe('preference categories', () => {
  it('handles interactionStyle category', () => {
    const existing: PreferenceCluster[] = []
    const observation = {
      category: 'interactionStyle' as PreferenceCategory,
      key: 'verbosity',
      value: 'concise',
    }
    const result = reinforcePreference(existing, observation)
    expect(result[0]?.category).toBe('interactionStyle')
    expect(result[0]?.key).toBe('verbosity')
  })

  it('handles emotionalSignals category', () => {
    const existing: PreferenceCluster[] = []
    const observation = {
      category: 'emotionalSignals' as PreferenceCategory,
      key: 'urgency',
      value: 'high',
    }
    const result = reinforcePreference(existing, observation)
    expect(result[0]?.category).toBe('emotionalSignals')
  })
})
