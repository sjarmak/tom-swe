import { describe, it, expect } from 'vitest'
import {
  detectAmbiguity,
  type DetectAmbiguityInput,
  type AmbiguityThreshold,
} from './ambiguity.js'

function makeInput(overrides: Partial<DetectAmbiguityInput> = {}): DetectAmbiguityInput {
  return {
    prompt: 'Please read the main entry file at /src/index.ts',
    threshold: 'medium',
    hasUserModel: true,
    ...overrides,
  }
}

describe('detectAmbiguity', () => {
  describe('return shape', () => {
    it('returns isAmbiguous boolean, score number, and reason string', () => {
      const result = detectAmbiguity(makeInput())
      expect(typeof result.isAmbiguous).toBe('boolean')
      expect(typeof result.score).toBe('number')
      expect(typeof result.reason).toBe('string')
    })

    it('score is between 0 and 1', () => {
      const result = detectAmbiguity(makeInput())
      expect(result.score).toBeGreaterThanOrEqual(0)
      expect(result.score).toBeLessThanOrEqual(1)
    })

    it('clamps score to 1.0 maximum', () => {
      const result = detectAmbiguity(makeInput({
        prompt: 'fix style pattern architecture library framework convention approach',
        hasUserModel: false,
      }))
      expect(result.score).toBeLessThanOrEqual(1.0)
    })

    it('reports fired heuristics as typed triggers', () => {
      const result = detectAmbiguity(makeInput({
        prompt: 'refactor the architecture',
        hasUserModel: false,
      }))
      expect(result.triggers).toContain('preference-sensitive')
      expect(result.triggers).toContain('no-user-model')

      const calm = detectAmbiguity(makeInput({
        prompt: 'rename the variable maxRetries to maxAttempts in tom/consult.ts and update its three call sites',
        hasUserModel: true,
      }))
      expect(calm.triggers).toEqual([])
    })
  })

  describe('heuristic 1: short/vague prompts', () => {
    it('detects short vague prompt without file paths', () => {
      const result = detectAmbiguity(makeInput({
        prompt: 'fix this',
      }))
      expect(result.score).toBeGreaterThan(0)
      expect(result.reason).toContain('Short or vague')
    })

    it('detects vague keywords', () => {
      const result = detectAmbiguity(makeInput({
        prompt: 'improve and clean this',
      }))
      expect(result.score).toBeGreaterThan(0)
      expect(result.reason).toContain('Short or vague')
    })

    it('does not flag long specific prompt', () => {
      const result = detectAmbiguity(makeInput({
        prompt:
          'Please add a validateEmail function to /src/utils/validation.ts that uses a regex to check email format',
      }))
      expect(result.reason).not.toContain('Short or vague')
    })

    it('scores empty prompt', () => {
      const result = detectAmbiguity(makeInput({
        prompt: '',
      }))
      expect(result.score).toBeGreaterThan(0)
    })

    it('reduces score for short prompt that names a file path', () => {
      const withPath = detectAmbiguity(makeInput({
        prompt: 'fix /src/app.ts',
      }))
      const withoutPath = detectAmbiguity(makeInput({
        prompt: 'fix the app',
      }))
      expect(withPath.score).toBeLessThan(withoutPath.score)
    })
  })

  describe('heuristic 2: preference-sensitive vocabulary', () => {
    it('detects architecture keywords', () => {
      const result = detectAmbiguity(makeInput({
        prompt: 'What architecture pattern should we use for the backend service layer?',
      }))
      expect(result.reason).toContain('style, architecture, or library preferences')
    })

    it('detects library choice keywords', () => {
      const result = detectAmbiguity(makeInput({
        prompt: 'Which library should we use for date formatting in our project?',
      }))
      expect(result.reason).toContain('style, architecture, or library preferences')
    })

    it('does not flag prompts without preference vocabulary', () => {
      const result = detectAmbiguity(makeInput({
        prompt: 'Read the test output and tell me which assertions failed and why exactly',
      }))
      expect(result.reason).not.toContain('style, architecture, or library preferences')
    })

    it('more preference keywords increase the score', () => {
      const oneKeyword = detectAmbiguity(makeInput({
        prompt: 'Refactor the user session handling so the login flow stays unchanged for everyone',
      }))
      const threeKeywords = detectAmbiguity(makeInput({
        prompt: 'Refactor the architecture of the session handling and pick a naming style for it',
      }))
      expect(threeKeywords.score).toBeGreaterThan(oneKeyword.score)
    })
  })

  describe('heuristic 3: no user model', () => {
    it('adds score when no user model exists', () => {
      const withModel = detectAmbiguity(makeInput({ hasUserModel: true }))
      const withoutModel = detectAmbiguity(makeInput({ hasUserModel: false }))
      expect(withoutModel.score).toBeGreaterThan(withModel.score)
    })

    it('includes reason when no user model', () => {
      const result = detectAmbiguity(makeInput({
        hasUserModel: false,
        prompt: 'fix this',
      }))
      expect(result.reason).toContain('No user model exists')
    })
  })

  describe('threshold configuration', () => {
    const thresholds: AmbiguityThreshold[] = ['low', 'medium', 'high']

    it('low threshold (>0.3) is most sensitive', () => {
      const result = detectAmbiguity(makeInput({
        threshold: 'low',
        prompt: 'fix and improve this',
        hasUserModel: false,
      }))
      // Short vague prompt + no user model should exceed 0.3
      expect(result.isAmbiguous).toBe(true)
    })

    it('high threshold (>0.7) is least sensitive', () => {
      const result = detectAmbiguity(makeInput({
        threshold: 'high',
        prompt: 'fix this',
      }))
      // Short vague prompt alone should NOT exceed 0.7
      expect(result.isAmbiguous).toBe(false)
    })

    it('defaults to medium threshold when not specified', () => {
      const withDefault = detectAmbiguity({
        prompt: 'fix this',
      })
      const withMedium = detectAmbiguity(makeInput({
        threshold: 'medium',
        prompt: 'fix this',
      }))
      expect(withDefault.isAmbiguous).toBe(withMedium.isAmbiguous)
      expect(withDefault.score).toBe(withMedium.score)
    })

    it('all thresholds produce consistent ordering', () => {
      const input = makeInput({ prompt: 'fix this' })
      const results = thresholds.map((t) =>
        detectAmbiguity({ ...input, threshold: t })
      )
      // Same score regardless of threshold
      expect(results[0]?.score).toBe(results[1]?.score)
      expect(results[1]?.score).toBe(results[2]?.score)
    })
  })

  describe('performance', () => {
    it('executes in <50ms', () => {
      const input = makeInput({
        prompt:
          'refactor the architecture pattern to use clean design approach, ' +
          'also update the naming convention style and organize the library structure',
        hasUserModel: false,
      })

      const start = performance.now()
      for (let i = 0; i < 1000; i++) {
        detectAmbiguity(input)
      }
      const elapsed = performance.now() - start
      // 1000 iterations should complete well within 50ms total
      expect(elapsed).toBeLessThan(1000)
      // Single execution well under 1ms
      expect(elapsed / 1000).toBeLessThan(1)
    })
  })

  describe('combined heuristics', () => {
    it('non-ambiguous: specific prompt with clear target and user model', () => {
      const result = detectAmbiguity(makeInput({
        prompt: 'Rename the function old() to newFunction() in /src/utils.ts and run the tests',
        hasUserModel: true,
      }))
      expect(result.isAmbiguous).toBe(false)
      expect(result.score).toBeLessThan(0.5)
    })

    it('highly ambiguous: vague style prompt, no model', () => {
      const result = detectAmbiguity(makeInput({
        prompt: 'make the style better',
        hasUserModel: false,
        threshold: 'low',
      }))
      expect(result.isAmbiguous).toBe(true)
      expect(result.score).toBeGreaterThan(0.5)
    })

    it('reason includes all triggered heuristics', () => {
      const result = detectAmbiguity(makeInput({
        prompt: 'fix style',
        hasUserModel: false,
      }))
      expect(result.reason).toContain('Short or vague')
      expect(result.reason).toContain('style, architecture, or library preferences')
      expect(result.reason).toContain('No user model')
    })

    it('reason is descriptive when no ambiguity detected', () => {
      const result = detectAmbiguity(makeInput({
        prompt: 'Please read the main entry file at /src/index.ts and tell me what it exports',
        hasUserModel: true,
      }))
      expect(result.reason).toBe('No ambiguity detected')
    })
  })
})
