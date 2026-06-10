import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { Readable } from 'node:stream'
import {
  extractParameterShape,
  summarizeToolResponse,
  captureInteraction,
  main,
} from './capture-interaction'

describe('extractParameterShape', () => {
  it('extracts string values normally', () => {
    const result = extractParameterShape({ name: 'test', file: 'foo.ts' })
    expect(result).toEqual({ name: 'test', file: 'foo.ts' })
  })

  it('converts number and boolean values to strings', () => {
    const result = extractParameterShape({ count: 5, verbose: true })
    expect(result).toEqual({ count: '5', verbose: 'true' })
  })

  it('handles null and undefined values', () => {
    const result = extractParameterShape({ a: null, b: undefined })
    expect(result).toEqual({ a: 'null', b: 'null' })
  })

  it('shows type for complex values', () => {
    const result = extractParameterShape({ items: [1, 2, 3], nested: { a: 1 } })
    expect(result).toEqual({ items: 'object', nested: 'object' })
  })

  it('redacts OpenAI-style API keys', () => {
    const result = extractParameterShape({ apiKey: 'sk-proj-abc123XYZ' })
    expect(result).toEqual({ apiKey: '[REDACTED]' })
  })

  it('redacts GitHub personal access tokens', () => {
    const result = extractParameterShape({ token: 'ghp_abc123def456' })
    expect(result).toEqual({ token: '[REDACTED]' })
  })

  it('redacts Bearer tokens', () => {
    const result = extractParameterShape({ auth: 'Bearer eyJhbGciOiJIUzI1NiJ9' })
    expect(result).toEqual({ auth: '[REDACTED]' })
  })

  it('redacts JWT tokens', () => {
    const result = extractParameterShape({
      jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc',
    })
    expect(result).toEqual({ jwt: '[REDACTED]' })
  })

  it('redacts password patterns', () => {
    const result = extractParameterShape({ creds: 'password=mysecret123' })
    expect(result).toEqual({ creds: '[REDACTED]' })
  })

  it('redacts Slack tokens', () => {
    const result = extractParameterShape({ slack: 'xoxb-123456789-abcdef' })
    expect(result).toEqual({ slack: '[REDACTED]' })
  })

  it('redacts AWS access keys', () => {
    const result = extractParameterShape({ aws: 'AKIA1234567890ABCDEF' })
    expect(result).toEqual({ aws: '[REDACTED]' })
  })

  it('redacts npm tokens', () => {
    const result = extractParameterShape({ npm: 'npm_abc123def456' })
    expect(result).toEqual({ npm: '[REDACTED]' })
  })

  it('redacts values longer than 200 characters (file contents)', () => {
    const longContent = 'a'.repeat(201)
    const result = extractParameterShape({ content: longContent })
    expect(result).toEqual({ content: '[REDACTED]' })
  })

  it('keeps values at exactly 200 characters', () => {
    const content = 'a'.repeat(200)
    const result = extractParameterShape({ content })
    expect(result).toEqual({ content })
  })

  it('preserves parameter keys while redacting values', () => {
    const result = extractParameterShape({
      apiKey: 'sk-test123',
      command: 'npm install',
      token: 'ghp_secret',
    })
    expect(Object.keys(result)).toEqual(['apiKey', 'command', 'token'])
    expect(result['apiKey']).toBe('[REDACTED]')
    expect(result['command']).toBe('npm install')
    expect(result['token']).toBe('[REDACTED]')
  })
})

describe('summarizeToolResponse', () => {
  it('returns strings unchanged', () => {
    expect(summarizeToolResponse('plain output')).toBe('plain output')
  })

  it('returns empty string for null and undefined', () => {
    expect(summarizeToolResponse(null)).toBe('')
    expect(summarizeToolResponse(undefined)).toBe('')
  })

  it('stringifies object responses', () => {
    expect(summarizeToolResponse({ stdout: 'ok', exitCode: 0 })).toBe(
      '{"stdout":"ok","exitCode":0}'
    )
  })
})

