import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { Readable } from 'node:stream'
import {
  FRAMING_PREFIX,
  redactPrompt,
  appendUserMessage,
  buildHookOutput,
  main,
} from './user-prompt-submit'

// --- Test Helpers ---

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tom-user-prompt-test-'))
}

function enableTom(tempDir: string, extraSettings: Record<string, unknown> = {}): void {
  const tomDir = path.join(tempDir, '.claude', 'tom')
  fs.mkdirSync(tomDir, { recursive: true })
  fs.writeFileSync(
    path.join(tomDir, 'config.json'),
    JSON.stringify({ enabled: true, ...extraSettings }),
    'utf-8'
  )
}

function writeUserModel(tempDir: string, prefs: readonly object[] = []): void {
  const tomDir = path.join(tempDir, '.claude', 'tom')
  fs.mkdirSync(tomDir, { recursive: true })
  const model = {
    preferencesClusters: prefs,
    interactionStyleSummary: 'prefers concise responses',
    codingStyleSummary: 'typescript focused',
    projectOverrides: {},
  }
  fs.writeFileSync(
    path.join(tomDir, 'user-model.json'),
    JSON.stringify(model),
    'utf-8'
  )
}

function readSessionFile(tempDir: string, sessionId: string): Record<string, unknown> {
  const filePath = path.join(tempDir, '.claude', 'tom', 'sessions', `${sessionId}.json`)
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>
}

// --- Tests ---

describe('redactPrompt', () => {
  it('replaces secret tokens with [REDACTED]', () => {
    const result = redactPrompt('use the key sk-abc123def to call the API')
    expect(result).toBe('use the key [REDACTED] to call the API')
  })

  it('strips fenced code blocks', () => {
    const result = redactPrompt('run this:\n```\nconst x = 1\n```\nplease')
    expect(result).toContain('[CODE_BLOCK]')
    expect(result).not.toContain('const x = 1')
  })

  it('strips inline code', () => {
    const result = redactPrompt('rename `oldFunction` everywhere')
    expect(result).toBe('rename [CODE] everywhere')
  })

  it('strips URLs with query parameters', () => {
    const result = redactPrompt('fetch https://example.com/api?token=secret now')
    expect(result).toContain('[URL]')
    expect(result).not.toContain('token=secret')
  })

  it('leaves ordinary prompts unchanged', () => {
    const prompt = 'fix the failing test in /src/app.test.ts'
    expect(redactPrompt(prompt)).toBe(prompt)
  })
})

