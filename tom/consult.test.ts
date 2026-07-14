import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { consultToM } from './consult'

// --- Test Helpers ---

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tom-consult-test-'))
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

  // Positive idf so terms actually score (plain log((N-df+0.5)/(df+0.5))
  // would be 0 for df=1, N=2 and the bm25 path would never win).
  const idfVal = Math.log(1 + (2 - 1 + 0.5) / (1 + 0.5))

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
    // Specific, detailed prompt with a file path — low ambiguity
    const result = consultToM(
      'Read the file at /src/app.ts and tell me what the main function does',
      'high',
      's1'
    )
    expect(result.consulted).toBe(false)
    expect(result.suggestion).toBeNull()
    expect(result.source).toBeNull()
  })

  it('returns consulted when ambiguity exceeds threshold with no user model', () => {
    // Vague prompt + no user model → high ambiguity
    const result = consultToM('fix it', 'low', 's1')
    expect(result.consulted).toBe(true)
    expect(result.ambiguityResult.isAmbiguous).toBe(true)
  })

  it('generates suggestion from BM25 search when the user model has nothing surfaceable', () => {
    writeBm25Index(tempDir)
    // The only stored pref is a legacy generic key, which the user-model
    // builder filters out, so consultation falls back to BM25 provenance.
    writeUserModel(tempDir, [{
      category: 'codingPreferences',
      key: 'preference',
      value: 'typescript',
      confidence: 0.8,
      lastUpdated: '2026-02-02T10:00:00.000Z',
      sessionCount: 5,
    }])

    const result = consultToM('fix the typescript style', 'low', 's1')

    expect(result.consulted).toBe(true)
    expect(result.suggestion).not.toBeNull()
    expect(result.source).toBe('bm25')
    expect(result.suggestion?.type).toBeDefined()
    expect(result.suggestion?.content).toContain('Based on past interactions')
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

    const result = consultToM('make it better', 'low', 's1')

    expect(result.consulted).toBe(true)
    expect(result.suggestion).not.toBeNull()
    expect(result.source).toBe('user-model')
    expect(result.suggestion?.type).toBe('preference')
    expect(result.suggestion?.content).toContain('language=typescript')
  })

  it('builds the user-model suggestion from all confident (non-legacy) preferences', () => {
    // Promotion is retired: every confident keyed preference is eligible to
    // surface (SessionStart injection is the only surfacing path now, so there
    // is no marker block to double-inject against).
    writeUserModel(tempDir, [
      {
        category: 'codingPreferences',
        key: 'language',
        value: 'typescript',
        confidence: 0.95,
        lastUpdated: '2026-02-02T10:00:00.000Z',
        sessionCount: 12,
      },
      {
        category: 'codingPreferences',
        key: 'framework',
        value: 'react',
        confidence: 0.6,
        lastUpdated: '2026-02-02T10:00:00.000Z',
        sessionCount: 3,
      },
    ])

    const result = consultToM('make it better', 'low', 's1')

    expect(result.source).toBe('user-model')
    expect(result.suggestion?.content).toContain('language=typescript')
    expect(result.suggestion?.content).toContain('framework=react')
  })

  it('never surfaces legacy generic keys (preference/pattern) in the suggestion', () => {
    // Legacy keys are unpromoted and high-confidence, so without the guard they
    // would dominate the top-5 and leak into the agent-facing suggestion
    // (tom-swe-591). A real keyed pref must still come through.
    writeUserModel(tempDir, [
      {
        category: 'codingPreferences',
        key: 'preference',
        value: '/home/ds/some/file.ts',
        confidence: 1.0,
        lastUpdated: '2026-02-02T10:00:00.000Z',
        sessionCount: 675,
      },
      {
        category: 'interactionStyle',
        key: 'pattern',
        value: 'uses-Write',
        confidence: 1.0,
        lastUpdated: '2026-02-02T10:00:00.000Z',
        sessionCount: 58,
      },
      {
        category: 'codingPreferences',
        key: 'framework',
        value: 'react',
        confidence: 0.6,
        lastUpdated: '2026-02-02T10:00:00.000Z',
        sessionCount: 3,
      },
    ])

    const result = consultToM('make it better', 'low', 's1')

    expect(result.suggestion?.content ?? '').not.toContain('uses-Write')
    expect(result.suggestion?.content ?? '').not.toContain('/home/ds/some/file.ts')
    expect(result.suggestion?.content ?? '').toContain('framework=react')
  })

  it('skips the user-model suggestion when only legacy generic keys remain', () => {
    writeUserModel(tempDir, [
      {
        category: 'codingPreferences',
        key: 'preference',
        value: '/home/ds/some/file.ts',
        confidence: 1.0,
        lastUpdated: '2026-02-02T10:00:00.000Z',
        sessionCount: 675,
      },
    ])

    const result = consultToM('make it better', 'low', 's1')

    expect(result.suggestion).toBeNull()
    expect(result.source).toBeNull()
  })

  it('returns null suggestion when no memory exists', () => {
    const result = consultToM('fix it', 'low', 's1')

    expect(result.consulted).toBe(true)
    expect(result.suggestion).toBeNull()
    expect(result.source).toBeNull()
  })

  it('logs consultation with a structured reason to usage.log', () => {
    writeUserModel(tempDir, [{
      category: 'codingPreferences',
      key: 'framework',
      value: 'react',
      confidence: 0.8,
      lastUpdated: '2026-02-02T10:00:00.000Z',
      sessionCount: 3,
    }])

    const result = consultToM('improve the style', 'low', 'log-session')

    expect(result.consulted).toBe(true)
    const logPath = path.join(tempDir, '.claude', 'tom', 'usage.log')
    expect(fs.existsSync(logPath)).toBe(true)
    const content = fs.readFileSync(logPath, 'utf-8').trim()
    const entry = JSON.parse(content)
    expect(entry.operation).toBe('ambiguity-consultation')
    expect(entry.model).toBe('none')
    expect(entry.sessionId).toBe('log-session')
    expect(entry.v).toBe(1)
    expect(typeof entry.durationMs).toBe('number')

    const detail = entry.detail
    expect(detail.score).toBe(result.ambiguityResult.score)
    expect(detail.threshold).toBe('low')
    expect(detail.source).toBe('user-model')
    expect(detail.triggers).toContain('preference-sensitive')
    expect(detail.suggestionType).toBe('preference')
    expect(detail.suggestionKeys).toContain('codingPreferences:framework')
    expect(detail.suggestionChars).toBeGreaterThan(0)
  })

  it('logs source none when consulted but no memory exists', () => {
    const result = consultToM('fix it', 'low', 's1')
    expect(result.consulted).toBe(true)

    const logPath = path.join(tempDir, '.claude', 'tom', 'usage.log')
    const entry = JSON.parse(fs.readFileSync(logPath, 'utf-8').trim())
    expect(entry.detail.source).toBe('none')
    expect(entry.detail.suggestionType).toBeNull()
    expect(entry.detail.suggestionKeys).toEqual([])
  })

  it('does not log when ambiguity is below threshold', () => {
    consultToM(
      'Read the file at /src/app.ts and tell me what the main function does',
      'high',
      's1'
    )
    const logPath = path.join(tempDir, '.claude', 'tom', 'usage.log')
    expect(fs.existsSync(logPath)).toBe(false)
  })

  it('uses the provided threshold', () => {
    // A user model exists, so the no-model bonus doesn't apply: a short
    // vague prompt alone (0.55) must not cross the high (0.7) threshold.
    writeUserModel(tempDir, [{
      category: 'codingPreferences',
      key: 'language',
      value: 'typescript',
      confidence: 0.8,
      lastUpdated: '2026-02-02T10:00:00.000Z',
      sessionCount: 5,
    }])
    const result = consultToM('check it', 'high', 's1')
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

    const result = consultToM('refactor the approach', 'low', 's1')

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

    const result = consultToM('make it nice', 'low', 's1')

    if (result.suggestion) {
      expect(['preference', 'disambiguation', 'style']).toContain(result.suggestion.type)
      expect(typeof result.suggestion.content).toBe('string')
      expect(result.suggestion.confidence).toBeGreaterThanOrEqual(0)
      expect(result.suggestion.confidence).toBeLessThanOrEqual(1)
      expect(Array.isArray(result.suggestion.sourceSessions)).toBe(true)
    }
  })
})
