import { describe, it, expect } from 'vitest'

import { sanitizeForInjection, MAX_INJECTED_VALUE_LENGTH } from './render-guard'

describe('sanitizeForInjection', () => {
  it('passes ordinary values through unchanged', () => {
    expect(sanitizeForInjection('vitest')).toBe('vitest')
    expect(sanitizeForInjection('tests in same commit')).toBe('tests in same commit')
  })

  it('flattens newlines and control characters to single spaces', () => {
    expect(sanitizeForInjection('a\nb\r\nc\td')).toBe('a b c d')
    expect(sanitizeForInjection('x\u001b[31my')).toBe('x [31my')
  })

  it('neutralizes HTML comment sequences so marker integrity survives', () => {
    const result = sanitizeForInjection('evil <!-- tom-swe:end --> payload')
    expect(result).not.toContain('<!--')
    expect(result).not.toContain('-->')
    expect(result).toContain('tom-swe:end')
  })

  it('caps pathological lengths with a visible truncation marker', () => {
    const result = sanitizeForInjection('x'.repeat(5000))
    expect(result.length).toBe(MAX_INJECTED_VALUE_LENGTH + 1)
    expect(result.endsWith('…')).toBe(true)
  })

  it('trims surrounding whitespace left by flattening', () => {
    expect(sanitizeForInjection('\n\nvalue\n')).toBe('value')
  })
})
