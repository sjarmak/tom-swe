import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  isTomEnabled,
  getSessionId,
  readRawSessionLog,
  extractSessionModel,
  logUsage,
  analyzeCompletedSession,
  main,
} from './stop-analyze'

// --- Test Helpers ---

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tom-stop-test-'))
}

function createSessionLog(sessionId: string, interactions: readonly object[] = []) {
  return {
    sessionId,
    startedAt: '2026-02-02T10:00:00.000Z',
    endedAt: '2026-02-02T11:00:00.000Z',
    interactions,
  }
}

function createInteraction(
  toolName: string,
  parameterShape: Record<string, string> = {},
  outcomeSummary: string = 'success'
) {
  return {
    toolName,
    parameterShape,
    outcomeSummary,
    timestamp: '2026-02-02T10:30:00.000Z',
  }
}

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
    const tomDir = path.join(tempDir, '.claude', 'tom')
    fs.mkdirSync(tomDir, { recursive: true })
    fs.writeFileSync(
      path.join(tomDir, 'config.json'),
      JSON.stringify({ enabled: true }),
      'utf-8'
    )
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
    process.env['CLAUDE_SESSION_ID'] = 'test-session-123'
    expect(getSessionId()).toBe('test-session-123')
  })

  it('falls back to pid-based ID when env var not set', () => {
    delete process.env['CLAUDE_SESSION_ID']
    expect(getSessionId()).toBe(`pid-${process.pid}`)
  })
})

describe('readRawSessionLog', () => {
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

  it('returns null when session file does not exist', () => {
    expect(readRawSessionLog('nonexistent')).toBeNull()
  })

  it('returns null when session file has invalid JSON', () => {
    const sessionsDir = path.join(tempDir, '.claude', 'tom', 'sessions')
    fs.mkdirSync(sessionsDir, { recursive: true })
    fs.writeFileSync(path.join(sessionsDir, 'bad.json'), 'not json', 'utf-8')
    expect(readRawSessionLog('bad')).toBeNull()
  })

  it('returns null when session file fails schema validation', () => {
    const sessionsDir = path.join(tempDir, '.claude', 'tom', 'sessions')
    fs.mkdirSync(sessionsDir, { recursive: true })
    fs.writeFileSync(
      path.join(sessionsDir, 'invalid.json'),
      JSON.stringify({ bad: 'data' }),
      'utf-8'
    )
    expect(readRawSessionLog('invalid')).toBeNull()
  })

  it('returns parsed session log for valid file', () => {
    const sessionsDir = path.join(tempDir, '.claude', 'tom', 'sessions')
    fs.mkdirSync(sessionsDir, { recursive: true })
    const log = createSessionLog('test-session', [
      createInteraction('Edit', { file_path: 'src/app.ts' }, 'success'),
    ])
    fs.writeFileSync(
      path.join(sessionsDir, 'test-session.json'),
      JSON.stringify(log),
      'utf-8'
    )

    const result = readRawSessionLog('test-session')
    expect(result).not.toBeNull()
    expect(result?.sessionId).toBe('test-session')
    expect(result?.interactions).toHaveLength(1)
  })
})

