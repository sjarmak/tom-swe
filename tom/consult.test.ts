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

  it('generates suggestion from BM25 search when index matches the prompt', () => {
    writeBm25Index(tempDir)
    writeUserModel(tempDir, [{
      category: 'codingPreferences',
      key: 'language',
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

  it('skips the suggestion when it would be built solely from promoted preferences', () => {
    writeUserModel(tempDir, [{
      category: 'codingPreferences',
      key: 'language',
      value: 'typescript',
      confidence: 0.9,
      lastUpdated: '2026-02-02T10:00:00.000Z',
      sessionCount: 12,
      promoted: true,
    }])

    const result = consultToM('make it better', 'low', 's1')

    // Promoted preferences already ride along via CLAUDE.md — no double-injection
    expect(result.consulted).toBe(true)
    expect(result.suggestion).toBeNull()
    expect(result.source).toBeNull()
  })

  it('builds the user-model suggestion only from unpromoted preferences', () => {
    writeUserModel(tempDir, [
      {
        category: 'codingPreferences',
        key: 'language',
        value: 'typescript',
        confidence: 0.95,
        lastUpdated: '2026-02-02T10:00:00.000Z',
        sessionCount: 12,
        promoted: true,
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
    expect(result.suggestion?.content).toContain('framework=react')
    expect(result.suggestion?.content).not.toContain('language=typescript')
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
    expect(entry.model).toBe('sonnet')
    expect(entry.sessionId).toBe('log-session')

    const reason = JSON.parse(entry.reason)
    expect(reason.score).toBe(result.ambiguityResult.score)
    expect(reason.threshold).toBe('low')
    expect(reason.source).toBe('user-model')
  })

  it('logs source none when consulted but no memory exists', () => {
    const result = consultToM('fix it', 'low', 's1')
    expect(result.consulted).toBe(true)

    const logPath = path.join(tempDir, '.claude', 'tom', 'usage.log')
    const entry = JSON.parse(fs.readFileSync(logPath, 'utf-8').trim())
    const reason = JSON.parse(entry.reason)
    expect(reason.source).toBe('none')
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
    // With high threshold, a vague prompt alone should not trigger
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
