import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { Readable } from 'node:stream'
import {
  readRawSessionLog,
  analyzeCompletedSession,
  main,
} from './stop-analyze'
import { analyzeSessionWithLlm } from '../llm-analyze'

// Never spawn the real claude CLI in tests: the LLM path is mocked and
// defaults to failure so existing pipeline tests exercise the heuristic
// fallback. Individual tests override the resolved value.
vi.mock('../llm-analyze', () => ({
  analyzeSessionWithLlm: vi.fn(),
}))

const mockAnalyzeWithLlm = vi.mocked(analyzeSessionWithLlm)

beforeEach(() => {
  mockAnalyzeWithLlm.mockReset()
  mockAnalyzeWithLlm.mockResolvedValue({
    ok: false,
    reason: 'spawn-error',
    detail: 'mocked failure',
  })
})

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

// isTomEnabled coverage lives in tom/config.test.ts; stop-analyze now uses
// the validated guard exported by config.ts instead of a local duplicate.

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

  it('returns failure when session log does not exist', async () => {
    const result = await analyzeCompletedSession('nonexistent')
    expect(result.success).toBe(false)
    expect(result.sessionModel).toBeNull()
    expect(result.userModelUpdated).toBe(false)
    expect(result.indexRebuilt).toBe(false)
    expect(result.error).toContain('nonexistent')
  })

  it('analyzes session and produces Tier 2 model', async () => {
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

    const result = await analyzeCompletedSession('analyze-test')
    expect(result.success).toBe(true)
    expect(result.sessionModel).not.toBeNull()
    expect(result.sessionModel?.sessionId).toBe('analyze-test')
    expect(result.sessionModel?.interactionPatterns).toContain('uses-Edit')
  })

  it('writes Tier 2 session model to disk', async () => {
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

    await analyzeCompletedSession('write-test')

    const modelPath = path.join(tempDir, '.claude', 'tom', 'session-models', 'write-test.json')
    expect(fs.existsSync(modelPath)).toBe(true)
    const model = JSON.parse(fs.readFileSync(modelPath, 'utf-8'))
    expect(model.sessionId).toBe('write-test')
  })

  it('updates Tier 3 user model', async () => {
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

    const result = await analyzeCompletedSession('user-model-test')
    expect(result.userModelUpdated).toBe(true)

    const userModelPath = path.join(tempDir, '.claude', 'tom', 'user-model.json')
    expect(fs.existsSync(userModelPath)).toBe(true)
    const userModel = JSON.parse(fs.readFileSync(userModelPath, 'utf-8'))
    expect(userModel.preferencesClusters.length).toBeGreaterThan(0)
  })

  it('rebuilds BM25 index', async () => {
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

    const result = await analyzeCompletedSession('index-test')
    expect(result.indexRebuilt).toBe(true)

    const indexPath = path.join(tempDir, '.claude', 'tom', 'bm25-index.json')
    expect(fs.existsSync(indexPath)).toBe(true)
  })

  function writeSessionFile(sessionId: string): void {
    const sessionsDir = path.join(tempDir, '.claude', 'tom', 'sessions')
    fs.mkdirSync(sessionsDir, { recursive: true })
    const log = createSessionLog(sessionId, [
      createInteraction('Read', {}, 'success'),
    ])
    fs.writeFileSync(
      path.join(sessionsDir, `${sessionId}.json`),
      JSON.stringify(log),
      'utf-8'
    )
  }

  function readUsageEntries(): Array<Record<string, unknown>> {
    const logPath = path.join(tempDir, '.claude', 'tom', 'usage.log')
    return fs.readFileSync(logPath, 'utf-8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>)
  }

  it('logs host-session usage from the transcript with deduplicated buckets', async () => {
    writeSessionFile('usage-test')
    mockAnalyzeWithLlm.mockResolvedValue({
      ok: false,
      reason: 'spawn-error',
      detail: 'claude not found',
    })

    const transcriptPath = path.join(tempDir, 'transcript.jsonl')
    const usage = {
      input_tokens: 100,
      output_tokens: 40,
      cache_creation_input_tokens: 300,
      cache_read_input_tokens: 5000,
    }
    fs.writeFileSync(
      transcriptPath,
      [
        // Same message id twice (one line per content block) — counted once.
        JSON.stringify({ type: 'assistant', message: { id: 'msg_1', usage } }),
        JSON.stringify({ type: 'assistant', message: { id: 'msg_1', usage } }),
        JSON.stringify({ type: 'user', message: { role: 'user' } }),
      ].join('\n'),
      'utf-8'
    )

    await analyzeCompletedSession('usage-test', process.cwd(), transcriptPath)

    const entries = readUsageEntries()
    const usageEntry = entries.find((e) => e['operation'] === 'session-usage')
    expect(usageEntry).toBeDefined()
    expect(usageEntry?.['sessionId']).toBe('usage-test')
    const detail = (usageEntry?.['detail'] ?? {}) as Record<string, unknown>
    expect(detail['inputTokens']).toBe(100)
    expect(detail['outputTokens']).toBe(40)
    expect(detail['cacheCreationTokens']).toBe(300)
    expect(detail['cacheReadTokens']).toBe(5000)
    expect(detail['assistantMessages']).toBe(1)
  })

  it('logs a typed session-usage-error when the transcript is unreadable', async () => {
    writeSessionFile('usage-error-test')
    mockAnalyzeWithLlm.mockResolvedValue({
      ok: false,
      reason: 'spawn-error',
      detail: 'claude not found',
    })

    const missingPath = path.join(tempDir, 'missing.jsonl')
    const result = await analyzeCompletedSession(
      'usage-error-test',
      process.cwd(),
      missingPath
    )
    // Usage failure must not break the analysis pipeline.
    expect(result.success).toBe(true)

    const entries = readUsageEntries()
    const errorEntry = entries.find(
      (e) => e['operation'] === 'session-usage-error'
    )
    expect(errorEntry).toBeDefined()
    expect(String(errorEntry?.['reason'])).toContain(missingPath)
  })

  it('logs no session-usage entry when no transcript path is provided', async () => {
    writeSessionFile('no-transcript-test')
    mockAnalyzeWithLlm.mockResolvedValue({
      ok: false,
      reason: 'spawn-error',
      detail: 'claude not found',
    })

    await analyzeCompletedSession('no-transcript-test')

    const entries = readUsageEntries()
    expect(entries.some((e) => String(e['operation']).startsWith('session-usage'))).toBe(false)
  })

  it('writes a post-session user-model snapshot for as-of queries', async () => {
    writeSessionFile('snapshot-test')
    mockAnalyzeWithLlm.mockResolvedValue({
      ok: false,
      reason: 'spawn-error',
      detail: 'claude not found',
    })

    await analyzeCompletedSession('snapshot-test')

    const snapshotPath = path.join(
      tempDir, '.claude', 'tom', 'user-model-history', 'snapshot-test.json'
    )
    expect(fs.existsSync(snapshotPath)).toBe(true)
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'))
    const live = JSON.parse(
      fs.readFileSync(path.join(tempDir, '.claude', 'tom', 'user-model.json'), 'utf-8')
    )
    // The snapshot is the model exactly as it stood after this session.
    expect(snapshot).toEqual(live)
  })

  it('prunes oldest sessions (and their snapshots) past maxSessionsRetained', async () => {
    const tomDir = path.join(tempDir, '.claude', 'tom')
    fs.mkdirSync(tomDir, { recursive: true })
    fs.writeFileSync(
      path.join(tomDir, 'config.json'),
      JSON.stringify({ enabled: true, maxSessionsRetained: 2 }),
      'utf-8'
    )
    mockAnalyzeWithLlm.mockResolvedValue({
      ok: false,
      reason: 'spawn-error',
      detail: 'claude not found',
    })

    // Three sessions, distinct start times; oldest must be pruned.
    writeSessionFile('prune-old')
    writeSessionFile('prune-mid')
    writeSessionFile('prune-new')
    const sessionsDir = path.join(tomDir, 'sessions')
    const stamp = (id: string, startedAt: string): void => {
      const p = path.join(sessionsDir, `${id}.json`)
      const log = JSON.parse(fs.readFileSync(p, 'utf-8'))
      fs.writeFileSync(p, JSON.stringify({ ...log, startedAt }), 'utf-8')
    }
    stamp('prune-old', '2026-01-01T00:00:00.000Z')
    stamp('prune-mid', '2026-02-01T00:00:00.000Z')
    stamp('prune-new', '2026-03-01T00:00:00.000Z')
    // Pre-existing snapshot for the session about to be pruned.
    const historyDir = path.join(tomDir, 'user-model-history')
    fs.mkdirSync(historyDir, { recursive: true })
    fs.writeFileSync(path.join(historyDir, 'prune-old.json'), '{}', 'utf-8')

    await analyzeCompletedSession('prune-new')

    expect(fs.existsSync(path.join(sessionsDir, 'prune-old.json'))).toBe(false)
    expect(fs.existsSync(path.join(historyDir, 'prune-old.json'))).toBe(false)
    expect(fs.existsSync(path.join(sessionsDir, 'prune-mid.json'))).toBe(true)
    expect(fs.existsSync(path.join(sessionsDir, 'prune-new.json'))).toBe(true)
  })

  it('carries cwd and gitBranch join fields in session-usage detail', async () => {
    writeSessionFile('join-usage-test')
    // Enrich the Tier 1 log with join fields as the capture hook would.
    const sessionPath = path.join(
      tempDir, '.claude', 'tom', 'sessions', 'join-usage-test.json'
    )
    const log = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'))
    fs.writeFileSync(
      sessionPath,
      JSON.stringify({ ...log, cwd: '/work/repo', gitBranch: 'polecat/mem-42' }),
      'utf-8'
    )
    mockAnalyzeWithLlm.mockResolvedValue({
      ok: false,
      reason: 'spawn-error',
      detail: 'claude not found',
    })

    const transcriptPath = path.join(tempDir, 'join-transcript.jsonl')
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({
        type: 'assistant',
        message: { id: 'm1', usage: { input_tokens: 10, output_tokens: 5 } },
      }),
      'utf-8'
    )

    await analyzeCompletedSession('join-usage-test', process.cwd(), transcriptPath)

    const entry = readUsageEntries().find((e) => e['operation'] === 'session-usage')
    const detail = (entry?.['detail'] ?? {}) as Record<string, unknown>
    expect(detail['cwd']).toBe('/work/repo')
    expect(detail['gitBranch']).toBe('polecat/mem-42')
  })

  it('logs the fallback with its reason when the LLM path fails', async () => {
    writeSessionFile('log-test')
    mockAnalyzeWithLlm.mockResolvedValue({
      ok: false,
      reason: 'timeout',
      detail: 'claude did not respond within 45000ms',
    })

    const result = await analyzeCompletedSession('log-test')
    expect(result.success).toBe(true)

    const entries = readUsageEntries()
    expect(entries).toHaveLength(1)
    const entry = entries[0] ?? {}
    expect(entry['operation']).toBe('session-analysis-fallback')
    expect(entry['model']).toBe('none')
    expect(entry['tokenCount']).toBe(0)
    expect(entry['sessionId']).toBe('log-test')
    expect(entry['reason']).toContain('timeout')
    expect(entry['reason']).toContain('45000ms')
  })

  it('uses heuristic extraction on LLM failure', async () => {
    writeSessionFile('heuristic-fallback-test')
    mockAnalyzeWithLlm.mockResolvedValue({
      ok: false,
      reason: 'schema-mismatch',
      detail: 'urgency invalid',
    })

    const result = await analyzeCompletedSession('heuristic-fallback-test')

    expect(result.success).toBe(true)
    expect(result.sessionModel?.interactionPatterns).toContain('uses-Read')
  })

  it('uses the LLM session model and logs real model and tokens on success', async () => {
    writeSessionFile('llm-success-test')
    const llmModel = {
      sessionId: 'llm-success-test',
      intent: 'deep refactor of the session pipeline',
      interactionPatterns: ['reads-before-editing'],
      codingPreferences: ['typescript strict mode'],
      satisfactionSignals: {
        frustration: false,
        satisfaction: true,
        urgency: 'medium' as const,
      },
    }
    mockAnalyzeWithLlm.mockResolvedValue({
      ok: true,
      model: llmModel,
      tokensUsed: 1234,
      path: 'llm',
    })

    const result = await analyzeCompletedSession('llm-success-test')

    expect(result.success).toBe(true)
    expect(result.sessionModel).toEqual(llmModel)

    // The persisted Tier 2 model is the LLM-derived one, not the heuristic one
    const modelPath = path.join(
      tempDir, '.claude', 'tom', 'session-models', 'llm-success-test.json'
    )
    expect(JSON.parse(fs.readFileSync(modelPath, 'utf-8'))).toEqual(llmModel)

    const entries = readUsageEntries()
    expect(entries).toHaveLength(1)
    const entry = entries[0] ?? {}
    expect(entry['operation']).toBe('session-analysis')
    expect(entry['model']).toBe('haiku')
    expect(entry['tokenCount']).toBe(1234)
    expect(entry['sessionId']).toBe('llm-success-test')
  })

  it('passes the configured memoryUpdate model to the LLM analyzer', async () => {
    const tomDir = path.join(tempDir, '.claude', 'tom')
    fs.mkdirSync(tomDir, { recursive: true })
    fs.writeFileSync(
      path.join(tomDir, 'config.json'),
      JSON.stringify({ enabled: true, models: { memoryUpdate: 'claude-sonnet-4-6' } }),
      'utf-8'
    )
    writeSessionFile('configured-model-test')

    await analyzeCompletedSession('configured-model-test')

    expect(mockAnalyzeWithLlm).toHaveBeenCalledTimes(1)
    const [logArg, modelArg] = mockAnalyzeWithLlm.mock.calls[0] ?? []
    expect(logArg?.sessionId).toBe('configured-model-test')
    expect(modelArg).toBe('claude-sonnet-4-6')
  })

  it('logs tokenCount 0 when LLM token usage is unavailable', async () => {
    writeSessionFile('no-tokens-test')
    mockAnalyzeWithLlm.mockResolvedValue({
      ok: true,
      model: {
        sessionId: 'no-tokens-test',
        intent: 'quick read',
        interactionPatterns: [],
        codingPreferences: [],
        satisfactionSignals: { frustration: false, satisfaction: true, urgency: 'low' },
      },
      tokensUsed: null,
      path: 'llm',
    })

    await analyzeCompletedSession('no-tokens-test')

    const entries = readUsageEntries()
    const entry = entries[0] ?? {}
    expect(entry['operation']).toBe('session-analysis')
    expect(entry['tokenCount']).toBe(0)
  })

  it('logs a preference-correction batch entry when the LLM model carries corrections', async () => {
    writeSessionFile('correction-telemetry-test')
    mockAnalyzeWithLlm.mockResolvedValue({
      ok: true,
      model: {
        sessionId: 'correction-telemetry-test',
        intent: 'swap test runner',
        interactionPatterns: [],
        codingPreferences: [],
        satisfactionSignals: { frustration: false, satisfaction: true, urgency: 'low' },
        corrections: [
          {
            category: 'codingPreferences',
            key: 'preference',
            correctedValue: 'vitest',
            evidence: 'user replaced jest with vitest',
          },
          {
            category: 'interactionStyle',
            key: 'verbosity',
            evidence: 'user asked for shorter answers',
          },
        ],
      },
      tokensUsed: 100,
      path: 'llm',
    })

    await analyzeCompletedSession('correction-telemetry-test')

    const entries = readUsageEntries()
    const correctionEntries = entries.filter(
      (e) => e['operation'] === 'preference-correction'
    )
    // One entry per correction batch, not per correction
    expect(correctionEntries).toHaveLength(1)
    const entry = correctionEntries[0] ?? {}
    expect(entry['model']).toBe('none')
    expect(entry['sessionId']).toBe('correction-telemetry-test')
    const detail = entry['detail'] as Record<string, unknown>
    expect(detail['corrections']).toEqual([
      'codingPreferences:preference',
      'interactionStyle:verbosity',
    ])
    expect(detail['penalty']).toBe(0.5)
  })

  it('uses the configured correctionPenalty in correction telemetry', async () => {
    const tomDir = path.join(tempDir, '.claude', 'tom')
    fs.mkdirSync(tomDir, { recursive: true })
    fs.writeFileSync(
      path.join(tomDir, 'config.json'),
      JSON.stringify({ enabled: true, correctionPenalty: 0.25 }),
      'utf-8'
    )
    writeSessionFile('penalty-config-test')
    mockAnalyzeWithLlm.mockResolvedValue({
      ok: true,
      model: {
        sessionId: 'penalty-config-test',
        intent: 'quick fix',
        interactionPatterns: [],
        codingPreferences: [],
        satisfactionSignals: { frustration: false, satisfaction: true, urgency: 'low' },
        corrections: [
          {
            category: 'codingPreferences',
            key: 'preference',
            evidence: 'user reverted the change',
          },
        ],
      },
      tokensUsed: 50,
      path: 'llm',
    })

    await analyzeCompletedSession('penalty-config-test')

    const entries = readUsageEntries()
    const entry = entries.find((e) => e['operation'] === 'preference-correction') ?? {}
    const detail = (entry['detail'] ?? {}) as Record<string, unknown>
    expect(detail['penalty']).toBe(0.25)
  })

  it('logs no preference-correction entry when the session has no corrections', async () => {
    writeSessionFile('no-corrections-test')
    mockAnalyzeWithLlm.mockResolvedValue({
      ok: true,
      model: {
        sessionId: 'no-corrections-test',
        intent: 'quick read',
        interactionPatterns: [],
        codingPreferences: [],
        satisfactionSignals: { frustration: false, satisfaction: true, urgency: 'low' },
        corrections: [],
      },
      tokensUsed: 10,
      path: 'llm',
    })

    await analyzeCompletedSession('no-corrections-test')

    const entries = readUsageEntries()
    expect(
      entries.some((e) => e['operation'] === 'preference-correction')
    ).toBe(false)
  })

  it('applies corrections to the persisted user model', async () => {
    const tomDir = path.join(tempDir, '.claude', 'tom')
    fs.mkdirSync(tomDir, { recursive: true })
    fs.writeFileSync(
      path.join(tomDir, 'user-model.json'),
      JSON.stringify({
        preferencesClusters: [
          {
            category: 'codingPreferences',
            key: 'preference',
            value: 'jest',
            confidence: 0.8,
            lastUpdated: new Date().toISOString(),
            sessionCount: 8,
          },
        ],
        interactionStyleSummary: '',
        codingStyleSummary: '',
        projectOverrides: {},
      }),
      'utf-8'
    )
    writeSessionFile('apply-corrections-test')
    mockAnalyzeWithLlm.mockResolvedValue({
      ok: true,
      model: {
        sessionId: 'apply-corrections-test',
        intent: 'migrate tests',
        interactionPatterns: [],
        codingPreferences: [],
        satisfactionSignals: { frustration: false, satisfaction: true, urgency: 'low' },
        corrections: [
          {
            category: 'codingPreferences',
            key: 'preference',
            correctedValue: 'vitest',
            evidence: 'user replaced jest with vitest',
          },
        ],
      },
      tokensUsed: 100,
      path: 'llm',
    })

    await analyzeCompletedSession('apply-corrections-test')

    const userModel = JSON.parse(
      fs.readFileSync(path.join(tomDir, 'user-model.json'), 'utf-8')
    ) as { preferencesClusters: Array<Record<string, unknown>> }
    const winner = userModel.preferencesClusters.find(
      (p) => p['category'] === 'codingPreferences' && p['key'] === 'preference'
    )
    // The corrected-to value wins conflict resolution and starts accumulating
    expect(winner?.['value']).toBe('vitest')
    expect(winner?.['confidence']).toBeCloseTo(0.1)
  })

  function writeUserModelFile(clusters: readonly object[]): string {
    const tomDir = path.join(tempDir, '.claude', 'tom')
    fs.mkdirSync(tomDir, { recursive: true })
    const modelPath = path.join(tomDir, 'user-model.json')
    fs.writeFileSync(
      modelPath,
      JSON.stringify({
        preferencesClusters: clusters,
        interactionStyleSummary: '',
        codingStyleSummary: '',
        projectOverrides: {},
      }),
      'utf-8'
    )
    return modelPath
  }

  function stableCluster(overrides: Record<string, unknown> = {}): object {
    return {
      category: 'interactionStyle',
      key: 'verbosity',
      value: 'concise',
      confidence: 0.9,
      lastUpdated: new Date().toISOString(),
      sessionCount: 10,
      ...overrides,
    }
  }

  it('promotes stable preferences into the global CLAUDE.md and persists promoted flags', async () => {
    const modelPath = writeUserModelFile([stableCluster()])
    writeSessionFile('promotion-test')

    const result = await analyzeCompletedSession('promotion-test')
    expect(result.success).toBe(true)

    // Block written to the global memory file (created since ~/.claude exists)
    const globalClaudeMd = path.join(tempDir, '.claude', 'CLAUDE.md')
    expect(fs.existsSync(globalClaudeMd)).toBe(true)
    const content = fs.readFileSync(globalClaudeMd, 'utf-8')
    expect(content).toContain('<!-- tom-swe:begin')
    expect(content).toContain('Prefers concise')
    expect(content).toContain('<!-- tom-swe:end -->')

    // Promoted flag persisted in the user model
    const persisted = JSON.parse(fs.readFileSync(modelPath, 'utf-8')) as {
      preferencesClusters: Array<Record<string, unknown>>
    }
    const promoted = persisted.preferencesClusters.find(
      (p) => p['key'] === 'verbosity'
    )
    expect(promoted?.['promoted']).toBe(true)

    // One preference-promotion usage entry listing pairs and targets
    const entries = readUsageEntries()
    const promotionEntry = entries.find(
      (e) => e['operation'] === 'preference-promotion'
    )
    expect(promotionEntry).toBeDefined()
    const detail = (promotionEntry?.['detail'] ?? {}) as Record<string, unknown>
    expect(detail['promoted']).toEqual(['interactionStyle:verbosity'])
    expect(detail['targets']).toContain(globalClaudeMd)
    // File creation is logged too — no silent resource creation
    expect(
      entries.some((e) => e['operation'] === 'promotion-file-created')
    ).toBe(true)
  })

  it('routes stable coding preferences to an existing project CLAUDE.md', async () => {
    // cwd is tempDir (chdir in beforeEach); the project memory file exists
    const projectClaudeMd = path.join(tempDir, 'CLAUDE.md')
    fs.writeFileSync(projectClaudeMd, '# Project rules\n', 'utf-8')
    writeUserModelFile([
      stableCluster({
        category: 'codingPreferences',
        key: 'testing',
        value: 'vitest',
      }),
    ])
    writeSessionFile('project-promotion-test')

    await analyzeCompletedSession('project-promotion-test')

    const content = fs.readFileSync(projectClaudeMd, 'utf-8')
    expect(content).toContain('# Project rules')
    expect(content).toContain('Prefers vitest')
  })

  it('does not promote preferences below the promotion thresholds', async () => {
    writeUserModelFile([stableCluster({ confidence: 0.5 })])
    writeSessionFile('no-promotion-test')

    await analyzeCompletedSession('no-promotion-test')

    expect(fs.existsSync(path.join(tempDir, '.claude', 'CLAUDE.md'))).toBe(false)
    const entries = readUsageEntries()
    expect(
      entries.some((e) => e['operation'] === 'preference-promotion')
    ).toBe(false)
  })

  it('logs promotion-error and completes the pipeline when promotion fails', async () => {
    // A directory at the global CLAUDE.md path makes the block write throw
    fs.mkdirSync(path.join(tempDir, '.claude', 'CLAUDE.md'), { recursive: true })
    writeUserModelFile([stableCluster()])
    writeSessionFile('promotion-error-test')

    const result = await analyzeCompletedSession('promotion-error-test')

    expect(result.success).toBe(true)
    expect(result.indexRebuilt).toBe(true)
    const entries = readUsageEntries()
    const errorEntry = entries.find((e) => e['operation'] === 'promotion-error')
    expect(errorEntry).toBeDefined()
    expect(errorEntry?.['sessionId']).toBe('promotion-error-test')
  })

  it('aggregates into existing user model', async () => {
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

    await analyzeCompletedSession('aggregate-test')

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
  let originalInternal: string | undefined
  let tempDir: string

  function enableTom(): void {
    const tomDir = path.join(tempDir, '.claude', 'tom')
    fs.mkdirSync(tomDir, { recursive: true })
    fs.writeFileSync(
      path.join(tomDir, 'config.json'),
      JSON.stringify({ enabled: true }),
      'utf-8'
    )
  }

  function writeSession(sessionId: string): void {
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
  }

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
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('is a no-op when tom is not enabled', async () => {
    // No settings file → tom.enabled is false
    await main(payloadStream({ session_id: 's1', hook_event_name: 'Stop' }))
    // Should not create any files
    const tomDir = path.join(tempDir, '.claude', 'tom')
    expect(fs.existsSync(path.join(tomDir, 'usage.log'))).toBe(false)
  })

  it('runs analysis for the payload session_id when tom is enabled', async () => {
    enableTom()
    const sessionId = 'main-test-session'
    writeSession(sessionId)

    await main(payloadStream({
      session_id: sessionId,
      hook_event_name: 'Stop',
      stop_hook_active: false,
    }))

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

  it('prefers payload session_id over CLAUDE_SESSION_ID', async () => {
    enableTom()
    process.env['CLAUDE_SESSION_ID'] = 'env-session'
    writeSession('payload-session')

    await main(payloadStream({
      session_id: 'payload-session',
      hook_event_name: 'Stop',
    }))

    const modelPath = path.join(
      tempDir, '.claude', 'tom', 'session-models', 'payload-session.json'
    )
    expect(fs.existsSync(modelPath)).toBe(true)
  })

  it('falls back to CLAUDE_SESSION_ID on empty stdin', async () => {
    enableTom()
    process.env['CLAUDE_SESSION_ID'] = 'env-session'
    writeSession('env-session')

    await main(Readable.from(['']))

    const modelPath = path.join(
      tempDir, '.claude', 'tom', 'session-models', 'env-session.json'
    )
    expect(fs.existsSync(modelPath)).toBe(true)
  })

  it('exits immediately without output when stop_hook_active is true', async () => {
    enableTom()
    const sessionId = 'loop-guard-session'
    writeSession(sessionId)

    await main(payloadStream({
      session_id: sessionId,
      hook_event_name: 'Stop',
      stop_hook_active: true,
    }))

    // No analysis artifacts should exist
    const modelPath = path.join(tempDir, '.claude', 'tom', 'session-models', `${sessionId}.json`)
    expect(fs.existsSync(modelPath)).toBe(false)
    const logPath = path.join(tempDir, '.claude', 'tom', 'usage.log')
    expect(fs.existsSync(logPath)).toBe(false)
  })

  it('exits silently when TOM_SWE_INTERNAL is "1"', async () => {
    enableTom()
    process.env['TOM_SWE_INTERNAL'] = '1'
    const sessionId = 'internal-session'
    writeSession(sessionId)

    await main(payloadStream({
      session_id: sessionId,
      hook_event_name: 'Stop',
    }))

    const modelPath = path.join(tempDir, '.claude', 'tom', 'session-models', `${sessionId}.json`)
    expect(fs.existsSync(modelPath)).toBe(false)
    const logPath = path.join(tempDir, '.claude', 'tom', 'usage.log')
    expect(fs.existsSync(logPath)).toBe(false)
  })

  it('does not throw when the session log does not exist', async () => {
    enableTom()

    // main() should not throw even on missing session
    await main(payloadStream({
      session_id: 'nonexistent-session',
      hook_event_name: 'Stop',
    }))
  })
})