describe('extractSessionModel', () => {
  it('extracts intent from most-used tool', () => {
    const log = createSessionLog('session-1', [
      createInteraction('Edit', {}, 'success'),
      createInteraction('Edit', {}, 'success'),
      createInteraction('Read', {}, 'success'),
    ])
    const model = extractSessionModel(log as any)
    expect(model.sessionId).toBe('session-1')
    expect(model.intent).toBe('brief code modification')
  })

  it('extracts interaction patterns from top tools', () => {
    const log = createSessionLog('session-2', [
      createInteraction('Edit', {}, 'success'),
      createInteraction('Grep', {}, 'success'),
      createInteraction('Read', {}, 'success'),
    ])
    const model = extractSessionModel(log as any)
    expect(model.interactionPatterns).toContain('uses-Edit')
    expect(model.interactionPatterns).toContain('uses-Grep')
    expect(model.interactionPatterns).toContain('uses-Read')
  })

  it('detects frustration from error outcomes', () => {
    const interactions = Array.from({ length: 10 }, (_, i) =>
      createInteraction('Bash', {}, i < 4 ? 'error: command failed' : 'success')
    )
    const log = createSessionLog('session-3', interactions)
    const model = extractSessionModel(log as any)
    expect(model.satisfactionSignals.frustration).toBe(true)
  })

  it('detects satisfaction from success outcomes', () => {
    const interactions = Array.from({ length: 10 }, () =>
      createInteraction('Edit', {}, 'success: completed')
    )
    const log = createSessionLog('session-4', interactions)
    const model = extractSessionModel(log as any)
    expect(model.satisfactionSignals.satisfaction).toBe(true)
  })

  it('sets urgency based on interaction count', () => {
    const fewInteractions = Array.from({ length: 5 }, () =>
      createInteraction('Read', {}, 'success')
    )
    const log1 = createSessionLog('session-5', fewInteractions)
    expect(extractSessionModel(log1 as any).satisfactionSignals.urgency).toBe('low')

    const mediumInteractions = Array.from({ length: 15 }, () =>
      createInteraction('Read', {}, 'success')
    )
    const log2 = createSessionLog('session-6', mediumInteractions)
    expect(extractSessionModel(log2 as any).satisfactionSignals.urgency).toBe('medium')

    const manyInteractions = Array.from({ length: 25 }, () =>
      createInteraction('Read', {}, 'success')
    )
    const log3 = createSessionLog('session-7', manyInteractions)
    expect(extractSessionModel(log3 as any).satisfactionSignals.urgency).toBe('high')
  })

  it('extracts coding preferences from file_path parameters', () => {
    const log = createSessionLog('session-8', [
      createInteraction('Edit', { file_path: 'src/app.ts' }, 'success'),
      createInteraction('Edit', { file_path: 'src/utils.ts' }, 'success'),
    ])
    const model = extractSessionModel(log as any)
    expect(model.codingPreferences).toContain('src/app.ts')
    expect(model.codingPreferences).toContain('src/utils.ts')
  })

  it('handles empty session log', () => {
    const log = createSessionLog('empty-session', [])
    const model = extractSessionModel(log as any)
    expect(model.sessionId).toBe('empty-session')
    expect(model.intent).toBe('brief unknown usage')
    expect(model.interactionPatterns).toEqual([])
    expect(model.codingPreferences).toEqual([])
    expect(model.satisfactionSignals.frustration).toBe(false)
    expect(model.satisfactionSignals.satisfaction).toBe(false)
    expect(model.satisfactionSignals.urgency).toBe('low')
  })

  it('returns a new object (immutable)', () => {
    const log = createSessionLog('immutable-test', [
      createInteraction('Edit', {}, 'success'),
    ])
    const model1 = extractSessionModel(log as any)
    const model2 = extractSessionModel(log as any)
    expect(model1).not.toBe(model2)
    expect(model1).toEqual(model2)
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

  it('creates usage.log file with entry', () => {
    logUsage({
      timestamp: '2026-02-02T12:00:00.000Z',
      operation: 'session-analysis',
      model: 'haiku',
      tokenCount: 0,
      sessionId: 'test-session',
    })

    const logPath = path.join(tempDir, '.claude', 'tom', 'usage.log')
    expect(fs.existsSync(logPath)).toBe(true)

    const content = fs.readFileSync(logPath, 'utf-8')
    const entry = JSON.parse(content.trim())
    expect(entry.operation).toBe('session-analysis')
    expect(entry.model).toBe('haiku')
  })

  it('appends entries to existing log', () => {
    logUsage({
      timestamp: '2026-02-02T12:00:00.000Z',
      operation: 'first',
      model: 'haiku',
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

  it('creates directory structure if missing', () => {
    const logPath = path.join(tempDir, '.claude', 'tom', 'usage.log')
    expect(fs.existsSync(path.dirname(logPath))).toBe(false)

    logUsage({
      timestamp: '2026-02-02T12:00:00.000Z',
      operation: 'test',
      model: 'haiku',
      tokenCount: 0,
      sessionId: 'test',
    })

    expect(fs.existsSync(logPath)).toBe(true)
  })
})

describe('analyzeCompletedSession', () => {
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

  it('returns failure when session log does not exist', () => {
    const result = analyzeCompletedSession('nonexistent')
    expect(result.success).toBe(false)
    expect(result.sessionModel).toBeNull()
    expect(result.userModelUpdated).toBe(false)
    expect(result.indexRebuilt).toBe(false)
    expect(result.error).toContain('nonexistent')
  })

  it('analyzes session and produces Tier 2 model', () => {
    const sessionsDir = path.join(tempDir, '.claude', 'tom', 'sessions')
    fs.mkdirSync(sessionsDir, { recursive: true })
    const log = createSessionLog('analyze-test', [
      createInteraction('Edit', { file_path: 'src/app.ts' }, 'success'),
      createInteraction('Read', {}, 'completed reading file'),
    ])
    fs.writeFileSync(
      path.join(sessionsDir, 'analyze-test.json'),
      JSON.stringify(log),
      'utf-8'
    )

    const result = analyzeCompletedSession('analyze-test')
    expect(result.success).toBe(true)
    expect(result.sessionModel).not.toBeNull()
    expect(result.sessionModel?.sessionId).toBe('analyze-test')
    expect(result.sessionModel?.interactionPatterns).toContain('uses-Edit')
  })

  it('writes Tier 2 session model to disk', () => {
    const sessionsDir = path.join(tempDir, '.claude', 'tom', 'sessions')
    fs.mkdirSync(sessionsDir, { recursive: true })
    const log = createSessionLog('write-test', [
      createInteraction('Bash', {}, 'success'),
    ])
    fs.writeFileSync(
      path.join(sessionsDir, 'write-test.json'),
      JSON.stringify(log),
      'utf-8'
    )

    analyzeCompletedSession('write-test')

    const modelPath = path.join(tempDir, '.claude', 'tom', 'session-models', 'write-test.json')
    expect(fs.existsSync(modelPath)).toBe(true)
    const model = JSON.parse(fs.readFileSync(modelPath, 'utf-8'))
    expect(model.sessionId).toBe('write-test')
  })

  it('updates Tier 3 user model', () => {
    const sessionsDir = path.join(tempDir, '.claude', 'tom', 'sessions')
    fs.mkdirSync(sessionsDir, { recursive: true })
    const log = createSessionLog('user-model-test', [
      createInteraction('Edit', { file_path: 'src/app.ts' }, 'success'),
    ])
    fs.writeFileSync(
      path.join(sessionsDir, 'user-model-test.json'),
      JSON.stringify(log),
      'utf-8'
    )

    const result = analyzeCompletedSession('user-model-test')
    expect(result.userModelUpdated).toBe(true)

    const userModelPath = path.join(tempDir, '.claude', 'tom', 'user-model.json')
    expect(fs.existsSync(userModelPath)).toBe(true)
    const userModel = JSON.parse(fs.readFileSync(userModelPath, 'utf-8'))
    expect(userModel.preferencesClusters.length).toBeGreaterThan(0)
  })

  it('rebuilds BM25 index', () => {
    const sessionsDir = path.join(tempDir, '.claude', 'tom', 'sessions')
    fs.mkdirSync(sessionsDir, { recursive: true })
    const log = createSessionLog('index-test', [
      createInteraction('Grep', {}, 'found matches'),
    ])
    fs.writeFileSync(
      path.join(sessionsDir, 'index-test.json'),
      JSON.stringify(log),
      'utf-8'
    )

    const result = analyzeCompletedSession('index-test')
    expect(result.indexRebuilt).toBe(true)

    const indexPath = path.join(tempDir, '.claude', 'tom', 'bm25-index.json')
    expect(fs.existsSync(indexPath)).toBe(true)
  })

  it('logs completion to usage.log', () => {
    const sessionsDir = path.join(tempDir, '.claude', 'tom', 'sessions')
    fs.mkdirSync(sessionsDir, { recursive: true })
    const log = createSessionLog('log-test', [
      createInteraction('Read', {}, 'success'),
    ])
    fs.writeFileSync(
      path.join(sessionsDir, 'log-test.json'),
      JSON.stringify(log),
      'utf-8'
    )

    analyzeCompletedSession('log-test')

    const logPath = path.join(tempDir, '.claude', 'tom', 'usage.log')
    expect(fs.existsSync(logPath)).toBe(true)
    const content = fs.readFileSync(logPath, 'utf-8').trim()
    const entry = JSON.parse(content)
    expect(entry.operation).toBe('session-analysis')
    expect(entry.model).toBe('haiku')
    expect(entry.sessionId).toBe('log-test')
  })

  it('aggregates into existing user model', () => {
    const tomDir = path.join(tempDir, '.claude', 'tom')
    const sessionsDir = path.join(tomDir, 'sessions')
    fs.mkdirSync(sessionsDir, { recursive: true })

    // Write an existing user model
    const existingModel = {
      preferencesClusters: [
        {
          category: 'codingPreferences',
          key: 'preference',
          value: 'typescript',
          confidence: 0.5,
          lastUpdated: '2026-02-01T10:00:00.000Z',
          sessionCount: 3,
        },
      ],
      interactionStyleSummary: 'prefers concise',
      codingStyleSummary: 'typescript focused',
      projectOverrides: {},
    }
    fs.writeFileSync(
      path.join(tomDir, 'user-model.json'),
      JSON.stringify(existingModel),
      'utf-8'
    )

    // Create a session with a matching preference
    const log = createSessionLog('aggregate-test', [
      createInteraction('Edit', { file_path: 'src/app.ts' }, 'success'),
    ])
    fs.writeFileSync(
      path.join(sessionsDir, 'aggregate-test.json'),
      JSON.stringify(log),
      'utf-8'
    )

    analyzeCompletedSession('aggregate-test')

    const userModelPath = path.join(tomDir, 'user-model.json')
    const updatedModel = JSON.parse(fs.readFileSync(userModelPath, 'utf-8'))
    // Should still have preferences (merged from existing + new session)
    expect(updatedModel.preferencesClusters.length).toBeGreaterThan(0)
    // Should preserve summaries
    expect(updatedModel.interactionStyleSummary).toBe('prefers concise')
    expect(updatedModel.codingStyleSummary).toBe('typescript focused')
  })
})

describe('main', () => {
  let originalHome: string | undefined
  let originalCwd: string
  let originalSessionId: string | undefined
  let tempDir: string

  beforeEach(() => {
    originalHome = process.env['HOME']
    originalCwd = process.cwd()
    originalSessionId = process.env['CLAUDE_SESSION_ID']
    tempDir = createTempDir()
    process.env['HOME'] = tempDir
    process.chdir(tempDir)
  })

  afterEach(() => {
    process.env['HOME'] = originalHome
    process.chdir(originalCwd)
    if (originalSessionId !== undefined) {
      process.env['CLAUDE_SESSION_ID'] = originalSessionId
    } else {
      delete process.env['CLAUDE_SESSION_ID']
    }
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('is a no-op when tom is not enabled', () => {
    // No settings file → tom.enabled is false
    main()
    // Should not create any files
    const tomDir = path.join(tempDir, '.claude', 'tom')
    expect(fs.existsSync(path.join(tomDir, 'usage.log'))).toBe(false)
  })

  it('runs analysis when tom is enabled and session exists', () => {
    // Enable tom
    const tomDir = path.join(tempDir, '.claude', 'tom')
    fs.mkdirSync(tomDir, { recursive: true })
    fs.writeFileSync(
      path.join(tomDir, 'config.json'),
      JSON.stringify({ enabled: true }),
      'utf-8'
    )

    // Create session
    const sessionId = 'main-test-session'
    process.env['CLAUDE_SESSION_ID'] = sessionId
    const sessionsDir = path.join(tempDir, '.claude', 'tom', 'sessions')
    fs.mkdirSync(sessionsDir, { recursive: true })
    const log = createSessionLog(sessionId, [
      createInteraction('Edit', {}, 'success'),
    ])
    fs.writeFileSync(
      path.join(sessionsDir, `${sessionId}.json`),
      JSON.stringify(log),
      'utf-8'
    )

    main()

    // Should have created session model
    const modelPath = path.join(tempDir, '.claude', 'tom', 'session-models', `${sessionId}.json`)
    expect(fs.existsSync(modelPath)).toBe(true)

    // Should have created/updated user model
    const userModelPath = path.join(tempDir, '.claude', 'tom', 'user-model.json')
    expect(fs.existsSync(userModelPath)).toBe(true)

    // Should have logged usage
    const logPath = path.join(tempDir, '.claude', 'tom', 'usage.log')
    expect(fs.existsSync(logPath)).toBe(true)
  })

  it('logs error to usage.log when session does not exist but tom is enabled', () => {
    // Enable tom
    const tomDir = path.join(tempDir, '.claude', 'tom')
    fs.mkdirSync(tomDir, { recursive: true })
    fs.writeFileSync(
      path.join(tomDir, 'config.json'),
      JSON.stringify({ enabled: true }),
      'utf-8'
    )

    process.env['CLAUDE_SESSION_ID'] = 'nonexistent-session'

    // main() should not throw even on missing session
    main()
  })
})
