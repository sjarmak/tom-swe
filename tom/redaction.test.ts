import { describe, it, expect } from 'vitest'
import { redactToolInput, redactUserMessage } from './redaction'

describe('redactToolInput', () => {
  it('returns a new object (no mutation)', () => {
    const input = { name: 'hello', key: 'sk-abc123def456' }
    const result = redactToolInput(input)
    expect(result).not.toBe(input)
    expect(input['key']).toBe('sk-abc123def456')
  })

  it('keeps non-secret string values unchanged', () => {
    const input = { file: 'src/index.ts', action: 'read' }
    const result = redactToolInput(input)
    expect(result).toEqual({ file: 'src/index.ts', action: 'read' })
  })

  it('redacts OpenAI-style API keys (sk-*)', () => {
    const result = redactToolInput({ key: 'sk-proj-abc123def456ghi789' })
    expect(result['key']).toBe('[REDACTED]')
  })

  it('redacts GitHub personal access tokens (ghp_*)', () => {
    const result = redactToolInput({ token: 'ghp_1234567890abcdef1234567890abcdef12345678' })
    expect(result['token']).toBe('[REDACTED]')
  })

  it('redacts GitHub OAuth tokens (gho_*)', () => {
    const result = redactToolInput({ token: 'gho_abc123' })
    expect(result['token']).toBe('[REDACTED]')
  })

  it('redacts GitHub server tokens (ghs_*)', () => {
    const result = redactToolInput({ token: 'ghs_abc123' })
    expect(result['token']).toBe('[REDACTED]')
  })

  it('redacts GitHub fine-grained PATs (github_pat_*)', () => {
    const result = redactToolInput({ token: 'github_pat_abc_123' })
    expect(result['token']).toBe('[REDACTED]')
  })

  it('redacts Bearer tokens', () => {
    const result = redactToolInput({ auth: 'Bearer eyJhbGciOiJIUzI1NiJ9.test' })
    expect(result['auth']).toBe('[REDACTED]')
  })

  it('redacts Basic auth', () => {
    const result = redactToolInput({ auth: 'Basic dXNlcjpwYXNz' })
    expect(result['auth']).toBe('[REDACTED]')
  })

  it('redacts Slack tokens (xox*)', () => {
    const result = redactToolInput({ token: 'xoxb-123-456-abc' })
    expect(result['token']).toBe('[REDACTED]')
  })

  it('redacts AWS access keys (AKIA*)', () => {
    const result = redactToolInput({ key: 'AKIAIOSFODNN7EXAMPLE' })
    expect(result['key']).toBe('[REDACTED]')
  })

  it('redacts JWT tokens', () => {
    const result = redactToolInput({ token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U' })
    expect(result['token']).toBe('[REDACTED]')
  })

  it('redacts password= patterns', () => {
    const result = redactToolInput({ config: 'password=mysecretpassword' })
    expect(result['config']).toBe('[REDACTED]')
  })

  it('redacts npm tokens (npm_*)', () => {
    const result = redactToolInput({ token: 'npm_abc123def456' })
    expect(result['token']).toBe('[REDACTED]')
  })

  it('redacts PyPI tokens (pypi-*)', () => {
    const result = redactToolInput({ token: 'pypi-AgEIcHlwaS5vcmcCJGY' })
    expect(result['token']).toBe('[REDACTED]')
  })

  it('redacts file contents longer than 200 chars', () => {
    const longContent = 'a'.repeat(201)
    const result = redactToolInput({ content: longContent })
    expect(result['content']).toBe('[REDACTED]')
  })

  it('keeps values at exactly 200 chars', () => {
    const content = 'a'.repeat(200)
    const result = redactToolInput({ content })
    expect(result['content']).toBe(content)
  })

  it('preserves parameter keys but replaces secret values', () => {
    const input = {
      apiKey: 'sk-secret123',
      name: 'test',
      token: 'ghp_secrettoken123',
    }
    const result = redactToolInput(input)
    expect(Object.keys(result)).toEqual(['apiKey', 'name', 'token'])
    expect(result['apiKey']).toBe('[REDACTED]')
    expect(result['name']).toBe('test')
    expect(result['token']).toBe('[REDACTED]')
  })

  it('handles non-string values by preserving them as strings', () => {
    const input = { count: 42, flag: true, empty: null }
    const result = redactToolInput(input as Record<string, unknown>)
    expect(result['count']).toBe('42')
    expect(result['flag']).toBe('true')
    expect(result['empty']).toBe('null')
  })

  it('handles nested objects by showing type', () => {
    const input = { nested: { a: 1 }, arr: [1, 2] }
    const result = redactToolInput(input as Record<string, unknown>)
    expect(result['nested']).toBe('object')
    expect(result['arr']).toBe('object')
  })

  it('handles empty input', () => {
    const result = redactToolInput({})
    expect(result).toEqual({})
  })

  it('redacts environment variable patterns', () => {
    const result = redactToolInput({ env: 'OPENAI_API_KEY=sk-abc123' })
    expect(result['env']).toBe('[REDACTED]')
  })
})

describe('redactUserMessage', () => {
  it('returns a new string (not mutating context)', () => {
    const msg = 'hello world'
    const result = redactUserMessage(msg)
    expect(result).toBe('hello world')
  })

  it('strips inline code blocks', () => {
    const msg = 'Please run `npm install express` and then `npm start`'
    const result = redactUserMessage(msg)
    expect(result).toBe('Please run [CODE] and then [CODE]')
  })

  it('strips fenced code blocks', () => {
    const msg = 'Here is my code:\n```typescript\nconst x = 1;\nconsole.log(x);\n```\nWhat do you think?'
    const result = redactUserMessage(msg)
    expect(result).toBe('Here is my code:\n[CODE_BLOCK]\nWhat do you think?')
  })

  it('strips URLs with query params', () => {
    const msg = 'Check https://example.com/api?key=secret&token=abc123 for details'
    const result = redactUserMessage(msg)
    expect(result).toBe('Check [URL] for details')
  })

  it('preserves URLs without query params', () => {
    const msg = 'Check https://example.com/docs for details'
    const result = redactUserMessage(msg)
    expect(result).toBe('Check https://example.com/docs for details')
  })

  it('handles multiple code blocks and URLs', () => {
    const msg = 'Run `cmd1` then visit https://api.com?token=xyz then `cmd2`'
    const result = redactUserMessage(msg)
    expect(result).toBe('Run [CODE] then visit [URL] then [CODE]')
  })

  it('handles empty string', () => {
    const result = redactUserMessage('')
    expect(result).toBe('')
  })

  it('handles message with no sensitive content', () => {
    const msg = 'Please fix the bug in the login page'
    const result = redactUserMessage(msg)
    expect(result).toBe('Please fix the bug in the login page')
  })

  it('strips URLs with fragment and query params', () => {
    const msg = 'See https://example.com/page?auth=token#section for info'
    const result = redactUserMessage(msg)
    expect(result).toBe('See [URL] for info')
  })
})
