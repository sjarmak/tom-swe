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

describe('PreferenceClusterSchema retired promotion fields', () => {
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

  it('accepts a clean cluster with no retired fields', () => {
    const result = UserModelSchema.safeParse(makeUserModelInput([makeCluster()]))
    expect(result.success).toBe(true)
  })

  // The retired promoted/gateRejectedValue/gateRejectedAt keys (removed with the
  // CLAUDE.md promotion pipeline, tom-swe-x1m.2/.3) are now rejected by the
  // strictObject. Stored models still carrying them are cleaned at the read
  // boundary by stripDeprecatedClusterFields — covered in memory-io.test.ts.
  it.each([
    ['promoted', true],
    ['gateRejectedValue', 'vitest'],
    ['gateRejectedAt', '2026-06-01T10:00:00.000Z'],
  ])('rejects the retired %s field under strictObject', (field, value) => {
    const result = UserModelSchema.safeParse(
      makeUserModelInput([makeCluster({ [field as string]: value })])
    )
    expect(result.success).toBe(false)
  })
})