describe('captureInteraction', () => {
  let tempDir: string
  let originalHome: string | undefined

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tom-capture-test-'))
    originalHome = process.env['HOME']
    process.env['HOME'] = tempDir
  })

  afterEach(() => {
    process.env['HOME'] = originalHome
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('creates a new session file with first interaction', async () => {
    captureInteraction('test-session-001', 'Bash', { command: 'ls' }, 'file1.ts\nfile2.ts')

    // Wait for async write
    await new Promise((resolve) => setTimeout(resolve, 100))

    const filePath = path.join(tempDir, '.claude', 'tom', 'sessions', 'test-session-001.json')
    expect(fs.existsSync(filePath)).toBe(true)

    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    expect(data.sessionId).toBe('test-session-001')
    expect(data.interactions).toHaveLength(1)
    expect(data.interactions[0].toolName).toBe('Bash')
    expect(data.interactions[0].parameterShape).toEqual({ command: 'ls' })
  })

  it('appends interactions to existing session file', async () => {
    captureInteraction('test-session-001', 'Bash', { command: 'ls' }, 'output1')
    await new Promise((resolve) => setTimeout(resolve, 100))

    captureInteraction('test-session-001', 'Read', { file_path: 'foo.ts' }, 'file contents')
    await new Promise((resolve) => setTimeout(resolve, 100))

    const filePath = path.join(tempDir, '.claude', 'tom', 'sessions', 'test-session-001.json')
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    expect(data.interactions).toHaveLength(2)
    expect(data.interactions[0].toolName).toBe('Bash')
    expect(data.interactions[1].toolName).toBe('Read')
  })

  it('redacts bare secret values in tool input', async () => {
    captureInteraction(
      'test-session-001',
      'Bash',
      { token: 'ghp_abc123def456', command: 'git push' },
      'ok'
    )
    await new Promise((resolve) => setTimeout(resolve, 100))

    const filePath = path.join(tempDir, '.claude', 'tom', 'sessions', 'test-session-001.json')
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    expect(data.interactions[0].parameterShape).toEqual({
      token: '[REDACTED]',
      command: 'git push',
    })
  })

  it('truncates long tool output in outcome summary', async () => {
    const longOutput = 'x'.repeat(300)
    captureInteraction('test-session-001', 'Bash', { command: 'cat big-file' }, longOutput)
    await new Promise((resolve) => setTimeout(resolve, 100))

    const filePath = path.join(tempDir, '.claude', 'tom', 'sessions', 'test-session-001.json')
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    // Truncated to 200 chars + "..." = 203, then redacted because > 200
    expect(data.interactions[0].outcomeSummary).toBe('[REDACTED]')
  })

  it('logs write failures to stderr instead of swallowing them', async () => {
    // Occupy the session file path with a directory so writeFile fails (EISDIR)
    const filePath = path.join(tempDir, '.claude', 'tom', 'sessions', 'broken-session.json')
    fs.mkdirSync(filePath, { recursive: true })

    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true)
    try {
      captureInteraction('broken-session', 'Bash', { command: 'ls' }, 'out')
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('ToM capture-interaction write error:')
      )
    } finally {
      stderrSpy.mockRestore()
    }
  })

  it('sets timestamps on interaction entries', async () => {
    captureInteraction('test-session-001', 'Bash', { command: 'date' }, 'Mon Jan 1')
    await new Promise((resolve) => setTimeout(resolve, 100))

    const filePath = path.join(tempDir, '.claude', 'tom', 'sessions', 'test-session-001.json')
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    expect(data.startedAt).toBeDefined()
    expect(data.endedAt).toBeDefined()
    expect(data.interactions[0].timestamp).toBeDefined()
    // Verify timestamps are valid ISO strings
    expect(new Date(data.startedAt).toISOString()).toBe(data.startedAt)
  })
})

