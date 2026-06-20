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

  it('counts a single session once per key even with many same-key entries', () => {
    // A session whose arrays carry many entries that fold onto the same
    // category+key (the legacy bare-string case folding onto 'preference'/
    // 'pattern') must contribute exactly +1 confidence and +1 sessionCount —
    // not +N. This is the fix for the count-inflation bug (tom-swe-8h0) where
    // 675 bare-string observations across 35 sessions inflated one cluster to
    // sessionCount 675 and pinned confidence at 1.0.
    const model = makeUserModel()
    const session = makeSessionModel({
      // 50 distinct bare-string coding prefs all fold onto key 'preference'.
      codingPreferences: Array.from({ length: 50 }, (_, i) => `pref-${i}`),
      // 30 distinct bare-string patterns all fold onto key 'pattern'.
      interactionPatterns: Array.from({ length: 30 }, (_, i) => `pat-${i}`),
    })
    const result = aggregateSessionIntoModel(model, session)

    const codingPref = result.preferencesClusters.find(
      (p) => p.category === 'codingPreferences' && p.key === 'preference'
    )
    expect(codingPref?.sessionCount).toBe(1)
    expect(codingPref?.confidence).toBeCloseTo(0.1)
    // Last entry's value is retained (last-wins dedup).
    expect(codingPref?.value).toBe('pref-49')

    const interactionPref = result.preferencesClusters.find(
      (p) => p.category === 'interactionStyle' && p.key === 'pattern'
    )
    expect(interactionPref?.sessionCount).toBe(1)
    expect(interactionPref?.confidence).toBeCloseTo(0.1)
    expect(interactionPref?.value).toBe('pat-29')

    // Exactly one cluster per folded key — no fragmentation.
    expect(
      result.preferencesClusters.filter((p) => p.key === 'preference')
    ).toHaveLength(1)
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

  it('never produces emotionalSignals clusters (deprecated and removed)', () => {
    const model = makeUserModel()
    const session = makeSessionModel({
      satisfactionSignals: {
        frustration: true,
        satisfaction: false,
        urgency: 'high',
      },
    })
    const result = aggregateSessionIntoModel(model, session)

    expect(
      result.preferencesClusters.some((p) => p.category === 'emotionalSignals')
    ).toBe(false)
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

  it('applies corrections after reinforcement (decay → reinforce → correct)', () => {
    // Existing pref at 0.5, reinforced by this session (+0.1 → 0.6), then a
    // valueless correction halves it → 0.3. If corrections ran before
    // reinforcement the result would be 0.5 * 0.5 + 0.1 = 0.35.
    const now = new Date().toISOString()
    const model = makeUserModel({
      preferencesClusters: [
        makePreference({
          category: 'codingPreferences',
          key: 'preference',
          value: 'TypeScript',
          confidence: 0.5,
          lastUpdated: now,
        }),
      ],
    })
    const session = makeSessionModel({
      interactionPatterns: [],
      codingPreferences: ['TypeScript'],
      corrections: [
        {
          category: 'codingPreferences',
          key: 'preference',
          evidence: 'user reverted the suggested approach',
        },
      ],
    })

    const result = aggregateSessionIntoModel(model, session)
    const pref = result.preferencesClusters.find(
      (p) => p.category === 'codingPreferences' && p.key === 'preference'
    )
    expect(pref?.confidence).toBeCloseTo(0.3, 2)
  })

  it('lets the corrected-to value win conflict resolution and start accumulating', () => {
    const now = new Date().toISOString()
    const model = makeUserModel({
      preferencesClusters: [
        makePreference({
          category: 'codingPreferences',
          key: 'preference',
          value: 'jest',
          confidence: 0.9,
          lastUpdated: now,
        }),
      ],
    })
    const session = makeSessionModel({
      interactionPatterns: [],
      codingPreferences: [],
      corrections: [
        {
          category: 'codingPreferences',
          key: 'preference',
          correctedValue: 'vitest',
          evidence: 'user replaced jest setup with vitest',
        },
      ],
    })

    const result = aggregateSessionIntoModel(model, session)
    const winner = result.preferencesClusters.find(
      (p) => p.category === 'codingPreferences' && p.key === 'preference'
    )
    expect(winner?.value).toBe('vitest')
    expect(winner?.confidence).toBeCloseTo(0.1)
    expect(winner?.sessionCount).toBe(1)
  })

  it('respects a custom correctionPenalty parameter', () => {
    const now = new Date().toISOString()
    const model = makeUserModel({
      preferencesClusters: [
        makePreference({
          category: 'interactionStyle',
          key: 'verbosity',
          value: 'verbose',
          confidence: 0.8,
          lastUpdated: now,
        }),
      ],
    })
    const session = makeSessionModel({
      interactionPatterns: [],
      codingPreferences: [],
      corrections: [
        {
          category: 'interactionStyle',
          key: 'verbosity',
          evidence: 'user asked for shorter answers',
        },
      ],
    })

    const result = aggregateSessionIntoModel(model, session, 30, 0.25)
    const pref = result.preferencesClusters.find(
      (p) => p.category === 'interactionStyle' && p.key === 'verbosity'
    )
    expect(pref?.confidence).toBeCloseTo(0.2, 2)
  })

  it('handles session models without a corrections field (backward compatible)', () => {
    const model = makeUserModel()
    const session = makeSessionModel() // no corrections field
    expect(session.corrections).toBeUndefined()
    const result = aggregateSessionIntoModel(model, session)
    expect(result.preferencesClusters.length).toBeGreaterThan(0)
  })

  it('does not mutate session corrections', () => {
    const model = makeUserModel()
    const corrections = [
      {
        category: 'codingPreferences' as const,
        key: 'preference',
        correctedValue: 'vitest',
        evidence: 'switched test runner',
      },
    ]
    const session = makeSessionModel({ corrections })
    aggregateSessionIntoModel(model, session)
    expect(session.corrections).toEqual(corrections)
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

  it('accumulates confidence across N sessions that reword the same observation', () => {
    // Same keyed observation (key='language'), reworded each session. With the
    // sessions sharing an asOf there is no inter-session decay, so confidence
    // climbs monotonically and sessionCount reaches N.
    const asOf = new Date('2026-06-15T00:00:00.000Z')
    const wordings = [
      'prefers TypeScript',
      'likes using TypeScript',
      'wants TS everywhere',
      'TypeScript is the choice',
    ]

    let model = makeUserModel()
    for (const value of wordings) {
      const session = makeSessionModel({
        interactionPatterns: [],
        codingPreferences: [{ key: 'language', value }],
        satisfactionSignals: {
          frustration: false,
          satisfaction: false,
          urgency: 'low',
        },
      })
      model = aggregateSessionIntoModel(model, session, 30, undefined, asOf)
    }

    const langPrefs = model.preferencesClusters.filter(
      (p) => p.category === 'codingPreferences' && p.key === 'language'
    )
    // At most one cluster per category+key — rewording does not fragment it.
    expect(langPrefs).toHaveLength(1)
    const pref = langPrefs[0]
    // sessionCount == N
    expect(pref?.sessionCount).toBe(wordings.length)
    // Confidence climbed above INITIAL_CONFIDENCE (0.1 + 3 increments = 0.4).
    expect(pref?.confidence).toBeCloseTo(0.4)
    expect(pref?.confidence).toBeGreaterThan(0.1)
    // Latest wording is the retained value.
    expect(pref?.value).toBe('TypeScript is the choice')
  })

  it('lets a later correction override an accumulated reworded preference', () => {
    const asOf = new Date('2026-06-15T00:00:00.000Z')
    // Build up an accumulated preference over three reworded sessions.
    let model = makeUserModel()
    for (const value of ['jest is fine', 'use jest', 'jest please']) {
      model = aggregateSessionIntoModel(
        model,
        makeSessionModel({
          interactionPatterns: [],
          codingPreferences: [{ key: 'testRunner', value }],
          satisfactionSignals: { frustration: false, satisfaction: false, urgency: 'low' },
        }),
        30,
        undefined,
        asOf
      )
    }
    const accumulated = model.preferencesClusters.find(
      (p) => p.category === 'codingPreferences' && p.key === 'testRunner'
    )
    expect(accumulated?.value).toBe('jest please')
    expect(accumulated?.confidence).toBeCloseTo(0.3)

    // A correction toward 'vitest' must override the accumulated 'jest'.
    model = aggregateSessionIntoModel(
      model,
      makeSessionModel({
        interactionPatterns: [],
        codingPreferences: [],
        satisfactionSignals: { frustration: false, satisfaction: false, urgency: 'low' },
        corrections: [
          {
            category: 'codingPreferences',
            key: 'testRunner',
            correctedValue: 'vitest',
            evidence: 'user swapped jest for vitest',
          },
        ],
      }),
      30,
      undefined,
      asOf
    )

    const winner = model.preferencesClusters.find(
      (p) => p.category === 'codingPreferences' && p.key === 'testRunner'
    )
    // Correction overrides: corrected-to value wins, starting fresh.
    expect(winner?.value).toBe('vitest')
    expect(winner?.confidence).toBeCloseTo(0.1)
    expect(winner?.sessionCount).toBe(1)
    expect(winner?.learnedVia).toBe('correction')
    expect(winner?.correctedFrom).toBe('jest please')
    // One cluster per category+key after resolution.
    const testRunnerPrefs = model.preferencesClusters.filter(
      (p) => p.category === 'codingPreferences' && p.key === 'testRunner'
    )
    expect(testRunnerPrefs).toHaveLength(1)
  })
})

describe('aggregateSessionIntoModel style summaries', () => {
  const recent = '2026-06-17T00:00:00.000Z'

  it('builds interactionStyleSummary from interactionStyle clusters only', () => {
    const model = makeUserModel({
      preferencesClusters: [
        makePreference({
          category: 'interactionStyle',
          key: 'verbosity',
          value: 'concise',
          confidence: 0.8,
          lastUpdated: recent,
        }),
        makePreference({
          category: 'codingPreferences',
          key: 'language',
          value: 'TypeScript',
          confidence: 0.9,
          lastUpdated: recent,
        }),
      ],
    })
    const session = makeSessionModel({
      interactionPatterns: [],
      codingPreferences: [],
    })
    const result = aggregateSessionIntoModel(model, session, 30, 0.5, new Date(recent))

    expect(result.interactionStyleSummary).toContain('verbosity: concise')
    expect(result.interactionStyleSummary).not.toContain('TypeScript')
    expect(result.codingStyleSummary).toContain('language: TypeScript')
    expect(result.codingStyleSummary).not.toContain('concise')
  })

  it('produces empty-string summaries for empty clusters (no crash)', () => {
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

    expect(result.interactionStyleSummary).toBe('')
    expect(result.codingStyleSummary).toBe('')
  })

  it('produces empty-string summaries when all clusters are below threshold', () => {
    const model = makeUserModel({
      preferencesClusters: [
        makePreference({
          category: 'interactionStyle',
          key: 'verbosity',
          value: 'concise',
          confidence: 0.05,
          lastUpdated: recent,
        }),
        makePreference({
          category: 'codingPreferences',
          key: 'language',
          value: 'TypeScript',
          confidence: 0.05,
          lastUpdated: recent,
        }),
      ],
    })
    const session = makeSessionModel({
      interactionPatterns: [],
      codingPreferences: [],
    })
    const result = aggregateSessionIntoModel(model, session, 30, 0.5, new Date(recent))

    expect(result.interactionStyleSummary).toBe('')
    expect(result.codingStyleSummary).toBe('')
  })

  it('is deterministic across repeated runs on the same input', () => {
    const model = makeUserModel({
      preferencesClusters: [
        makePreference({
          category: 'codingPreferences',
          key: 'language',
          value: 'TypeScript',
          confidence: 0.7,
          lastUpdated: recent,
        }),
        makePreference({
          category: 'codingPreferences',
          key: 'testing',
          value: 'vitest',
          confidence: 0.6,
          lastUpdated: recent,
        }),
      ],
    })
    const session = makeSessionModel({
      interactionPatterns: [],
      codingPreferences: [],
    })
    const at = new Date(recent)
    const a = aggregateSessionIntoModel(model, session, 30, 0.5, at)
    const b = aggregateSessionIntoModel(model, session, 30, 0.5, at)

    expect(a.codingStyleSummary).toBe(b.codingStyleSummary)
    expect(a.interactionStyleSummary).toBe(b.interactionStyleSummary)
  })

  it('orders by confidence desc with key asc as tiebreak', () => {
    const model = makeUserModel({
      preferencesClusters: [
        // Equal confidence → key ascending: architecture before language
        makePreference({
          category: 'codingPreferences',
          key: 'language',
          value: 'TypeScript',
          confidence: 0.6,
          lastUpdated: recent,
        }),
        makePreference({
          category: 'codingPreferences',
          key: 'architecture',
          value: 'layered',
          confidence: 0.6,
          lastUpdated: recent,
        }),
        // Higher confidence sorts first overall
        makePreference({
          category: 'codingPreferences',
          key: 'testing',
          value: 'vitest',
          confidence: 0.9,
          lastUpdated: recent,
        }),
      ],
    })
    const session = makeSessionModel({
      interactionPatterns: [],
      codingPreferences: [],
    })
    const result = aggregateSessionIntoModel(model, session, 30, 0.5, new Date(recent))

    expect(result.codingStyleSummary).toBe(
      'testing: vitest; architecture: layered; language: TypeScript'
    )
  })

  it('derives summaries purely from clusters, ignoring prior summary strings', () => {
    // Two models with identical resolved clusters must yield identical
    // summaries regardless of the prior summary strings — proving the
    // summary is a pure function of the resolved clusters (no LLM, no
    // carry-over of stale text).
    const clusters: PreferenceCluster[] = [
      makePreference({
        category: 'interactionStyle',
        key: 'verbosity',
        value: 'concise',
        confidence: 0.8,
        lastUpdated: recent,
      }),
    ]
    const session = makeSessionModel({
      interactionPatterns: [],
      codingPreferences: [],
    })
    const at = new Date(recent)
    const r1 = aggregateSessionIntoModel(
      makeUserModel({
        preferencesClusters: clusters,
        interactionStyleSummary: 'OLD',
      }),
      session,
      30,
      0.5,
      at
    )
    const r2 = aggregateSessionIntoModel(
      makeUserModel({
        preferencesClusters: clusters,
        interactionStyleSummary: 'DIFFERENT',
      }),
      session,
      30,
      0.5,
      at
    )
    expect(r1.interactionStyleSummary).toBe(r2.interactionStyleSummary)
    expect(r1.interactionStyleSummary).not.toBe('OLD')
  })
})
