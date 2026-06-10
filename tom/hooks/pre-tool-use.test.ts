import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { Readable } from 'node:stream'
import {
  isTomEnabled,
  readTomSettings,
  consultToM,
  buildHookOutput,
  main,
} from './pre-tool-use'

// --- Test Helpers ---

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tom-pre-tool-test-'))
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

function writeBm25Index(tempDir: string): void {
  const tomDir = path.join(tempDir, '.claude', 'tom')
  fs.mkdirSync(tomDir, { recursive: true })

  const idfVal = Math.log((2 - 1 + 0.5) / (1 + 0.5))

  // Write a valid BM25 index matching the BM25Index interface
  const index = {
    documentCount: 2,
    avgDocLength: 4,
    docs: [
      {
        id: 'user-model',
        tier: 3,
        length: 4,
        termFreqs: { typescript: 1, react: 1, testing: 1, patterns: 1 },
      },
      {
        id: 'session:session-1',
        tier: 1,
        length: 4,
        termFreqs: { code: 1, modification: 1, edit: 1, write: 1 },
      },
    ],
    idf: {
      typescript: idfVal,
      react: idfVal,
      testing: idfVal,
      patterns: idfVal,
      code: idfVal,
      modification: idfVal,
      edit: idfVal,
      write: idfVal,
    },
  }

  fs.writeFileSync(
    path.join(tomDir, 'bm25-index.json'),
    JSON.stringify(index),
    'utf-8'
  )
}

// --- Tests ---

describe('isTomEnabled', () => {
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

  it('returns false when settings file does not exist', () => {
    expect(isTomEnabled()).toBe(false)
  })

  it('returns false when tom.enabled is false', () => {
    const tomDir = path.join(tempDir, '.claude', 'tom')
    fs.mkdirSync(tomDir, { recursive: true })
    fs.writeFileSync(
      path.join(tomDir, 'config.json'),
      JSON.stringify({ enabled: false }),
      'utf-8'
    )
    expect(isTomEnabled()).toBe(false)
  })

  it('returns true when tom.enabled is true', () => {
    enableTom(tempDir)
    expect(isTomEnabled()).toBe(true)
  })

  it('returns false when config JSON is invalid', () => {
    const tomDir = path.join(tempDir, '.claude', 'tom')
    fs.mkdirSync(tomDir, { recursive: true })
    fs.writeFileSync(
      path.join(tomDir, 'config.json'),
      'not json',
      'utf-8'
    )
    expect(isTomEnabled()).toBe(false)
  })
})

describe('readTomSettings', () => {
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

  it('returns defaults when settings file missing', () => {
    const settings = readTomSettings()
    expect(settings.enabled).toBe(false)
    expect(settings.consultThreshold).toBe('medium')
  })

  it('reads consultThreshold from settings', () => {
    enableTom(tempDir, { consultThreshold: 'high' })
    const settings = readTomSettings()
    expect(settings.consultThreshold).toBe('high')
  })

  it('falls back to medium for invalid threshold', () => {
    enableTom(tempDir, { consultThreshold: 'invalid' })
    const settings = readTomSettings()
    expect(settings.consultThreshold).toBe('medium')
  })

  it('reads low threshold', () => {
    enableTom(tempDir, { consultThreshold: 'low' })
    const settings = readTomSettings()
    expect(settings.consultThreshold).toBe('low')
  })
})

