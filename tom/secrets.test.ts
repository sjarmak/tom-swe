import { describe, it, expect } from 'vitest'
import { looksLikeSecret, sanitizeValue, REDACTED, MAX_VALUE_LENGTH } from './secrets'

describe('looksLikeSecret', () => {
  it.each([
    ['OpenAI-style key', 'sk-proj-abc123def456'],
    ['GitHub personal token', 'ghp_abc123def456'],
    ['GitHub OAuth token', 'gho_abc123'],
    ['GitHub server token', 'ghs_abc123'],
    ['GitHub fine-grained PAT', 'github_pat_abc_123'],
    ['Bearer token', 'Bearer eyJhbGciOiJIUzI1NiJ9'],
    ['Basic auth', 'Basic dXNlcjpwYXNz'],
    ['generic token prefix', 'token abc123'],
    ['Slack token', 'xoxb-123-456-abc'],
    ['AWS access key', 'AKIAIOSFODNN7EXAMPLE'],
    ['JWT token', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig'],
    ['password= pattern', 'password=mysecret'],
    ['40-char hex token', 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3'],
    ['npm token', 'npm_abc123def456'],
    ['PyPI token', 'pypi-AgEIcHlwaS5vcmc'],
    ['ENV_VAR=sk- pattern', 'OPENAI_API_KEY=sk-abc123'],
    ['_KEY=value pattern', 'STRIPE_KEY=whatever'],
  ])('detects %s', (_label, value) => {
    expect(looksLikeSecret(value)).toBe(true)
  })

  it('detects secrets with surrounding whitespace', () => {
    expect(looksLikeSecret('  sk-abc123  ')).toBe(true)
  })

  it.each([
    ['plain file path', 'src/index.ts'],
    ['ordinary command', 'npm install express'],
    ['short hex (not 40 chars)', 'deadbeef'],
    ['empty string', ''],
  ])('does not flag %s', (_label, value) => {
    expect(looksLikeSecret(value)).toBe(false)
  })
})

describe('sanitizeValue', () => {
  it('redacts secret values', () => {
    expect(sanitizeValue('ghp_abc123def456')).toBe(REDACTED)
  })

  it('redacts values longer than MAX_VALUE_LENGTH', () => {
    expect(sanitizeValue('a'.repeat(MAX_VALUE_LENGTH + 1))).toBe(REDACTED)
  })

  it('keeps values at exactly MAX_VALUE_LENGTH', () => {
    const value = 'a'.repeat(MAX_VALUE_LENGTH)
    expect(sanitizeValue(value)).toBe(value)
  })

  it('returns non-secret values unchanged', () => {
    expect(sanitizeValue('git push')).toBe('git push')
  })
})
