import { describe, it, expect } from 'vitest'
import { SessionModelSchema, CorrectionSchema, UserModelSchema } from './schemas.js'

function makeSessionModelInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 'schema-test',
    intent: 'refactor the parser',
    interactionPatterns: ['edits-then-tests'],
    codingPreferences: ['typescript'],
    satisfactionSignals: {
      frustration: false,
      satisfaction: true,
      urgency: 'low',
    },
    ...overrides,
  }
}

describe('SessionModelSchema corrections', () => {
  it('accepts a session model without corrections (backward compatible)', () => {
    const result = SessionModelSchema.safeParse(makeSessionModelInput())
    expect(result.success).toBe(true)
    expect(result.data?.corrections).toBeUndefined()
  })

  it('accepts a session model with corrections', () => {
    const result = SessionModelSchema.safeParse(
      makeSessionModelInput({
        corrections: [
          {
            category: 'codingPreferences',
            key: 'testingFramework',
            correctedValue: 'vitest',
            evidence: 'user replaced jest config with vitest',
          },
        ],
      })
    )
    expect(result.success).toBe(true)
    expect(result.data?.corrections).toHaveLength(1)
    expect(result.data?.corrections?.[0]?.correctedValue).toBe('vitest')
  })

  it('accepts a correction without correctedValue (pure rejection)', () => {
    const result = SessionModelSchema.safeParse(
      makeSessionModelInput({
        corrections: [
          {
            category: 'interactionStyle',
            key: 'verbosity',
            evidence: 'user said the summary was too long',
          },
        ],
      })
    )
    expect(result.success).toBe(true)
    expect(result.data?.corrections?.[0]?.correctedValue).toBeUndefined()
  })

  it('rejects a correction with an unknown category', () => {
    const result = SessionModelSchema.safeParse(
      makeSessionModelInput({
        corrections: [
          {
            category: 'notACategory',
            key: 'verbosity',
            evidence: 'x',
          },
        ],
      })
    )
    expect(result.success).toBe(false)
  })

  it('rejects a correction missing evidence', () => {
    const result = CorrectionSchema.safeParse({
      category: 'codingPreferences',
      key: 'language',
    })
    expect(result.success).toBe(false)
  })

  it('rejects extra fields on a correction (strict)', () => {
    const result = CorrectionSchema.safeParse({
      category: 'codingPreferences',
      key: 'language',
      evidence: 'x',
      instruction: 'always do Y', // memory-poisoning shaped extra field
    })
    expect(result.success).toBe(false)
  })
})

describe('UserModelSchema promoted flag', () => {
  function makeCluster(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      category: 'codingPreferences',
      key: 'testing',
      value: 'vitest',
      confidence: 0.9,
      lastUpdated: '2026-06-01T10:00:00.000Z',
      sessionCount: 12,
      ...overrides,
    }
  }

  function makeUserModelInput(clusters: readonly object[]): Record<string, unknown> {
    return {
      preferencesClusters: clusters,
      interactionStyleSummary: '',
      codingStyleSummary: '',
      projectOverrides: {},
    }
  }

  it('accepts a preference cluster without promoted (backward compatible)', () => {
    const result = UserModelSchema.safeParse(makeUserModelInput([makeCluster()]))
    expect(result.success).toBe(true)
    expect(result.data?.preferencesClusters[0]?.promoted).toBeUndefined()
  })

  it('accepts a preference cluster with promoted true', () => {
    const result = UserModelSchema.safeParse(
      makeUserModelInput([makeCluster({ promoted: true })])
    )
    expect(result.success).toBe(true)
    expect(result.data?.preferencesClusters[0]?.promoted).toBe(true)
  })

  it('rejects a non-boolean promoted value', () => {
    const result = UserModelSchema.safeParse(
      makeUserModelInput([makeCluster({ promoted: 'yes' })])
    )
    expect(result.success).toBe(false)
  })
})