describe('consultToM', () => {
  let originalHome: string | undefined
  let originalCwd: string
  let tempDir: string

  beforeEach(() => {
    originalHome = process.env['HOME']
    originalCwd = process.cwd()
    tempDir = createTempDir()
    process.env['HOME'] = tempDir
    process.chdir(tempDir)
  })

  afterEach(() => {
    process.env['HOME'] = originalHome
    process.chdir(originalCwd)
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('returns not consulted when ambiguity is below threshold', () => {
    // Specific tool call with file path and long detailed message — low ambiguity
    const result = consultToM(
      'Read',
      { file_path: '/src/app.ts' },
      ['Read the file at /src/app.ts and tell me what the main function does'],
      'high'
    )
    expect(result.consulted).toBe(false)
    expect(result.suggestion).toBeNull()
  })

  it('returns consulted when ambiguity exceeds threshold with no user model', () => {
    // Vague message + no user model + style-sensitive tool → high ambiguity
    const result = consultToM(
      'Edit',
      {},
      ['fix it'],
      'low'
    )
    expect(result.consulted).toBe(true)
    expect(result.ambiguityResult.isAmbiguous).toBe(true)
  })

  it('generates suggestion from BM25 search when index exists', () => {
    writeBm25Index(tempDir)
    writeUserModel(tempDir, [{
      category: 'codingPreferences',
      key: 'language',
      value: 'typescript',
      confidence: 0.8,
      lastUpdated: '2026-02-02T10:00:00.000Z',
      sessionCount: 5,
    }])

    const result = consultToM(
      'Edit',
      {},
      ['fix the style'],
      'low'
    )

    expect(result.consulted).toBe(true)
    expect(result.suggestion).not.toBeNull()
    expect(result.suggestion?.type).toBeDefined()
    expect(result.suggestion?.content).toContain('Edit')
    expect(result.suggestion?.confidence).toBeGreaterThan(0)
  })

  it('falls back to user model when no BM25 index exists', () => {
    writeUserModel(tempDir, [{
      category: 'codingPreferences',
      key: 'language',
      value: 'typescript',
      confidence: 0.9,
      lastUpdated: '2026-02-02T10:00:00.000Z',
      sessionCount: 5,
    }])

    const result = consultToM(
      'Write',
      {},
      ['make it better'],
      'low'
    )

    expect(result.consulted).toBe(true)
    expect(result.suggestion).not.toBeNull()
    expect(result.suggestion?.type).toBe('preference')
    expect(result.suggestion?.content).toContain('language=typescript')
  })

  it('returns null suggestion when no memory exists', () => {
    const result = consultToM(
      'Edit',
      {},
      ['fix it'],
      'low'
    )

    expect(result.consulted).toBe(true)
    expect(result.suggestion).toBeNull()
  })

  it('logs consultation to usage.log', () => {
    const result = consultToM(
      'Edit',
      {},
      ['improve the style'],
      'low'
    )

    if (result.consulted) {
      const logPath = path.join(tempDir, '.claude', 'tom', 'usage.log')
      expect(fs.existsSync(logPath)).toBe(true)
      const content = fs.readFileSync(logPath, 'utf-8').trim()
      const entry = JSON.parse(content)
      expect(entry.operation).toBe('consultation')
      expect(entry.model).toBe('sonnet')
    }
  })

  it('uses correct threshold from settings', () => {
    // With high threshold, vague message alone should not trigger
    const result = consultToM(
      'Read',
      { file_path: '/src/app.ts' },
      ['check it'],
      'high'
    )
    expect(result.consulted).toBe(false)
  })

  it('includes ambiguity reason in suggestion content', () => {
    writeUserModel(tempDir, [{
      category: 'codingPreferences',
      key: 'framework',
      value: 'react',
      confidence: 0.7,
      lastUpdated: '2026-02-02T10:00:00.000Z',
      sessionCount: 3,
    }])

    const result = consultToM(
      'Edit',
      {},
      ['refactor the approach'],
      'low'
    )

    expect(result.consulted).toBe(true)
    if (result.suggestion) {
      expect(result.suggestion.content).toContain('Ambiguity reason:')
    }
  })

  it('suggestion has valid ToMSuggestion structure', () => {
    writeUserModel(tempDir, [{
      category: 'codingPreferences',
      key: 'testing',
      value: 'vitest',
      confidence: 0.6,
      lastUpdated: '2026-02-02T10:00:00.000Z',
      sessionCount: 2,
    }])

    const result = consultToM(
      'Write',
      {},
      ['make it nice'],
      'low'
    )

    if (result.suggestion) {
      expect(['preference', 'disambiguation', 'style']).toContain(result.suggestion.type)
      expect(typeof result.suggestion.content).toBe('string')
      expect(result.suggestion.confidence).toBeGreaterThanOrEqual(0)
      expect(result.suggestion.confidence).toBeLessThanOrEqual(1)
      expect(Array.isArray(result.suggestion.sourceSessions)).toBe(true)
    }
  })
})

describe('buildHookOutput', () => {
  it('produces the documented PreToolUse hookSpecificOutput shape', () => {
    const output = buildHookOutput({
      type: 'preference',
      content: 'User preferences: language=typescript (90%).',
      confidence: 0.85,
      sourceSessions: [],
    })

    expect(output.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(output.hookSpecificOutput.additionalContext).toBe(
      'ToM preference suggestion (confidence 85%): User preferences: language=typescript (90%).'
    )
  })

  it('never includes a permissionDecision field', () => {
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
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: {},
    }))
    expect(stdoutData).toBe('')
    const tomDir = path.join(tempDir, '.claude', 'tom')
    expect(fs.existsSync(path.join(tomDir, 'usage.log'))).toBe(false)
  })

  it('is a no-op when the payload has no tool_name', async () => {
    enableTom(tempDir)
    await main(payloadStream({ session_id: 's1', hook_event_name: 'PreToolUse' }))
    expect(stdoutData).toBe('')
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
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: {},
    }))

    expect(stdoutData).toBe('')
    const tomDir = path.join(tempDir, '.claude', 'tom')
    expect(fs.existsSync(path.join(tomDir, 'usage.log'))).toBe(false)
  })

  it('outputs nothing when ambiguity is below threshold', async () => {
    enableTom(tempDir)

    await main(payloadStream({
      session_id: 's1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/src/app.ts' },
    }))

    // No output (not ambiguous with default medium threshold and a file path)
    expect(stdoutData).toBe('')
  })

  it('writes hookSpecificOutput context injection when a suggestion is produced', async () => {
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
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: {},
    }))

    expect(stdoutData.length).toBeGreaterThan(0)
    const output = JSON.parse(stdoutData)
    expect(output.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(typeof output.hookSpecificOutput.additionalContext).toBe('string')
    expect(output.hookSpecificOutput.additionalContext).toContain('ToM')
    expect(output.hookSpecificOutput.additionalContext).toContain('confidence')
    expect(output.hookSpecificOutput.additionalContext).toContain('language=typescript')
    expect(output.hookSpecificOutput.permissionDecision).toBeUndefined()
    expect(output.permissionDecision).toBeUndefined()
  })

  it('logs consultation with the payload session_id', async () => {
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
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: {},
    }))

    const logPath = path.join(tempDir, '.claude', 'tom', 'usage.log')
    expect(fs.existsSync(logPath)).toBe(true)
    const content = fs.readFileSync(logPath, 'utf-8').trim()
    const entry = JSON.parse(content)
    expect(entry.operation).toBe('consultation')
    expect(entry.model).toBe('sonnet')
    expect(entry.sessionId).toBe('log-test-session')
  })

  it('handles non-object tool_input gracefully', async () => {
    enableTom(tempDir, { consultThreshold: 'low' })

    // Should not throw
    await main(payloadStream({
      session_id: 's1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: 'not an object',
    }))
  })
})
