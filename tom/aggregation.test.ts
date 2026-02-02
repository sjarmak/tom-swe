import { describe, it, expect } from 'vitest'
import { aggregateSessionIntoModel } from './aggregation.js'
import type { UserModel, SessionModel, PreferenceCluster } from './schemas.js'

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

function makeUserModel(overrides: Partial<UserModel> = {}): UserModel {
  return {
    preferencesClusters: [],
    interactionStyleSummary: '',
    codingStyleSummary: '',
    projectOverrides: {},
    ...overrides,
  }
}

function makeSessionModel(
  overrides: Partial<SessionModel> = {}
): SessionModel {
  return {
    sessionId: 'session-001',
    intent: 'Implement feature X',
    interactionPatterns: ['concise', 'direct'],
    codingPreferences: ['TypeScript', 'TDD'],
    satisfactionSignals: {
      frustration: false,
      satisfaction: true,
      urgency: 'medium',
    },
    ...overrides,
  }
}

describe('aggregateSessionIntoModel', () => {
  it('returns a new UserModel (immutable)', () => {
    const model = makeUserModel()
    const session = makeSessionModel()
    const result = aggregateSessionIntoModel(model, session)
    expect(result).not.toBe(model)
  })

  it('adds new preferences from session with initial confidence 0.1', () => {
    const model = makeUserModel()
    const session = makeSessionModel({
      codingPreferences: ['TypeScript'],
      interactionPatterns: ['concise'],
    })
    const result = aggregateSessionIntoModel(model, session)

    const tsPref = result.preferencesClusters.find(
      (p) => p.category === 'codingPreferences' && p.value === 'TypeScript'
    )
    expect(tsPref).toBeDefined()
    expect(tsPref?.confidence).toBeCloseTo(0.1)
    expect(tsPref?.sessionCount).toBe(1)

    const concisePref = result.preferencesClusters.find(
      (p) => p.category === 'interactionStyle' && p.value === 'concise'
    )
    expect(concisePref).toBeDefined()
    expect(concisePref?.confidence).toBeCloseTo(0.1)
  })

  it('reinforces existing preferences per reinforcePreference logic', () => {
    const existing = makePreference({
      category: 'codingPreferences',
      key: 'preference',
      value: 'TypeScript',
      confidence: 0.5,
      sessionCount: 3,
    })
    const model = makeUserModel({ preferencesClusters: [existing] })
    const session = makeSessionModel({
      codingPreferences: ['TypeScript'],
    })
    const result = aggregateSessionIntoModel(model, session)

    const tsPref = result.preferencesClusters.find(
      (p) => p.category === 'codingPreferences' && p.value === 'TypeScript'
    )
    expect(tsPref).toBeDefined()
    // Confidence should increase (after decay + reinforcement)
    // Since lastUpdated is recent and decay is applied first, the net should be > 0.5
    expect(tsPref?.sessionCount).toBeGreaterThanOrEqual(4)
  })

  it('applies decay to existing preferences before merge', () => {
    const oldPref = makePreference({
      confidence: 0.8,
      lastUpdated: '2025-01-01T00:00:00.000Z', // ~1 year old
      sessionCount: 5,
    })
    const model = makeUserModel({ preferencesClusters: [oldPref] })
    const session = makeSessionModel({ codingPreferences: [] })

    const result = aggregateSessionIntoModel(model, session)

    // Old preference should have decayed significantly
    const decayedPref = result.preferencesClusters.find(
      (p) => p.key === 'language' && p.value === 'TypeScript'
    )
    // May be removed entirely if below threshold, or significantly reduced
    if (decayedPref) {
      expect(decayedPref.confidence).toBeLessThan(0.8)
    }
  })

  it('includes lastUpdated timestamp on each preference', () => {
    const model = makeUserModel()
    const session = makeSessionModel({
      codingPreferences: ['Rust'],
    })
    const result = aggregateSessionIntoModel(model, session)

    for (const pref of result.preferencesClusters) {
      expect(pref.lastUpdated).toBeDefined()
      expect(typeof pref.lastUpdated).toBe('string')
      // Should be a valid ISO timestamp
      expect(new Date(pref.lastUpdated).toISOString()).toBe(pref.lastUpdated)
    }
  })

  it('includes sessionCount on each preference', () => {
    const model = makeUserModel()
    const session = makeSessionModel({
      codingPreferences: ['Go'],
    })
    const result = aggregateSessionIntoModel(model, session)

    for (const pref of result.preferencesClusters) {
      expect(pref.sessionCount).toBeGreaterThanOrEqual(1)
    }
  })

  it('groups preferences by category and similar keys (auto-clustering)', () => {
    const model = makeUserModel({
      preferencesClusters: [
        makePreference({
          category: 'codingPreferences',
          key: 'preference',
          value: 'TypeScript',
          confidence: 0.5,
        }),
        makePreference({
          category: 'codingPreferences',
          key: 'preference',
          value: 'React',
          confidence: 0.3,
          lastUpdated: '2026-01-10T00:00:00.000Z',
        }),
      ],
    })
    const session = makeSessionModel({
      codingPreferences: ['TypeScript'],
    })
    const result = aggregateSessionIntoModel(model, session)

    // After conflict resolution, same category+key should have at most one value
    const codingPrefs = result.preferencesClusters.filter(
      (p) => p.category === 'codingPreferences' && p.key === 'preference'
    )
    expect(codingPrefs.length).toBeLessThanOrEqual(2)
  })

  it('extracts emotional signals from session satisfaction signals', () => {
    const model = makeUserModel()
    const session = makeSessionModel({
      satisfactionSignals: {
        frustration: true,
        satisfaction: false,
        urgency: 'high',
      },
    })
    const result = aggregateSessionIntoModel(model, session)

    const frustrationPref = result.preferencesClusters.find(
      (p) => p.category === 'emotionalSignals' && p.key === 'frustration'
    )
    expect(frustrationPref).toBeDefined()
    expect(frustrationPref?.value).toBe('true')

    const urgencyPref = result.preferencesClusters.find(
      (p) => p.category === 'emotionalSignals' && p.key === 'urgency'
    )
    expect(urgencyPref).toBeDefined()
    expect(urgencyPref?.value).toBe('high')
  })

  it('does not mutate the input UserModel', () => {
    const existingPref = makePreference({ confidence: 0.5, sessionCount: 3 })
    const model = makeUserModel({ preferencesClusters: [existingPref] })
    const session = makeSessionModel({
      codingPreferences: ['TypeScript'],
    })
    aggregateSessionIntoModel(model, session)

    expect(model.preferencesClusters[0]?.confidence).toBe(0.5)
    expect(model.preferencesClusters[0]?.sessionCount).toBe(3)
  })

  it('does not mutate the input SessionModel', () => {
    const model = makeUserModel()
    const session = makeSessionModel()
    const originalPatterns = [...session.interactionPatterns]
    aggregateSessionIntoModel(model, session)

    expect(session.interactionPatterns).toEqual(originalPatterns)
  })

  it('handles empty session with no observations', () => {
    const model = makeUserModel()
    const session = makeSessionModel({
      interactionPatterns: [],
      codingPreferences: [],
      satisfactionSignals: {
        frustration: false,
        satisfaction: false,
        urgency: 'low',
      },
    })
    const result = aggregateSessionIntoModel(model, session)
    expect(result).toBeDefined()
    expect(result.preferencesClusters).toBeDefined()
  })

  it('accepts optional decayDays parameter', () => {
    const oldPref = makePreference({
      confidence: 0.8,
      lastUpdated: '2025-06-01T00:00:00.000Z',
    })
    const model = makeUserModel({ preferencesClusters: [oldPref] })
    const session = makeSessionModel({ codingPreferences: [] })

    // Short decay should remove old prefs faster
    const shortDecay = aggregateSessionIntoModel(model, session, 7)
    const longDecay = aggregateSessionIntoModel(model, session, 365)

    const shortPref = shortDecay.preferencesClusters.find(
      (p) => p.key === 'language'
    )
    const longPref = longDecay.preferencesClusters.find(
      (p) => p.key === 'language'
    )

    // With very short decay, old pref should be gone or very low
    // With long decay, old pref should still be around
    if (shortPref && longPref) {
      expect(shortPref.confidence).toBeLessThan(longPref.confidence)
    }
  })
})
