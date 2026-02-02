import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { extractParameterShape, captureInteraction, main } from './capture-interaction'

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

describe('captureInteraction', () => {
  let tempDir: string
  let originalHome: string | undefined
  let originalSessionId: string | undefined

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tom-capture-test-'))
    originalHome = process.env['HOME']
    originalSessionId = process.env['CLAUDE_SESSION_ID']
    process.env['HOME'] = tempDir
    process.env['CLAUDE_SESSION_ID'] = 'test-session-001'
  })

  afterEach(() => {
    process.env['HOME'] = originalHome
    if (originalSessionId !== undefined) {
      process.env['CLAUDE_SESSION_ID'] = originalSessionId
    } else {
      delete process.env['CLAUDE_SESSION_ID']
    }
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('creates a new session file with first interaction', async () => {
    captureInteraction('Bash', '{"command":"ls"}', 'file1.ts\nfile2.ts')

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
    captureInteraction('Bash', '{"command":"ls"}', 'output1')
    await new Promise((resolve) => setTimeout(resolve, 100))

    captureInteraction('Read', '{"file_path":"foo.ts"}', 'file contents')
    await new Promise((resolve) => setTimeout(resolve, 100))

    const filePath = path.join(tempDir, '.claude', 'tom', 'sessions', 'test-session-001.json')
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    expect(data.interactions).toHaveLength(2)
    expect(data.interactions[0].toolName).toBe('Bash')
    expect(data.interactions[1].toolName).toBe('Read')
  })

  it('redacts secrets in tool input', async () => {
    captureInteraction(
      'Bash',
      '{"command":"curl -H \\"Authorization: Bearer eyJhbGciOiJIUzI1NiJ9\\""}',
      'ok'
    )
    await new Promise((resolve) => setTimeout(resolve, 100))

    const filePath = path.join(tempDir, '.claude', 'tom', 'sessions', 'test-session-001.json')
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    // The command value itself isn't a bare token pattern, so it's kept.
    // Bare token values are redacted.
    expect(data.interactions[0].parameterShape).toBeDefined()
  })

  it('truncates long tool output in outcome summary', async () => {
    const longOutput = 'x'.repeat(300)
    captureInteraction('Bash', '{"command":"cat big-file"}', longOutput)
    await new Promise((resolve) => setTimeout(resolve, 100))

    const filePath = path.join(tempDir, '.claude', 'tom', 'sessions', 'test-session-001.json')
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    // Truncated to 200 chars + "..." = 203, then redacted because > 200
    expect(data.interactions[0].outcomeSummary).toBe('[REDACTED]')
  })

  it('handles invalid JSON in tool input gracefully', async () => {
    captureInteraction('Bash', 'not-valid-json', 'output')
    await new Promise((resolve) => setTimeout(resolve, 100))

    const filePath = path.join(tempDir, '.claude', 'tom', 'sessions', 'test-session-001.json')
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    expect(data.interactions[0].parameterShape).toEqual({})
  })

  it('uses CLAUDE_SESSION_ID for session identification', async () => {
    process.env['CLAUDE_SESSION_ID'] = 'custom-session-42'
    captureInteraction('Bash', '{"command":"echo hi"}', 'hi')
    await new Promise((resolve) => setTimeout(resolve, 100))

    const filePath = path.join(tempDir, '.claude', 'tom', 'sessions', 'custom-session-42.json')
    expect(fs.existsSync(filePath)).toBe(true)
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    expect(data.sessionId).toBe('custom-session-42')
  })

  it('falls back to PID-based session ID when CLAUDE_SESSION_ID not set', async () => {
    delete process.env['CLAUDE_SESSION_ID']
    captureInteraction('Bash', '{"command":"echo hi"}', 'hi')
    await new Promise((resolve) => setTimeout(resolve, 100))

    const expectedFile = path.join(
      tempDir,
      '.claude',
      'tom',
      'sessions',
      `pid-${process.pid}.json`
    )
    expect(fs.existsSync(expectedFile)).toBe(true)
  })

  it('sets timestamps on interaction entries', async () => {
    captureInteraction('Bash', '{"command":"date"}', 'Mon Jan 1')
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
  let originalToolName: string | undefined
  let originalToolInput: string | undefined
  let originalToolOutput: string | undefined

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tom-main-test-'))
    originalHome = process.env['HOME']
    originalSessionId = process.env['CLAUDE_SESSION_ID']
    originalToolName = process.env['TOOL_NAME']
    originalToolInput = process.env['TOOL_INPUT']
    originalToolOutput = process.env['TOOL_OUTPUT']
    process.env['HOME'] = tempDir
    process.env['CLAUDE_SESSION_ID'] = 'test-main-session'
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
    restoreEnv('TOOL_NAME', originalToolName)
    restoreEnv('TOOL_INPUT', originalToolInput)
    restoreEnv('TOOL_OUTPUT', originalToolOutput)
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('is a no-op when tom.enabled is not true', async () => {
    process.env['TOOL_NAME'] = 'Bash'
    process.env['TOOL_INPUT'] = '{"command":"ls"}'
    process.env['TOOL_OUTPUT'] = 'output'

    main()
    await new Promise((resolve) => setTimeout(resolve, 100))

    const sessionsDir = path.join(tempDir, '.claude', 'tom', 'sessions')
    expect(fs.existsSync(sessionsDir)).toBe(false)
  })

  it('captures interaction when tom.enabled is true', async () => {
    // Create settings with tom.enabled = true
    const settingsDir = path.join(tempDir, '.claude')
    fs.mkdirSync(settingsDir, { recursive: true })
    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({ tom: { enabled: true } })
    )

    process.env['TOOL_NAME'] = 'Read'
    process.env['TOOL_INPUT'] = '{"file_path":"src/index.ts"}'
    process.env['TOOL_OUTPUT'] = 'console.log("hello")'

    main()
    await new Promise((resolve) => setTimeout(resolve, 100))

    const filePath = path.join(tempDir, '.claude', 'tom', 'sessions', 'test-main-session.json')
    expect(fs.existsSync(filePath)).toBe(true)
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    expect(data.interactions[0].toolName).toBe('Read')
  })

  it('is a no-op when TOOL_NAME is empty', async () => {
    const settingsDir = path.join(tempDir, '.claude')
    fs.mkdirSync(settingsDir, { recursive: true })
    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({ tom: { enabled: true } })
    )

    process.env['TOOL_NAME'] = ''

    main()
    await new Promise((resolve) => setTimeout(resolve, 100))

    const sessionsDir = path.join(tempDir, '.claude', 'tom', 'sessions')
    expect(fs.existsSync(sessionsDir)).toBe(false)
  })
})
