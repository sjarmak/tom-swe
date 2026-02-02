import { describe, it, expect } from 'vitest'
import {
  reinforcePreference,
  decayPreferences,
  resolveConflicts,
  type PreferenceCategory,
} from './preferences.js'
import type { PreferenceCluster } from './schemas.js'

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

  it('handles value change for same category+key (updates value, resets confidence)', () => {
    const existing = [makePreference({ value: 'JavaScript', confidence: 0.8 })]
    const observation = {
      category: 'codingPreferences' as PreferenceCategory,
      key: 'language',
      value: 'TypeScript',
    }
    const result = reinforcePreference(existing, observation)
    const updated = result.find((p) => p.key === 'language' && p.value === 'TypeScript')
    expect(updated).toBeDefined()
    // When value changes, it's a new observation — keep both for conflict resolution
    const old = result.find((p) => p.key === 'language' && p.value === 'JavaScript')
    expect(old).toBeDefined()
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