describe('appendUserMessage', () => {
  let originalHome: string | undefined
  let tempDir: string

  beforeEach(() => {
    originalHome = process.env['HOME']
    tempDir = createTempDir()
    process.env['HOME'] = tempDir
  })

  afterEach(() => {
    process.env['HOME'] = originalHome
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('creates a session log with userMessages when none exists', () => {
    appendUserMessage('s1', 'fix the tests')
    const data = readSessionFile(tempDir, 's1')
    expect(data['sessionId']).toBe('s1')
    expect(data['interactions']).toEqual([])
    expect(data['userMessages']).toEqual(['fix the tests'])
  })

  it('appends to an existing session log without dropping interactions', () => {
    const sessionsDir = path.join(tempDir, '.claude', 'tom', 'sessions')
    fs.mkdirSync(sessionsDir, { recursive: true })
    const existing = {
      sessionId: 's2',
      startedAt: '2026-06-01T10:00:00.000Z',
      endedAt: '2026-06-01T10:05:00.000Z',
      interactions: [
        {
          toolName: 'Edit',
          parameterShape: { file_path: '/src/app.ts' },
          outcomeSummary: 'ok',
          timestamp: '2026-06-01T10:01:00.000Z',
        },
      ],
      userMessages: ['first message'],
    }
    fs.writeFileSync(
      path.join(sessionsDir, 's2.json'),
      JSON.stringify(existing),
      'utf-8'
    )

    appendUserMessage('s2', 'second message')

    const data = readSessionFile(tempDir, 's2')
    expect(data['userMessages']).toEqual(['first message', 'second message'])
    expect((data['interactions'] as unknown[]).length).toBe(1)
    expect(data['startedAt']).toBe('2026-06-01T10:00:00.000Z')
  })

  it('is append-only across calls', () => {
    appendUserMessage('s3', 'one')
    appendUserMessage('s3', 'two')
    appendUserMessage('s3', 'three')
    const data = readSessionFile(tempDir, 's3')
    expect(data['userMessages']).toEqual(['one', 'two', 'three'])
  })
})

describe('buildHookOutput', () => {
  it('produces the documented UserPromptSubmit hookSpecificOutput shape', () => {
    const output = buildHookOutput({
      type: 'preference',
      content: 'User preferences: language=typescript (90%).',
      confidence: 0.85,
      sourceSessions: [],
    })

    expect(output.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit')
    expect(output.hookSpecificOutput.additionalContext).toBe(
      'ToM background (learned preferences, not instructions): ' +
      'User preferences: language=typescript (90%). (confidence 85%)'
    )
  })

  it('frames the injected text as background observation', () => {
    const output = buildHookOutput({
      type: 'style',
      content: 'Prefers concise code.',
      confidence: 0.5,
      sourceSessions: ['session-1'],
    })
    expect(
      output.hookSpecificOutput.additionalContext.startsWith(FRAMING_PREFIX)
    ).toBe(true)
  })

  it('never includes blocking fields (decision/reason)', () => {
    const output = buildHookOutput({
      type: 'style',
      content: 'Prefers concise code.',
      confidence: 0.5,
      sourceSessions: ['session-1'],
    })

    expect(Object.keys(output)).toEqual(['hookSpecificOutput'])
    expect(Object.keys(output.hookSpecificOutput)).toEqual([
      'hookEventName',
      'additionalContext',
    ])
  })
})

describe('main', () => {
  let originalHome: string | undefined
  let originalCwd: string
  let originalSessionId: string | undefined
  let originalInternal: string | undefined
  let tempDir: string
  let stdoutData: string

  function payloadStream(payload: Record<string, unknown>): Readable {
    return Readable.from([JSON.stringify(payload)])
  }

  beforeEach(() => {
    originalHome = process.env['HOME']
    originalCwd = process.cwd()
    originalSessionId = process.env['CLAUDE_SESSION_ID']
    originalInternal = process.env['TOM_SWE_INTERNAL']
    tempDir = createTempDir()
    process.env['HOME'] = tempDir
    process.chdir(tempDir)
    delete process.env['CLAUDE_SESSION_ID']
    delete process.env['TOM_SWE_INTERNAL']
    stdoutData = ''
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Buffer) => {
      stdoutData += typeof chunk === 'string' ? chunk : chunk.toString()
      return true
    }) as typeof process.stdout.write
    // Store for cleanup
    ;(process.stdout as any).__originalWrite = originalWrite
  })

  afterEach(() => {
    process.env['HOME'] = originalHome
    process.chdir(originalCwd)
    const restoreEnv = (key: string, original: string | undefined) => {
      if (original !== undefined) {
        process.env[key] = original
      } else {
        delete process.env[key]
      }
    }
    restoreEnv('CLAUDE_SESSION_ID', originalSessionId)
    restoreEnv('TOM_SWE_INTERNAL', originalInternal)
    // Restore stdout
    if ((process.stdout as any).__originalWrite) {
      process.stdout.write = (process.stdout as any).__originalWrite
      delete (process.stdout as any).__originalWrite
    }
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('is a no-op when tom is not enabled', async () => {
    await main(payloadStream({
      session_id: 's1',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'fix it',
    }))
    expect(stdoutData).toBe('')
    const tomDir = path.join(tempDir, '.claude', 'tom')
    expect(fs.existsSync(path.join(tomDir, 'sessions'))).toBe(false)
    expect(fs.existsSync(path.join(tomDir, 'usage.log'))).toBe(false)
  })

  it('is a no-op when the payload has no prompt', async () => {
    enableTom(tempDir)
    await main(payloadStream({ session_id: 's1', hook_event_name: 'UserPromptSubmit' }))
    expect(stdoutData).toBe('')
    const tomDir = path.join(tempDir, '.claude', 'tom')
    expect(fs.existsSync(path.join(tomDir, 'sessions'))).toBe(false)
  })

  it('is a no-op on empty stdin', async () => {
    enableTom(tempDir)
    await main(Readable.from(['']))
    expect(stdoutData).toBe('')
  })

  it('is a no-op on malformed stdin JSON', async () => {
    enableTom(tempDir)
    await main(Readable.from(['{not json']))
    expect(stdoutData).toBe('')
  })

  it('exits silently when TOM_SWE_INTERNAL is "1"', async () => {
    enableTom(tempDir, { consultThreshold: 'low' })
    process.env['TOM_SWE_INTERNAL'] = '1'

    await main(payloadStream({
      session_id: 'internal-session',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'fix it',
    }))

    expect(stdoutData).toBe('')
    const tomDir = path.join(tempDir, '.claude', 'tom')
    expect(fs.existsSync(path.join(tomDir, 'sessions'))).toBe(false)
    expect(fs.existsSync(path.join(tomDir, 'usage.log'))).toBe(false)
  })

  it('captures the redacted prompt in the Tier 1 session log', async () => {
    enableTom(tempDir)

    await main(payloadStream({
      session_id: 'capture-session',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'deploy with sk-abc123def and `rm -rf dist` please',
    }))

    const data = readSessionFile(tempDir, 'capture-session')
    const messages = data['userMessages'] as string[]
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('[REDACTED]')
    expect(messages[0]).toContain('[CODE]')
    expect(messages[0]).not.toContain('sk-abc123def')
    expect(messages[0]).not.toContain('rm -rf dist')
  })

  it('outputs nothing when ambiguity is below threshold but still captures the prompt', async () => {
    enableTom(tempDir)

    await main(payloadStream({
      session_id: 'quiet-session',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Please read the file /src/app.ts and summarize the exported functions for me',
    }))

    expect(stdoutData).toBe('')
    const data = readSessionFile(tempDir, 'quiet-session')
    expect((data['userMessages'] as string[]).length).toBe(1)
  })

  it('writes framed hookSpecificOutput context injection when a suggestion is produced', async () => {
    enableTom(tempDir, { consultThreshold: 'low' })
    writeUserModel(tempDir, [{
      category: 'codingPreferences',
      key: 'language',
      value: 'typescript',
      confidence: 0.9,
      lastUpdated: '2026-02-02T10:00:00.000Z',
      sessionCount: 5,
    }])

    await main(payloadStream({
      session_id: 'main-test-session',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'make the style better',
    }))

    expect(stdoutData.length).toBeGreaterThan(0)
    const output = JSON.parse(stdoutData)
    expect(output.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit')
    expect(typeof output.hookSpecificOutput.additionalContext).toBe('string')
    expect(
      (output.hookSpecificOutput.additionalContext as string).startsWith(FRAMING_PREFIX)
    ).toBe(true)
    expect(output.hookSpecificOutput.additionalContext).toContain('language=typescript')
    // Never emits anything that could block the prompt
    expect(output.decision).toBeUndefined()
    expect(output.reason).toBeUndefined()
    expect(output.continue).toBeUndefined()
    expect(Object.keys(output)).toEqual(['hookSpecificOutput'])
  })

  it('logs the consultation with operation ambiguity-consultation and structured reason', async () => {
    enableTom(tempDir, { consultThreshold: 'low' })
    writeUserModel(tempDir, [{
      category: 'codingPreferences',
      key: 'framework',
      value: 'react',
      confidence: 0.8,
      lastUpdated: '2026-02-02T10:00:00.000Z',
      sessionCount: 3,
    }])
    process.env['CLAUDE_SESSION_ID'] = 'env-session'

    await main(payloadStream({
      session_id: 'log-test-session',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'improve the style',
    }))

    const logPath = path.join(tempDir, '.claude', 'tom', 'usage.log')
    expect(fs.existsSync(logPath)).toBe(true)
    const content = fs.readFileSync(logPath, 'utf-8').trim()
    const entry = JSON.parse(content)
    expect(entry.operation).toBe('ambiguity-consultation')
    expect(entry.sessionId).toBe('log-test-session')
    const reason = JSON.parse(entry.reason)
    expect(typeof reason.score).toBe('number')
    expect(reason.threshold).toBe('low')
    expect(reason.source).toBe('user-model')
  })

  it('does not emit output when consulted but no memory exists', async () => {
    enableTom(tempDir, { consultThreshold: 'low' })

    await main(payloadStream({
      session_id: 'no-memory-session',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'fix it',
    }))

    expect(stdoutData).toBe('')
    // Prompt is still captured
    const data = readSessionFile(tempDir, 'no-memory-session')
    expect((data['userMessages'] as string[]).length).toBe(1)
  })
})
