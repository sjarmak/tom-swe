import { describe, it, expect } from 'vitest'
import {
  detectAmbiguity,
  type DetectAmbiguityInput,
  type AmbiguityThreshold,
} from './ambiguity.js'

function makeInput(overrides: Partial<DetectAmbiguityInput> = {}): DetectAmbiguityInput {
  return {
    toolName: 'Read',
    toolParameters: { file_path: '/src/index.ts' },
    recentUserMessages: ['Please read the main entry file at /src/index.ts'],
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
        toolName: 'Edit',
        toolParameters: {},
        recentUserMessages: ['fix style pattern architecture library framework convention approach'],
        hasUserModel: false,
      }))
      expect(result.score).toBeLessThanOrEqual(1.0)
    })
  })

  describe('heuristic 1: short/vague instructions', () => {
    it('detects short vague instruction without file paths', () => {
      const result = detectAmbiguity(makeInput({
        recentUserMessages: ['fix this'],
      }))
      expect(result.score).toBeGreaterThan(0)
      expect(result.reason).toContain('Short or vague')
    })

    it('detects vague keywords', () => {
      const result = detectAmbiguity(makeInput({
        recentUserMessages: ['improve and clean this'],
      }))
      expect(result.score).toBeGreaterThan(0)
      expect(result.reason).toContain('Short or vague')
    })

    it('does not flag long specific instruction', () => {
      const result = detectAmbiguity(makeInput({
        recentUserMessages: [
          'Please add a validateEmail function to /src/utils/validation.ts that uses a regex to check email format',
        ],
      }))
      expect(result.reason).not.toContain('Short or vague')
    })

    it('scores empty message', () => {
      const result = detectAmbiguity(makeInput({
        recentUserMessages: [''],
      }))
      expect(result.score).toBeGreaterThan(0)
    })

    it('scores no messages', () => {
      const result = detectAmbiguity(makeInput({
        recentUserMessages: [],
      }))
      expect(result.score).toBeGreaterThan(0)
    })
  })

  describe('heuristic 2: multiple file targets', () => {
    it('flags Edit without file_path', () => {
      const result = detectAmbiguity(makeInput({
        toolName: 'Edit',
        toolParameters: {},
        recentUserMessages: ['Update the component to use React hooks instead of class syntax'],
      }))
      expect(result.reason).toContain('Edit tool used without a clear single file target')
    })

    it('flags Edit with file_path but no old_string', () => {
      const result = detectAmbiguity(makeInput({
        toolName: 'Edit',
        toolParameters: { file_path: '/src/app.tsx' },
        recentUserMessages: ['Update the component to use React hooks instead of class syntax'],
      }))
      expect(result.reason).toContain('Edit tool used without a clear single file target')
    })

    it('does not flag Edit with file_path and old_string', () => {
      const result = detectAmbiguity(makeInput({
        toolName: 'Edit',
        toolParameters: { file_path: '/src/app.tsx', old_string: 'class App' },
        recentUserMessages: ['Update the component to use React hooks instead of class syntax'],
      }))
      expect(result.reason).not.toContain('Edit tool used without a clear single file target')
    })

    it('does not flag non-edit tools', () => {
      const result = detectAmbiguity(makeInput({
        toolName: 'Read',
        toolParameters: {},
        recentUserMessages: ['Read the file at /src/index.ts and explain what it does in detail'],
      }))
      expect(result.reason).not.toContain('Edit tool')
    })
  })

  describe('heuristic 3: preference-sensitive decisions', () => {
    it('detects architecture keywords', () => {
      const result = detectAmbiguity(makeInput({
        recentUserMessages: ['What architecture pattern should we use for the backend service layer?'],
      }))
      expect(result.reason).toContain('style, architecture, or library preferences')
    })

    it('detects library choice keywords', () => {
      const result = detectAmbiguity(makeInput({
        recentUserMessages: ['Which library should we use for date formatting in our project?'],
      }))
      expect(result.reason).toContain('style, architecture, or library preferences')
    })

    it('adds score for style-sensitive tool', () => {
      const withWriteTool = detectAmbiguity(makeInput({
        toolName: 'Write',
        toolParameters: { file_path: '/src/new.ts' },
        recentUserMessages: ['Create a new utility file for string helpers with common functions'],
      }))
      const withReadTool = detectAmbiguity(makeInput({
        toolName: 'Read',
        toolParameters: { file_path: '/src/new.ts' },
        recentUserMessages: ['Create a new utility file for string helpers with common functions'],
      }))
      expect(withWriteTool.score).toBeGreaterThan(withReadTool.score)
    })

    it('considers all recent messages, not just last', () => {
      const result = detectAmbiguity(makeInput({
        recentUserMessages: [
          'I want to refactor the authentication module to follow a clean architecture pattern',
          'Go ahead',
        ],
      }))
      expect(result.reason).toContain('style, architecture, or library preferences')
    })
  })

  describe('heuristic 4: no user model', () => {
    it('adds score when no user model exists', () => {
      const withModel = detectAmbiguity(makeInput({ hasUserModel: true }))
      const withoutModel = detectAmbiguity(makeInput({ hasUserModel: false }))
      expect(withoutModel.score).toBeGreaterThan(withModel.score)
    })

    it('includes reason when no user model', () => {
      const result = detectAmbiguity(makeInput({
        hasUserModel: false,
        recentUserMessages: ['fix this'],
      }))
      expect(result.reason).toContain('No user model exists')
    })
  })

  describe('threshold configuration', () => {
    const thresholds: AmbiguityThreshold[] = ['low', 'medium', 'high']

    it('low threshold (>0.3) is most sensitive', () => {
      const result = detectAmbiguity(makeInput({
        threshold: 'low',
        recentUserMessages: ['fix and improve this'],
        hasUserModel: false,
      }))
      // Short vague message + no user model should exceed 0.3
      expect(result.isAmbiguous).toBe(true)
    })

    it('high threshold (>0.7) is least sensitive', () => {
      const result = detectAmbiguity(makeInput({
        threshold: 'high',
        recentUserMessages: ['fix this'],
      }))
      // Short vague message alone should NOT exceed 0.7
      expect(result.isAmbiguous).toBe(false)
    })

    it('defaults to medium threshold when not specified', () => {
      const withDefault = detectAmbiguity({
        toolName: 'Read',
        toolParameters: {},
        recentUserMessages: ['fix this'],
      })
      const withMedium = detectAmbiguity(makeInput({
        threshold: 'medium',
        recentUserMessages: ['fix this'],
      }))
      expect(withDefault.isAmbiguous).toBe(withMedium.isAmbiguous)
      expect(withDefault.score).toBe(withMedium.score)
    })

    it('all thresholds produce consistent ordering', () => {
      const input = makeInput({ recentUserMessages: ['fix this'] })
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
        toolName: 'Edit',
        toolParameters: { file_path: '/src/app.tsx' },
        recentUserMessages: [
          'refactor the architecture pattern to use clean design approach',
          'also update the naming convention style',
          'and organize the library structure',
        ],
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
    it('non-ambiguous: specific instruction with clear target and user model', () => {
      const result = detectAmbiguity(makeInput({
        toolName: 'Edit',
        toolParameters: { file_path: '/src/utils.ts', old_string: 'function old()' },
        recentUserMessages: ['Rename the function old() to newFunction() in /src/utils.ts'],
        hasUserModel: true,
      }))
      expect(result.isAmbiguous).toBe(false)
      expect(result.score).toBeLessThan(0.5)
    })

    it('highly ambiguous: vague instruction, style tool, no model', () => {
      const result = detectAmbiguity(makeInput({
        toolName: 'Write',
        toolParameters: { file_path: '/src/new.ts' },
        recentUserMessages: ['make it better'],
        hasUserModel: false,
        threshold: 'low',
      }))
      expect(result.isAmbiguous).toBe(true)
      expect(result.score).toBeGreaterThan(0.5)
    })

    it('reason includes all triggered heuristics', () => {
      const result = detectAmbiguity(makeInput({
        toolName: 'Edit',
        toolParameters: {},
        recentUserMessages: ['fix style'],
        hasUserModel: false,
      }))
      expect(result.reason).toContain('Short or vague')
      expect(result.reason).toContain('Edit tool')
      expect(result.reason).toContain('No user model')
    })

    it('reason is descriptive when no ambiguity detected', () => {
      const result = detectAmbiguity(makeInput({
        toolName: 'Read',
        toolParameters: { file_path: '/src/index.ts' },
        recentUserMessages: ['Please read the main entry file at /src/index.ts and tell me what it exports'],
        hasUserModel: true,
      }))
      expect(result.reason).toBe('No ambiguity detected')
    })
  })
})
