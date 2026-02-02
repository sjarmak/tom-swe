import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  isTomEnabled,
  readTomSettings,
  getSessionId,
  logUsage,
  consultToM,
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

describe('getSessionId', () => {
  let originalSessionId: string | undefined

  beforeEach(() => {
    originalSessionId = process.env['CLAUDE_SESSION_ID']
  })

  afterEach(() => {
    if (originalSessionId !== undefined) {
      process.env['CLAUDE_SESSION_ID'] = originalSessionId
    } else {
      delete process.env['CLAUDE_SESSION_ID']
    }
  })

  it('returns CLAUDE_SESSION_ID when set', () => {
    process.env['CLAUDE_SESSION_ID'] = 'pre-tool-session-123'
    expect(getSessionId()).toBe('pre-tool-session-123')
  })

  it('falls back to pid-based ID when env var not set', () => {
    delete process.env['CLAUDE_SESSION_ID']
    expect(getSessionId()).toBe(`pid-${process.pid}`)
  })
})

describe('logUsage', () => {
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

  it('creates usage.log with entry', () => {
    logUsage({
      timestamp: '2026-02-02T12:00:00.000Z',
      operation: 'consultation',
      model: 'sonnet',
      tokenCount: 0,
      sessionId: 'test-session',
    })

    const logPath = path.join(tempDir, '.claude', 'tom', 'usage.log')
    expect(fs.existsSync(logPath)).toBe(true)

    const content = fs.readFileSync(logPath, 'utf-8')
    const entry = JSON.parse(content.trim())
    expect(entry.operation).toBe('consultation')
    expect(entry.model).toBe('sonnet')
  })

  it('appends entries to existing log', () => {
    logUsage({
      timestamp: '2026-02-02T12:00:00.000Z',
      operation: 'first',
      model: 'sonnet',
      tokenCount: 0,
      sessionId: 'session-1',
    })
    logUsage({
      timestamp: '2026-02-02T12:01:00.000Z',
      operation: 'second',
      model: 'sonnet',
      tokenCount: 100,
      sessionId: 'session-2',
    })

    const logPath = path.join(tempDir, '.claude', 'tom', 'usage.log')
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] ?? '{}').operation).toBe('first')
    expect(JSON.parse(lines[1] ?? '{}').operation).toBe('second')
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

describe('main', () => {
  let originalHome: string | undefined
  let originalCwd: string
  let originalSessionId: string | undefined
  let originalToolName: string | undefined
  let originalToolInput: string | undefined
  let tempDir: string
  let stdoutData: string

  beforeEach(() => {
    originalHome = process.env['HOME']
    originalCwd = process.cwd()
    originalSessionId = process.env['CLAUDE_SESSION_ID']
    originalToolName = process.env['TOOL_NAME']
    originalToolInput = process.env['TOOL_INPUT']
    tempDir = createTempDir()
    process.env['HOME'] = tempDir
    process.chdir(tempDir)
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
    if (originalSessionId !== undefined) {
      process.env['CLAUDE_SESSION_ID'] = originalSessionId
    } else {
      delete process.env['CLAUDE_SESSION_ID']
    }
    if (originalToolName !== undefined) {
      process.env['TOOL_NAME'] = originalToolName
    } else {
      delete process.env['TOOL_NAME']
    }
    if (originalToolInput !== undefined) {
      process.env['TOOL_INPUT'] = originalToolInput
    } else {
      delete process.env['TOOL_INPUT']
    }
    // Restore stdout
    if ((process.stdout as any).__originalWrite) {
      process.stdout.write = (process.stdout as any).__originalWrite
      delete (process.stdout as any).__originalWrite
    }
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('is a no-op when tom is not enabled', () => {
    process.env['TOOL_NAME'] = 'Edit'
    main()
    expect(stdoutData).toBe('')
    const tomDir = path.join(tempDir, '.claude', 'tom')
    expect(fs.existsSync(path.join(tomDir, 'usage.log'))).toBe(false)
  })

  it('is a no-op when tool name is empty', () => {
    enableTom(tempDir)
    delete process.env['TOOL_NAME']
    main()
    expect(stdoutData).toBe('')
  })

  it('exits immediately when ambiguity is below threshold', () => {
    enableTom(tempDir)
    process.env['TOOL_NAME'] = 'Read'
    process.env['TOOL_INPUT'] = JSON.stringify({ file_path: '/src/app.ts' })

    main()

    // No output (not ambiguous with default medium threshold and a file path)
    expect(stdoutData).toBe('')
  })

  it('outputs suggestion when ambiguity exceeds threshold with user model', () => {
    enableTom(tempDir, { consultThreshold: 'low' })
    writeUserModel(tempDir, [{
      category: 'codingPreferences',
      key: 'language',
      value: 'typescript',
      confidence: 0.9,
      lastUpdated: '2026-02-02T10:00:00.000Z',
      sessionCount: 5,
    }])

    process.env['TOOL_NAME'] = 'Edit'
    process.env['TOOL_INPUT'] = '{}'
    process.env['CLAUDE_SESSION_ID'] = 'main-test-session'

    main()

    // Should have output a suggestion
    expect(stdoutData.length).toBeGreaterThan(0)
    const suggestion = JSON.parse(stdoutData)
    expect(suggestion.type).toBeDefined()
    expect(suggestion.content).toBeDefined()
    expect(suggestion.confidence).toBeDefined()
  })

  it('logs consultation to usage.log when consulted', () => {
    enableTom(tempDir, { consultThreshold: 'low' })
    writeUserModel(tempDir, [{
      category: 'codingPreferences',
      key: 'framework',
      value: 'react',
      confidence: 0.8,
      lastUpdated: '2026-02-02T10:00:00.000Z',
      sessionCount: 3,
    }])

    process.env['TOOL_NAME'] = 'Write'
    process.env['TOOL_INPUT'] = '{}'
    process.env['CLAUDE_SESSION_ID'] = 'log-test-session'

    main()

    const logPath = path.join(tempDir, '.claude', 'tom', 'usage.log')
    expect(fs.existsSync(logPath)).toBe(true)
    const content = fs.readFileSync(logPath, 'utf-8').trim()
    const entry = JSON.parse(content)
    expect(entry.operation).toBe('consultation')
    expect(entry.model).toBe('sonnet')
    expect(entry.sessionId).toBe('log-test-session')
  })

  it('handles malformed TOOL_INPUT gracefully', () => {
    enableTom(tempDir, { consultThreshold: 'low' })
    process.env['TOOL_NAME'] = 'Edit'
    process.env['TOOL_INPUT'] = 'not json'

    // Should not throw
    main()
  })
})
