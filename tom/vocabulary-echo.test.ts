import { describe, it, expect } from 'vitest'

import { computeVocabularyEcho } from './vocabulary-echo'
import type { VocabularyEntry } from './llm-analyze'
import type { SessionModel } from './schemas'

function model(
  overrides: Partial<SessionModel> = {}
): SessionModel {
  return {
    sessionId: 's1',
    intent: 'test',
    interactionPatterns: [],
    codingPreferences: [],
    ...overrides,
  }
}

const vocab: VocabularyEntry[] = [
  { category: 'interactionStyle', key: 'verbosity', value: 'concise' },
  { category: 'codingPreferences', key: 'test_runner', value: 'vitest' },
]

describe('computeVocabularyEcho', () => {
  it('reports injected count and zero echoes for an empty model', () => {
    const echo = computeVocabularyEcho(vocab, model())
    expect(echo).toEqual({ injected: 2, returned: 0, echoedKeyValue: 0, echoedKey: 0 })
  })

  it('counts a verbatim key+value echo as both key and key+value', () => {
    const echo = computeVocabularyEcho(
      vocab,
      model({ codingPreferences: [{ key: 'test_runner', value: 'vitest' }] })
    )
    expect(echo.returned).toBe(1)
    expect(echo.echoedKeyValue).toBe(1)
    expect(echo.echoedKey).toBe(1)
  })

  it('counts a same-key different-value entry as a key echo only', () => {
    const echo = computeVocabularyEcho(
      vocab,
      model({ codingPreferences: [{ key: 'test_runner', value: 'jest' }] })
    )
    expect(echo.returned).toBe(1)
    expect(echo.echoedKeyValue).toBe(0)
    expect(echo.echoedKey).toBe(1)
  })

  it('does not echo across categories even on an identical key+value', () => {
    // 'test_runner=vitest' is codingPreferences vocab; the same pair returned
    // under interactionPatterns (interactionStyle) must NOT match.
    const echo = computeVocabularyEcho(
      vocab,
      model({ interactionPatterns: [{ key: 'test_runner', value: 'vitest' }] })
    )
    expect(echo.returned).toBe(1)
    expect(echo.echoedKeyValue).toBe(0)
    expect(echo.echoedKey).toBe(0)
  })

  it('excludes legacy bare-string entries from the returned denominator', () => {
    const echo = computeVocabularyEcho(
      vocab,
      model({
        interactionPatterns: ['edits-then-tests'],
        codingPreferences: [{ key: 'test_runner', value: 'vitest' }, 'typescript'],
      })
    )
    // Two bare strings ignored; one keyed entry counted and echoed.
    expect(echo.returned).toBe(1)
    expect(echo.echoedKeyValue).toBe(1)
  })

  it('counts each matching category independently in one model', () => {
    const echo = computeVocabularyEcho(
      vocab,
      model({
        interactionPatterns: [{ key: 'verbosity', value: 'concise' }],
        codingPreferences: [{ key: 'test_runner', value: 'vitest' }],
      })
    )
    expect(echo.returned).toBe(2)
    expect(echo.echoedKeyValue).toBe(2)
    expect(echo.echoedKey).toBe(2)
  })

  it('reports zero echoes when no vocabulary was injected', () => {
    const echo = computeVocabularyEcho(
      [],
      model({ codingPreferences: [{ key: 'test_runner', value: 'vitest' }] })
    )
    expect(echo).toEqual({ injected: 0, returned: 1, echoedKeyValue: 0, echoedKey: 0 })
  })
})