describe('main', () => {
  let tempDir: string
  let originalHome: string | undefined
  let originalSessionId: string | undefined
  let originalInternal: string | undefined

  function enableTom(): void {
    const tomDir = path.join(tempDir, '.claude', 'tom')
    fs.mkdirSync(tomDir, { recursive: true })
    fs.writeFileSync(
      path.join(tomDir, 'config.json'),
      JSON.stringify({ enabled: true })
    )
  }

  function payloadStream(payload: Record<string, unknown>): Readable {
    return Readable.from([JSON.stringify(payload)])
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tom-main-test-'))
    originalHome = process.env['HOME']
    originalSessionId = process.env['CLAUDE_SESSION_ID']
    originalInternal = process.env['TOM_SWE_INTERNAL']
    process.env['HOME'] = tempDir
    delete process.env['CLAUDE_SESSION_ID']
    delete process.env['TOM_SWE_INTERNAL']
  })

  afterEach(() => {
    process.env['HOME'] = originalHome
    const restoreEnv = (key: string, original: string | undefined) => {
      if (original !== undefined) {
        process.env[key] = original
      } else {
        delete process.env[key]
      }
    }
    restoreEnv('CLAUDE_SESSION_ID', originalSessionId)
    restoreEnv('TOM_SWE_INTERNAL', originalInternal)
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('is a no-op when tom.enabled is not true', async () => {
    await main(payloadStream({
      session_id: 'disabled-session',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_response: 'output',
    }))
    await new Promise((resolve) => setTimeout(resolve, 100))

    const sessionsDir = path.join(tempDir, '.claude', 'tom', 'sessions')
    expect(fs.existsSync(sessionsDir)).toBe(false)
  })

  it('captures interaction from the stdin payload when tom.enabled is true', async () => {
    enableTom()

    await main(payloadStream({
      session_id: 'stdin-session',
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'src/index.ts' },
      tool_response: 'file contents here',
    }))
    await new Promise((resolve) => setTimeout(resolve, 100))

    const filePath = path.join(tempDir, '.claude', 'tom', 'sessions', 'stdin-session.json')
    expect(fs.existsSync(filePath)).toBe(true)
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    expect(data.sessionId).toBe('stdin-session')
    expect(data.interactions[0].toolName).toBe('Read')
    expect(data.interactions[0].parameterShape).toEqual({ file_path: 'src/index.ts' })
    expect(data.interactions[0].outcomeSummary).toBe('file contents here')
  })

  it('stringifies object tool_response into the outcome summary', async () => {
    enableTom()

    await main(payloadStream({
      session_id: 'object-response',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'true' },
      tool_response: { stdout: 'ok', exitCode: 0 },
    }))
    await new Promise((resolve) => setTimeout(resolve, 100))

    const filePath = path.join(tempDir, '.claude', 'tom', 'sessions', 'object-response.json')
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    expect(data.interactions[0].outcomeSummary).toBe('{"stdout":"ok","exitCode":0}')
  })

  it('prefers payload session_id over CLAUDE_SESSION_ID', async () => {
    enableTom()
    process.env['CLAUDE_SESSION_ID'] = 'env-session'

    await main(payloadStream({
      session_id: 'payload-session',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_response: 'out',
    }))
    await new Promise((resolve) => setTimeout(resolve, 100))

    const sessionsDir = path.join(tempDir, '.claude', 'tom', 'sessions')
    expect(fs.existsSync(path.join(sessionsDir, 'payload-session.json'))).toBe(true)
    expect(fs.existsSync(path.join(sessionsDir, 'env-session.json'))).toBe(false)
  })

  it('is a no-op on empty stdin', async () => {
    enableTom()

    await main(Readable.from(['']))
    await new Promise((resolve) => setTimeout(resolve, 100))

    const sessionsDir = path.join(tempDir, '.claude', 'tom', 'sessions')
    expect(fs.existsSync(sessionsDir)).toBe(false)
  })

  it('is a no-op on malformed stdin JSON', async () => {
    enableTom()

    await main(Readable.from(['{broken json']))
    await new Promise((resolve) => setTimeout(resolve, 100))

    const sessionsDir = path.join(tempDir, '.claude', 'tom', 'sessions')
    expect(fs.existsSync(sessionsDir)).toBe(false)
  })

  it('is a no-op when the payload has no tool_name', async () => {
    enableTom()

    await main(payloadStream({
      session_id: 'no-tool',
      hook_event_name: 'PostToolUse',
    }))
    await new Promise((resolve) => setTimeout(resolve, 100))

    const sessionsDir = path.join(tempDir, '.claude', 'tom', 'sessions')
    expect(fs.existsSync(sessionsDir)).toBe(false)
  })

  it('exits silently when TOM_SWE_INTERNAL is "1"', async () => {
    enableTom()
    process.env['TOM_SWE_INTERNAL'] = '1'

    await main(payloadStream({
      session_id: 'internal-session',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_response: 'out',
    }))
    await new Promise((resolve) => setTimeout(resolve, 100))

    const sessionsDir = path.join(tempDir, '.claude', 'tom', 'sessions')
    expect(fs.existsSync(sessionsDir)).toBe(false)
  })
})
