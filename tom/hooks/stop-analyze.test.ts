import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { Readable } from 'node:stream'
import {
  readRawSessionLog,
  analyzeCompletedSession,
  reconcilePreferenceCategories,
  main,
} from './stop-analyze'
import type { UserModel, PreferenceCluster } from '../schemas'
import { analyzeSessionWithLlm } from '../llm-analyze'

// Never spawn the real claude CLI in tests: the LLM path is mocked and
// defaults to failure so existing pipeline tests exercise the heuristic
// fallback. Individual tests override the resolved value.
vi.mock('../llm-analyze', () => ({
  analyzeSessionWithLlm: vi.fn(),
}))

// The derivability gate also spawns claude headlessly; tests pass
// everything through so promotion-pipeline assertions stay focused
// (gate behavior itself is covered in promotion.test.ts).
vi.mock('../promotion-gate', () => ({
  judgeDerivability: vi.fn(
    (candidates: ReadonlyArray<{ id: string }>) =>
      new Set(candidates.map((c) => c.id))
  ),
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
  // Recent timestamps: Tier 2 expiry is endedAt-keyed, so a fixture that
  // ended months ago would be expired by the prune step in the same run.
  return {
    sessionId,
    startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    endedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
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
    expect(result.sessionModel?.intent).toBe('brief code modification')
    // Heuristic fallback never speculates semantic preferences/patterns.
    expect(result.sessionModel?.interactionPatterns).toEqual([])
    expect(result.sessionModel?.codingPreferences).toEqual([])
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
    // The heuristic fallback emits no preference clusters; an actionable cluster
    // only comes from the LLM path, so mock a success with a coding preference.
    mockAnalyzeWithLlm.mockResolvedValue({
      ok: true,
      model: {
        sessionId: 'user-model-test',
        intent: 'edit',
        interactionPatterns: [],
        codingPreferences: [{ key: 'test_runner', value: 'vitest' }],
        corrections: [],
      },
      tokensUsed: 100,
      path: 'llm',
    })

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
    if (!fs.existsSync(logPath)) return []
    return fs.readFileSync(logPath, 'utf-8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>)
  }

  function seedUserModel(cluster: Record<string, unknown>): void {
    const tomDir = path.join(tempDir, '.claude', 'tom')
    fs.mkdirSync(tomDir, { recursive: true })
    fs.writeFileSync(
      path.join(tomDir, 'user-model.json'),
      JSON.stringify({
        preferencesClusters: [cluster],
        interactionStyleSummary: '',
        codingStyleSummary: '',
        projectOverrides: {},
      }),
      'utf-8'
    )
  }

  it('logs vocabulary echo when a fresh LLM analysis reuses injected vocabulary', async () => {
    // A non-legacy cluster is injected as vocabulary; the returned model echoes
    // its key+value verbatim, so the instrument records a full echo.
    seedUserModel({
      category: 'interactionStyle',
      key: 'verbosity',
      value: 'concise',
      confidence: 0.7,
      lastUpdated: new Date().toISOString(),
      sessionCount: 4,
    })
    writeSessionFile('vocab-echo-test')
    mockAnalyzeWithLlm.mockResolvedValue({
      ok: true,
      model: {
        sessionId: 'vocab-echo-test',
        intent: 'work',
        interactionPatterns: [{ key: 'verbosity', value: 'concise' }],
        codingPreferences: [],
        corrections: [],
      },
      tokensUsed: 100,
      path: 'llm',
    })

    await analyzeCompletedSession('vocab-echo-test')

    const echo = readUsageEntries().find(
      (e) => e['operation'] === 'analysis-vocabulary-echo'
    )
    expect(echo).toBeDefined()
    expect(echo?.['detail']).toMatchObject({
      injected: 1,
      returned: 1,
      echoedKeyValue: 1,
      echoedKey: 1,
    })
  })

  it('does not log vocabulary echo when no vocabulary was injected', async () => {
    // No user-model.json → empty vocabulary → the echo instrument is skipped
    // even though the LLM path succeeded and returned keyed preferences.
    writeSessionFile('no-vocab-test')
    mockAnalyzeWithLlm.mockResolvedValue({
      ok: true,
      model: {
        sessionId: 'no-vocab-test',
        intent: 'work',
        interactionPatterns: [{ key: 'verbosity', value: 'concise' }],
        codingPreferences: [],
        corrections: [],
      },
      tokensUsed: 100,
      path: 'llm',
    })

    await analyzeCompletedSession('no-vocab-test')

    const echo = readUsageEntries().find(
      (e) => e['operation'] === 'analysis-vocabulary-echo'
    )
    expect(echo).toBeUndefined()
  })

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

    // Three sessions; the one with the oldest activity (mtime) must be
    // pruned. All are aged past the 2h active-session guard except the one
    // being analyzed now.
    writeSessionFile('prune-old')
    writeSessionFile('prune-mid')
    writeSessionFile('prune-new')
    const sessionsDir = path.join(tomDir, 'sessions')
    const age = (id: string, hoursAgo: number): void => {
      const when = new Date(Date.now() - hoursAgo * 60 * 60 * 1000)
      fs.utimesSync(path.join(sessionsDir, `${id}.json`), when, when)
    }
    age('prune-old', 72)
    age('prune-mid', 48)
    // Pre-existing snapshot for the session about to be pruned: snapshots
    // now expire with their Tier 2 model (decay window), NOT with the log.
    const historyDir = path.join(tomDir, 'user-model-history')
    fs.mkdirSync(historyDir, { recursive: true })
    fs.writeFileSync(path.join(historyDir, 'prune-old.json'), '{}', 'utf-8')

    await analyzeCompletedSession('prune-new')

    expect(fs.existsSync(path.join(sessionsDir, 'prune-old.json'))).toBe(false)
    expect(fs.existsSync(path.join(historyDir, 'prune-old.json'))).toBe(true)
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
    // Heuristic fallback derives intent mechanically but never speculates
    // interaction patterns or coding preferences.
    expect(result.sessionModel?.intent).toBe('brief code exploration')
    expect(result.sessionModel?.interactionPatterns).toEqual([])
    expect(result.sessionModel?.codingPreferences).toEqual([])
  })

  it('preserves an existing Tier 2 model on LLM failure instead of downgrading to the heuristic', async () => {
    writeSessionFile('preserve-test')
    // A prior (richer) Tier 2 model already on disk, aged past the debounce
    // window so re-analysis is attempted again this turn. Its endedAt is
    // recent (within the decay window) so Tier 2 expiry leaves it alone.
    const priorEndedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
    const modelDir = path.join(tempDir, '.claude', 'tom', 'session-models')
    fs.mkdirSync(modelDir, { recursive: true })
    const modelPath = path.join(modelDir, 'preserve-test.json')
    fs.writeFileSync(
      modelPath,
      JSON.stringify({
        sessionId: 'preserve-test',
        intent: 'rich prior analysis worth keeping',
        interactionPatterns: ['reads-before-editing'],
        codingPreferences: ['typescript strict mode'],
        endedAt: priorEndedAt,
      }),
      'utf-8'
    )
    const aged = new Date(Date.now() - 5 * 60_000)
    fs.utimesSync(modelPath, aged, aged)

    mockAnalyzeWithLlm.mockResolvedValue({
      ok: false,
      reason: 'timeout',
      detail: 'claude did not respond within 90000ms',
    })

    const result = await analyzeCompletedSession('preserve-test')
    expect(result.success).toBe(true)
    // The prior model is kept, NOT replaced by the heuristic extractor.
    expect(result.sessionModel?.intent).toBe('rich prior analysis worth keeping')
    expect(result.sessionModel?.interactionPatterns).toEqual(['reads-before-editing'])
    // Preserve keeps the prior model's own endedAt (decay anchor) intact —
    // it is NOT overwritten with this turn's Tier 1 endedAt.
    expect(result.sessionModel?.endedAt).toBe(priorEndedAt)
    // On-disk Tier 2 still holds the prior model.
    const persisted = JSON.parse(fs.readFileSync(modelPath, 'utf-8'))
    expect(persisted.intent).toBe('rich prior analysis worth keeping')

    // Telemetry distinguishes preservation from a real heuristic synthesis.
    const fallback = readUsageEntries().find(
      (e) => e['operation'] === 'session-analysis-fallback'
    )
    const detail = (fallback?.['detail'] ?? {}) as Record<string, unknown>
    expect(detail['path']).toBe('preserved')
    expect(detail['failure']).toBe('timeout')
  })

  it('synthesizes a heuristic model on LLM failure when no prior model exists, logged as path=heuristic', async () => {
    writeSessionFile('no-prior-test')
    mockAnalyzeWithLlm.mockResolvedValue({
      ok: false,
      reason: 'timeout',
      detail: 'claude did not respond within 90000ms',
    })

    const result = await analyzeCompletedSession('no-prior-test')
    expect(result.success).toBe(true)
    expect(result.sessionModel?.intent).toBe('brief code exploration')

    const fallback = readUsageEntries().find(
      (e) => e['operation'] === 'session-analysis-fallback'
    )
    const detail = (fallback?.['detail'] ?? {}) as Record<string, unknown>
    expect(detail['path']).toBe('heuristic')
  })

  it('overwrites a prior Tier 2 model when the LLM analysis succeeds', async () => {
    writeSessionFile('overwrite-test')
    const modelDir = path.join(tempDir, '.claude', 'tom', 'session-models')
    fs.mkdirSync(modelDir, { recursive: true })
    const modelPath = path.join(modelDir, 'overwrite-test.json')
    fs.writeFileSync(
      modelPath,
      JSON.stringify({
        sessionId: 'overwrite-test',
        intent: 'stale prior',
        interactionPatterns: [],
        codingPreferences: [],
      }),
      'utf-8'
    )
    const aged = new Date(Date.now() - 5 * 60_000)
    fs.utimesSync(modelPath, aged, aged)

    mockAnalyzeWithLlm.mockResolvedValue({
      ok: true,
      model: {
        sessionId: 'overwrite-test',
        intent: 'fresh llm analysis',
        interactionPatterns: [],
        codingPreferences: [],
      },
      tokensUsed: 50,
      path: 'llm',
    })

    const result = await analyzeCompletedSession('overwrite-test')
    expect(result.sessionModel?.intent).toBe('fresh llm analysis')
    const persisted = JSON.parse(fs.readFileSync(modelPath, 'utf-8'))
    expect(persisted.intent).toBe('fresh llm analysis')
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
    // endedAt and the userMessage watermark are stamped mechanically from
    // the Tier 1 log.
    expect(result.sessionModel).toEqual({
      ...llmModel,
      endedAt: expect.any(String),
      analyzedUserMessageCount: 0,
    })

    // The persisted Tier 2 model is the LLM-derived one, not the heuristic one
    const modelPath = path.join(
      tempDir, '.claude', 'tom', 'session-models', 'llm-success-test.json'
    )
    expect(JSON.parse(fs.readFileSync(modelPath, 'utf-8'))).toEqual({
      ...llmModel,
      endedAt: expect.any(String),
      analyzedUserMessageCount: 0,
    })

    const entries = readUsageEntries()
    expect(entries).toHaveLength(1)
    const entry = entries[0] ?? {}
    expect(entry['operation']).toBe('session-analysis')
    expect(entry['model']).toBe('haiku')
    expect(entry['tokenCount']).toBe(1234)
    expect(entry['sessionId']).toBe('llm-success-test')
  })

  it('logs analysis-log-truncated with the dropped count when the prompt was bounded', async () => {
    writeSessionFile('truncation-test')
    mockAnalyzeWithLlm.mockResolvedValue({
      ok: true,
      model: {
        sessionId: 'truncation-test',
        intent: 'bounded',
        interactionPatterns: [],
        codingPreferences: [],
        satisfactionSignals: { frustration: false, satisfaction: true, urgency: 'low' },
        corrections: [],
      },
      tokensUsed: 10,
      path: 'llm',
      dropped: 7,
    })

    const result = await analyzeCompletedSession('truncation-test')
    expect(result.success).toBe(true)

    const truncEntry = readUsageEntries().find(
      (e) => e['operation'] === 'analysis-log-truncated'
    )
    expect(truncEntry).toBeDefined()
    expect(truncEntry?.['sessionId']).toBe('truncation-test')
    const detail = (truncEntry?.['detail'] ?? {}) as Record<string, unknown>
    expect(detail['dropped']).toBe(7)
  })

  it('emits no analysis-log-truncated entry when nothing was dropped', async () => {
    writeSessionFile('no-truncation-test')
    mockAnalyzeWithLlm.mockResolvedValue({
      ok: true,
      model: {
        sessionId: 'no-truncation-test',
        intent: 'within budget',
        interactionPatterns: [],
        codingPreferences: [],
        satisfactionSignals: { frustration: false, satisfaction: false, urgency: 'low' },
        corrections: [],
      },
      tokensUsed: 10,
      path: 'llm',
      dropped: 0,
    })

    await analyzeCompletedSession('no-truncation-test')

    expect(
      readUsageEntries().some((e) => e['operation'] === 'analysis-log-truncated')
    ).toBe(false)
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

  it('emits a follow-through record splitting injected keys into confirmed vs corrected', async () => {
    // Seed the session-start injection that asserted two preference keys, as a
    // prior process would have written it before this Stop analyzes the session.
    const tomDir = path.join(tempDir, '.claude', 'tom')
    fs.mkdirSync(tomDir, { recursive: true })
    fs.appendFileSync(
      path.join(tomDir, 'usage.log'),
      JSON.stringify({
        v: 1,
        timestamp: '2026-07-01T00:00:00.000Z',
        operation: 'session-start-injection',
        model: 'none',
        tokenCount: 0,
        sessionId: 'follow-through-test',
        detail: {
          chars: 80,
          lines: 2,
          preferences: 2,
          injectedKeys: ['codingPreferences:language', 'interactionStyle:verbosity'],
        },
      }) + '\n',
      'utf-8'
    )
    writeSessionFile('follow-through-test')
    // The user corrects exactly one of the two asserted keys in-session.
    mockAnalyzeWithLlm.mockResolvedValue({
      ok: true,
      model: {
        sessionId: 'follow-through-test',
        intent: 'switch language',
        interactionPatterns: [],
        codingPreferences: [],
        satisfactionSignals: { frustration: false, satisfaction: true, urgency: 'low' },
        corrections: [
          {
            category: 'codingPreferences',
            key: 'language',
            correctedValue: 'rust',
            evidence: 'user switched from typescript to rust',
          },
        ],
      },
      tokensUsed: 100,
      path: 'llm',
    })

    await analyzeCompletedSession('follow-through-test')

    const entries = readUsageEntries()
    const record = entries.find(
      (e) => e['operation'] === 'preference-follow-through'
    )
    expect(record).toBeDefined()
    expect(record?.['sessionId']).toBe('follow-through-test')
    const detail = (record?.['detail'] ?? {}) as Record<string, unknown>
    expect(detail['asserted']).toEqual([
      'codingPreferences:language',
      'interactionStyle:verbosity',
    ])
    expect(detail['corrected']).toEqual(['codingPreferences:language'])
    expect(detail['confirmed']).toEqual(['interactionStyle:verbosity'])
  })

  it('does not emit a follow-through record when nothing was asserted', async () => {
    writeSessionFile('no-assertion-test')
    mockAnalyzeWithLlm.mockResolvedValue({
      ok: true,
      model: {
        sessionId: 'no-assertion-test',
        intent: 'quick fix',
        interactionPatterns: [],
        codingPreferences: [],
        satisfactionSignals: { frustration: false, satisfaction: true, urgency: 'low' },
        corrections: [],
      },
      tokensUsed: 50,
      path: 'llm',
    })

    await analyzeCompletedSession('no-assertion-test')

    const entries = readUsageEntries()
    expect(
      entries.find((e) => e['operation'] === 'preference-follow-through')
    ).toBeUndefined()
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

  /**
   * Seeds N Tier 2 session models carrying the same keyed preference.
   * Tier 3 is rebuilt from Tier 2 on every analysis, so N recent models
   * yield confidence ~0.1*N and sessionCount N for that preference —
   * the honest way to reach promotion thresholds under rebuild semantics.
   */
  function seedTier2(
    count: number,
    fields: { category: 'interactionStyle' | 'codingPreferences'; key: string; value: string }
  ): void {
    const modelsDir = path.join(tempDir, '.claude', 'tom', 'session-models')
    fs.mkdirSync(modelsDir, { recursive: true })
    for (let i = 0; i < count; i++) {
      const entry = { key: fields.key, value: fields.value }
      const model = {
        sessionId: `seed-${fields.key}-${i}`,
        intent: 'seed session',
        interactionPatterns: fields.category === 'interactionStyle' ? [entry] : [],
        codingPreferences: fields.category === 'codingPreferences' ? [entry] : [],
        satisfactionSignals: { frustration: false, satisfaction: true, urgency: 'low' },
        corrections: [],
        endedAt: new Date(Date.now() - (count - i) * 60_000).toISOString(),
      }
      fs.writeFileSync(
        path.join(modelsDir, `${model.sessionId}.json`),
        JSON.stringify(model),
        'utf-8'
      )
    }
  }

  /**
   * Seeds one Tier 2 session carrying the same key under BOTH categories —
   * the shape that forms a cross-category split during the rebuild fold
   * (canonicalCategoryByKey is empty when the key is first seen, so both
   * categories are added before any canonical answer exists).
   */
  function seedSplitTier2(key: string): void {
    const modelsDir = path.join(tempDir, '.claude', 'tom', 'session-models')
    fs.mkdirSync(modelsDir, { recursive: true })
    const model = {
      sessionId: `seed-split-${key}`,
      intent: 'seed split session',
      interactionPatterns: [{ key, value: 'from_interaction' }],
      codingPreferences: [{ key, value: 'from_coding' }],
      satisfactionSignals: { frustration: false, satisfaction: true, urgency: 'low' },
      corrections: [],
      // Oldest session, so the split forms before either category is
      // established — later single-category sessions then can't re-file it.
      endedAt: new Date(Date.now() - 600_000).toISOString(),
    }
    fs.writeFileSync(
      path.join(modelsDir, `${model.sessionId}.json`),
      JSON.stringify(model),
      'utf-8'
    )
  }

  it('collapses a pre-existing cross-category split to one category on rebuild, with a telemetry trace', async () => {
    // Reinforce codingPreferences twice so it out-weighs interactionStyle and
    // wins reconciliation deterministically by confidence.
    seedTier2(2, {
      category: 'codingPreferences',
      key: 'execution_backend_for_iteration',
      value: 'local_scripts',
    })
    seedSplitTier2('execution_backend_for_iteration')
    writeSessionFile('split-collapse-test')
    mockAnalyzeWithLlm.mockResolvedValue({
      ok: true,
      model: {
        sessionId: 'split-collapse-test',
        intent: 'trigger rebuild',
        interactionPatterns: [],
        codingPreferences: [],
        satisfactionSignals: { frustration: false, satisfaction: true, urgency: 'low' },
        corrections: [],
      },
      tokensUsed: 10,
      path: 'llm',
    })

    await analyzeCompletedSession('split-collapse-test')

    const userModel = JSON.parse(
      fs.readFileSync(path.join(tempDir, '.claude', 'tom', 'user-model.json'), 'utf-8')
    ) as { preferencesClusters: Array<Record<string, unknown>> }
    const cats = new Set(
      userModel.preferencesClusters
        .filter((p) => p['key'] === 'execution_backend_for_iteration')
        .map((p) => p['category'])
    )
    expect(cats).toEqual(new Set(['codingPreferences']))

    const collapse = readUsageEntries().find(
      (e) => e['operation'] === 'preference-cross-category-collapse'
    )
    expect(collapse).toBeDefined()
    const detail = collapse?.['detail'] as {
      collapses: Array<{ key: string; winner: string; refiled: unknown[] }>
    }
    expect(detail.collapses[0]?.key).toBe('execution_backend_for_iteration')
    expect(detail.collapses[0]?.winner).toBe('codingPreferences')
    expect(detail.collapses[0]?.refiled.length).toBeGreaterThan(0)
  })

  it('suppresses collapse telemetry once the previous model already resolved the key', async () => {
    seedTier2(2, {
      category: 'codingPreferences',
      key: 'execution_backend_for_iteration',
      value: 'local_scripts',
    })
    seedSplitTier2('execution_backend_for_iteration')
    // Previous model already has the key collapsed to the eventual winner, so
    // this rebuild's re-collapse is not new information and must not re-log.
    seedUserModel({
      category: 'codingPreferences',
      key: 'execution_backend_for_iteration',
      value: 'local_scripts',
      confidence: 0.5,
      lastUpdated: new Date().toISOString(),
      sessionCount: 3,
    })
    writeSessionFile('split-suppress-test')
    mockAnalyzeWithLlm.mockResolvedValue({
      ok: true,
      model: {
        sessionId: 'split-suppress-test',
        intent: 'trigger rebuild',
        interactionPatterns: [],
        codingPreferences: [],
        satisfactionSignals: { frustration: false, satisfaction: true, urgency: 'low' },
        corrections: [],
      },
      tokensUsed: 10,
      path: 'llm',
    })

    await analyzeCompletedSession('split-suppress-test')

    const collapse = readUsageEntries().find(
      (e) => e['operation'] === 'preference-cross-category-collapse'
    )
    expect(collapse).toBeUndefined()
  })

  function makeSplitReconcileInputs(
    interactionValue: string,
    interactionUpdatedAt: string
  ): { rebuilt: UserModel; previous: UserModel } {
    const key = 'execution_backend_for_iteration'
    const previous: UserModel = {
      preferencesClusters: [
        {
          category: 'codingPreferences',
          key,
          value: 'local_scripts',
          confidence: 0.5,
          lastUpdated: '2026-06-01T00:00:00.000Z',
          sessionCount: 3,
        },
      ],
      interactionStyleSummary: '',
      codingStyleSummary: '',
      projectOverrides: {},
    }
    // A persistently-split key re-forms the split each rebuild; codingPreferences
    // still out-weighs interactionStyle by confidence, so the winner CATEGORY is
    // unchanged from `previous`. Only the value may differ.
    const rebuilt: UserModel = {
      ...previous,
      preferencesClusters: [
        previous.preferencesClusters[0] as PreferenceCluster,
        {
          category: 'interactionStyle',
          key,
          value: interactionValue,
          confidence: 0.1,
          lastUpdated: interactionUpdatedAt,
          sessionCount: 1,
          learnedVia: 'correction',
        },
      ],
    }
    return { rebuilt, previous }
  }

  it('re-logs a collapse when fresh losing-category evidence flips the resolved value (winner category unchanged)', () => {
    // The audit-trail gap: without value-aware suppression this collapse would
    // be silenced because the winner category (codingPreferences) is unchanged,
    // yet the resolved value silently flips to the fresher correction.
    const { rebuilt, previous } = makeSplitReconcileInputs(
      'remote_sandbox',
      '2026-07-01T00:00:00.000Z'
    )
    const result = reconcilePreferenceCategories(rebuilt, previous, 'flip-test')

    const survivor = result.preferencesClusters.filter(
      (p) => p.key === 'execution_backend_for_iteration'
    )
    expect(survivor).toHaveLength(1)
    expect(survivor[0]?.category).toBe('codingPreferences')
    expect(survivor[0]?.value).toBe('remote_sandbox')

    const collapse = readUsageEntries().find(
      (e) => e['operation'] === 'preference-cross-category-collapse'
    )
    expect(collapse).toBeDefined()
    const detail = collapse?.['detail'] as {
      collapses: Array<{ resolvedValue: string; refiled: unknown[] }>
    }
    expect(detail.collapses[0]?.resolvedValue).toBe('remote_sandbox')
  })

  it('suppresses the collapse when winner category AND resolved value are both unchanged', () => {
    // Steady state: the split re-forms but resolves to the same value the
    // previous model already had — nothing new to report.
    const { rebuilt, previous } = makeSplitReconcileInputs(
      'local_scripts',
      '2026-05-01T00:00:00.000Z'
    )
    reconcilePreferenceCategories(rebuilt, previous, 'stable-test')

    const collapse = readUsageEntries().find(
      (e) => e['operation'] === 'preference-cross-category-collapse'
    )
    expect(collapse).toBeUndefined()
  })

  it('redacts a structured secret in the cross-category-collapse telemetry values', () => {
    // The collapse trace is the one path that logs raw preference VALUES to the
    // durable usage.log; a secret value must be redacted before it lands there.
    const key = 'execution_backend_for_iteration'
    const previous: UserModel = {
      preferencesClusters: [
        {
          category: 'codingPreferences',
          key,
          value: 'local_scripts',
          confidence: 0.5,
          lastUpdated: '2026-06-01T00:00:00.000Z',
          sessionCount: 3,
        },
      ],
      interactionStyleSummary: '',
      codingStyleSummary: '',
      projectOverrides: {},
    }
    const rebuilt: UserModel = {
      ...previous,
      preferencesClusters: [
        previous.preferencesClusters[0] as PreferenceCluster,
        {
          category: 'interactionStyle',
          key,
          value: 'ghp_ABCDEF1234567890',
          confidence: 0.1,
          lastUpdated: '2026-07-01T00:00:00.000Z',
          sessionCount: 1,
          learnedVia: 'correction',
        },
      ],
    }

    reconcilePreferenceCategories(rebuilt, previous, 'secret-value-test')

    const collapse = readUsageEntries().find(
      (e) => e['operation'] === 'preference-cross-category-collapse'
    )
    expect(collapse).toBeDefined()
    const serialized = JSON.stringify(collapse)
    expect(serialized).not.toContain('ghp_ABCDEF1234567890')
    expect(serialized).toContain('[REDACTED]')
  })

  it('promotes stable preferences into the global CLAUDE.md and persists promoted flags', async () => {
    seedTier2(9, { category: 'interactionStyle', key: 'verbosity', value: 'concise' })
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
    const persisted = JSON.parse(
      fs.readFileSync(path.join(tempDir, '.claude', 'tom', 'user-model.json'), 'utf-8')
    ) as {
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
    seedTier2(9, { category: 'codingPreferences', key: 'testing', value: 'vitest' })
    writeSessionFile('project-promotion-test')

    await analyzeCompletedSession('project-promotion-test')

    const content = fs.readFileSync(projectClaudeMd, 'utf-8')
    expect(content).toContain('# Project rules')
    expect(content).toContain('Prefers vitest')
  })

  it('does not inflate confidence when the same session is analyzed repeatedly', async () => {
    // THE dogfooding regression: Stop fires per turn-end; incremental
    // aggregation re-reinforced the same session every fire (9 analyses /
    // 4 sessions inflated a preference to 90% in a day). Under rebuild,
    // N analyses of one session contribute exactly one session's worth.
    writeSessionFile('idempotent-test')
    mockAnalyzeWithLlm.mockResolvedValue({
      ok: true,
      model: {
        sessionId: 'idempotent-test',
        intent: 'edit',
        interactionPatterns: [],
        codingPreferences: [{ key: 'test_runner', value: 'vitest' }],
        corrections: [],
      },
      tokensUsed: 100,
      path: 'llm',
    })
    const modelsDir = path.join(tempDir, '.claude', 'tom', 'session-models')

    await analyzeCompletedSession('idempotent-test')
    // Age the Tier 2 file past the debounce window, then re-analyze twice.
    for (let i = 0; i < 2; i++) {
      const tier2 = path.join(modelsDir, 'idempotent-test.json')
      const past = new Date(Date.now() - 10 * 60_000)
      fs.utimesSync(tier2, past, past)
      await analyzeCompletedSession('idempotent-test')
    }

    const userModel = JSON.parse(
      fs.readFileSync(path.join(tempDir, '.claude', 'tom', 'user-model.json'), 'utf-8')
    ) as { preferencesClusters: Array<{ key: string; confidence: number; sessionCount: number }> }
    const pref = userModel.preferencesClusters.find((p) => p.key === 'test_runner')
    expect(pref?.sessionCount).toBe(1)
    expect(pref?.confidence).toBeCloseTo(0.1)
  })

  it('anchors the analyzer to existing vocabulary, excluding legacy generic keys', async () => {
    const tomDir = path.join(tempDir, '.claude', 'tom')
    fs.mkdirSync(tomDir, { recursive: true })
    fs.writeFileSync(
      path.join(tomDir, 'user-model.json'),
      JSON.stringify({
        preferencesClusters: [
          {
            category: 'codingPreferences',
            key: 'test_runner',
            value: 'vitest',
            confidence: 0.5,
            lastUpdated: '2026-06-01T00:00:00.000Z',
            sessionCount: 5,
          },
          {
            category: 'codingPreferences',
            key: 'preference',
            value: 'some legacy sentence',
            confidence: 0.3,
            lastUpdated: '2026-06-01T00:00:00.000Z',
            sessionCount: 2,
          },
        ],
        interactionStyleSummary: '',
        codingStyleSummary: '',
        projectOverrides: {},
      }),
      'utf-8'
    )
    writeSessionFile('vocab-test')

    await analyzeCompletedSession('vocab-test')

    const call = mockAnalyzeWithLlm.mock.calls[0]
    const options = (call?.[2] ?? {}) as { vocabulary?: Array<{ key: string }> }
    const keys = (options.vocabulary ?? []).map((v) => v.key)
    expect(keys).toContain('test_runner')
    expect(keys).not.toContain('preference')
  })

  it('debounces re-analysis of a freshly analyzed session', async () => {
    writeSessionFile('debounce-test')

    const first = await analyzeCompletedSession('debounce-test')
    expect(first.sessionModel).not.toBeNull()

    // Immediate re-fire (same turn cadence): skipped, logged, no LLM call.
    mockAnalyzeWithLlm.mockClear()
    const second = await analyzeCompletedSession('debounce-test')
    expect(second.success).toBe(true)
    expect(second.sessionModel).toBeNull()
    expect(second.userModelUpdated).toBe(false)
    expect(mockAnalyzeWithLlm).not.toHaveBeenCalled()

    const entries = readUsageEntries()
    expect(entries.some((e) => e['operation'] === 'analysis-debounced')).toBe(true)
  })

  it('skips re-analysis when no new user messages arrived since the last analysis', async () => {
    // First analysis stamps the watermark (0 user messages).
    writeSessionFile('watermark-test')
    const first = await analyzeCompletedSession('watermark-test')
    expect(first.sessionModel).not.toBeNull()

    // Age the Tier 2 mtime past the debounce so only the watermark gates.
    const modelPath = path.join(
      tempDir, '.claude', 'tom', 'session-models', 'watermark-test.json'
    )
    const aged = new Date(Date.now() - 5 * 60_000)
    fs.utimesSync(modelPath, aged, aged)

    mockAnalyzeWithLlm.mockClear()
    const second = await analyzeCompletedSession('watermark-test')
    expect(second.success).toBe(true)
    expect(second.sessionModel).toBeNull()
    expect(mockAnalyzeWithLlm).not.toHaveBeenCalled()
    expect(
      readUsageEntries().some(
        (e) => e['operation'] === 'analysis-skipped-no-new-evidence'
      )
    ).toBe(true)

    // A new user message re-opens the gate.
    const sessionPath = path.join(
      tempDir, '.claude', 'tom', 'sessions', 'watermark-test.json'
    )
    const log = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'))
    fs.writeFileSync(
      sessionPath,
      JSON.stringify({ ...log, userMessages: ['use vitest not jest'] }),
      'utf-8'
    )
    mockAnalyzeWithLlm.mockResolvedValue({
      ok: true,
      model: {
        sessionId: 'watermark-test',
        intent: 'fresh analysis',
        interactionPatterns: [],
        codingPreferences: [],
      },
      tokensUsed: 10,
      path: 'llm',
    })
    const third = await analyzeCompletedSession('watermark-test')
    expect(third.sessionModel).not.toBeNull()
    expect(mockAnalyzeWithLlm).toHaveBeenCalledTimes(1)
    // The watermark advanced with the successful analysis.
    const persisted = JSON.parse(fs.readFileSync(modelPath, 'utf-8'))
    expect(persisted.analyzedUserMessageCount).toBe(1)
  })

  it('does not advance the watermark on a preserved-prior failure, so retry stays open', async () => {
    writeSessionFile('watermark-retry-test')
    // Prior model analyzed at watermark 0, aged past the debounce.
    const modelDir = path.join(tempDir, '.claude', 'tom', 'session-models')
    fs.mkdirSync(modelDir, { recursive: true })
    const modelPath = path.join(modelDir, 'watermark-retry-test.json')
    fs.writeFileSync(
      modelPath,
      JSON.stringify({
        sessionId: 'watermark-retry-test',
        intent: 'prior',
        interactionPatterns: [],
        codingPreferences: [],
        endedAt: new Date(Date.now() - 60_000).toISOString(),
        analyzedUserMessageCount: 0,
      }),
      'utf-8'
    )
    const aged = new Date(Date.now() - 5 * 60_000)
    fs.utimesSync(modelPath, aged, aged)
    // New evidence arrives, but the LLM times out this turn.
    const sessionPath = path.join(
      tempDir, '.claude', 'tom', 'sessions', 'watermark-retry-test.json'
    )
    const log = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'))
    fs.writeFileSync(
      sessionPath,
      JSON.stringify({ ...log, userMessages: ['new evidence'] }),
      'utf-8'
    )
    mockAnalyzeWithLlm.mockResolvedValue({
      ok: false,
      reason: 'timeout',
      detail: 'claude did not respond within 90000ms',
    })

    await analyzeCompletedSession('watermark-retry-test')

    // Preserved prior keeps its watermark at 0: the next turn (same message
    // count) still passes the gate and retries the analysis.
    const persisted = JSON.parse(fs.readFileSync(modelPath, 'utf-8'))
    expect(persisted.analyzedUserMessageCount).toBe(0)
  })

  it('skips analysis when a fresh in-flight lock is held by a concurrent Stop', async () => {
    writeSessionFile('lock-test')
    const modelDir = path.join(tempDir, '.claude', 'tom', 'session-models')
    fs.mkdirSync(modelDir, { recursive: true })
    const lockPath = path.join(modelDir, 'lock-test.lock')
    fs.writeFileSync(lockPath, '12345 2026-07-05T00:00:00.000Z', 'utf-8')

    mockAnalyzeWithLlm.mockClear()
    const result = await analyzeCompletedSession('lock-test')

    expect(result.success).toBe(true)
    expect(result.sessionModel).toBeNull()
    expect(mockAnalyzeWithLlm).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(modelDir, 'lock-test.json'))).toBe(false)
    expect(
      readUsageEntries().some((e) => e['operation'] === 'analysis-in-flight')
    ).toBe(true)
    // The lock belongs to the concurrent holder — not released by the skipper.
    expect(fs.existsSync(lockPath)).toBe(true)
  })

  it('releases the in-flight lock after publishing the Tier 2 model', async () => {
    writeSessionFile('lock-release-test')

    await analyzeCompletedSession('lock-release-test')

    const modelDir = path.join(tempDir, '.claude', 'tom', 'session-models')
    expect(fs.existsSync(path.join(modelDir, 'lock-release-test.json'))).toBe(true)
    expect(fs.existsSync(path.join(modelDir, 'lock-release-test.lock'))).toBe(false)
  })

  it('does not promote preferences below the promotion thresholds', async () => {
    // 4 sessions → confidence 0.4, below both the 0.8 and 5-session bars.
    seedTier2(4, { category: 'interactionStyle', key: 'verbosity', value: 'concise' })
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
    seedTier2(9, { category: 'interactionStyle', key: 'verbosity', value: 'concise' })
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
    // Actionable clusters only come from the LLM path; the heuristic fallback
    // emits none.
    mockAnalyzeWithLlm.mockResolvedValue({
      ok: true,
      model: {
        sessionId: 'aggregate-test',
        intent: 'edit',
        interactionPatterns: [],
        codingPreferences: [{ key: 'language', value: 'typescript' }],
        corrections: [],
      },
      tokensUsed: 100,
      path: 'llm',
    })

    await analyzeCompletedSession('aggregate-test')

    const userModelPath = path.join(tomDir, 'user-model.json')
    const updatedModel = JSON.parse(fs.readFileSync(userModelPath, 'utf-8'))
    // Should still have preferences (merged from existing + new session)
    expect(updatedModel.preferencesClusters.length).toBeGreaterThan(0)
    // Summaries are now derived deterministically from the resolved clusters
    // (not carried over verbatim). No interactionStyle cluster exists, so
    // that summary is empty; both summaries are always strings.
    expect(typeof updatedModel.interactionStyleSummary).toBe('string')
    expect(typeof updatedModel.codingStyleSummary).toBe('string')
    expect(updatedModel.interactionStyleSummary).toBe('')
    // Every entry in a derived summary must come from a resolved
    // codingPreferences cluster — never the stale carried-over text.
    expect(updatedModel.codingStyleSummary).not.toContain('focused')
    for (const cluster of updatedModel.preferencesClusters) {
      if (
        cluster.category === 'codingPreferences' &&
        cluster.confidence >= 0.2
      ) {
        expect(updatedModel.codingStyleSummary).toContain(
          `${cluster.key}: ${cluster.value}`
        )
      }
    }
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
