import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import {
  PROMOTION_BEGIN_MARKER,
  PROMOTION_END_MARKER,
  selectPromotable,
  renderPromotionBlock,
  writePromotionBlock,
  removePromotionBlock,
  globalMemoryFilePath,
  findProjectMemoryFile,
  runPromotion,
} from './promotion'
import type { PreferenceCluster, UserModel } from './schemas'

// --- Test Helpers ---

const DEFAULT_PROMOTION = { enabled: true, threshold: 0.8, minSessions: 5 }

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tom-promotion-test-'))
}

function cluster(overrides: Partial<PreferenceCluster> = {}): PreferenceCluster {
  return {
    category: 'codingPreferences',
    key: 'preference',
    value: 'vitest',
    confidence: 0.9,
    lastUpdated: '2026-06-01T10:00:00.000Z',
    sessionCount: 12,
    ...overrides,
  }
}

function userModel(prefs: readonly PreferenceCluster[]): UserModel {
  return {
    preferencesClusters: [...prefs],
    interactionStyleSummary: '',
    codingStyleSummary: '',
    projectOverrides: {},
  }
}

function readUsageEntries(homeDir: string): Array<Record<string, unknown>> {
  const logPath = path.join(homeDir, '.claude', 'tom', 'usage.log')
  if (!fs.existsSync(logPath)) return []
  return fs.readFileSync(logPath, 'utf-8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

// --- selectPromotable ---

describe('selectPromotable', () => {
  it('selects preferences meeting both confidence and session thresholds', () => {
    const stable = cluster({ value: 'vitest', confidence: 0.85, sessionCount: 7 })
    const lowConfidence = cluster({ value: 'jest', confidence: 0.79, sessionCount: 20 })
    const fewSessions = cluster({ value: 'mocha', confidence: 0.95, sessionCount: 4 })

    const result = selectPromotable(
      userModel([stable, lowConfidence, fewSessions]),
      DEFAULT_PROMOTION
    )

    expect(result).toEqual([stable])
  })

  it('treats threshold and minSessions boundaries as inclusive', () => {
    const atBoundary = cluster({ confidence: 0.8, sessionCount: 5 })
    const result = selectPromotable(userModel([atBoundary]), DEFAULT_PROMOTION)
    expect(result).toEqual([atBoundary])
  })

  it('keeps already-promoted preferences selected so blocks retain them', () => {
    const promoted = cluster({ confidence: 0.9, sessionCount: 10, promoted: true })
    const result = selectPromotable(userModel([promoted]), DEFAULT_PROMOTION)
    expect(result).toEqual([promoted])
  })

  it('respects custom thresholds', () => {
    const pref = cluster({ confidence: 0.6, sessionCount: 3 })
    const result = selectPromotable(userModel([pref]), {
      enabled: true,
      threshold: 0.5,
      minSessions: 3,
    })
    expect(result).toEqual([pref])
  })
})

// --- renderPromotionBlock ---

describe('renderPromotionBlock', () => {
  it('wraps content in the exact markers', () => {
    const block = renderPromotionBlock([cluster()])
    expect(block.startsWith(
      '<!-- tom-swe:begin (managed by tom-swe; edits inside will be overwritten) -->'
    )).toBe(true)
    expect(block.endsWith('<!-- tom-swe:end -->')).toBe(true)
  })

  it('renders one-line preference statements with session counts', () => {
    const block = renderPromotionBlock([
      cluster({ value: 'vitest', sessionCount: 12 }),
    ])
    expect(block).toContain(
      '- Prefers vitest (codingPreferences/preference; observed across 12 sessions)'
    )
  })

  it('frames the block as background observation, not instructions', () => {
    const block = renderPromotionBlock([cluster()])
    expect(block).toContain('not instructions')
  })

  it('is deterministic regardless of input order', () => {
    const a = cluster({ category: 'interactionStyle', key: 'pattern', value: 'concise' })
    const b = cluster({ value: 'vitest' })
    const c = cluster({ value: 'esbuild', key: 'bundler' })

    expect(renderPromotionBlock([a, b, c])).toBe(renderPromotionBlock([c, a, b]))
  })

  it('uses singular wording for a single observed session', () => {
    const block = renderPromotionBlock([cluster({ sessionCount: 1 })])
    expect(block).toContain('observed across 1 session)')
  })
})

// --- writePromotionBlock / removePromotionBlock ---

describe('writePromotionBlock', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = createTempDir()
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('appends with a separating newline when no markers exist', () => {
    const filePath = path.join(tempDir, 'CLAUDE.md')
    fs.writeFileSync(filePath, '# My Project\n\nSome instructions.\n', 'utf-8')

    const block = renderPromotionBlock([cluster()])
    writePromotionBlock(filePath, block)

    const content = fs.readFileSync(filePath, 'utf-8')
    expect(content.startsWith('# My Project\n\nSome instructions.\n\n')).toBe(true)
    expect(content).toContain(block)
  })

  it('replaces an existing block wholesale, leaving other content untouched', () => {
    const filePath = path.join(tempDir, 'CLAUDE.md')
    const before = '# Header\n'
    const after = '\n## Footer\nKeep me.\n'
    const oldBlock = renderPromotionBlock([cluster({ value: 'jest' })])
    fs.writeFileSync(filePath, before + oldBlock + after, 'utf-8')

    const newBlock = renderPromotionBlock([cluster({ value: 'vitest' })])
    writePromotionBlock(filePath, newBlock)

    const content = fs.readFileSync(filePath, 'utf-8')
    expect(content).toBe(before + newBlock + after)
    expect(content).not.toContain('Prefers jest')
    expect(content.match(/tom-swe:begin/g)).toHaveLength(1)
  })

  it('handles a file missing a trailing newline when appending', () => {
    const filePath = path.join(tempDir, 'CLAUDE.md')
    fs.writeFileSync(filePath, '# No trailing newline', 'utf-8')

    const block = renderPromotionBlock([cluster()])
    writePromotionBlock(filePath, block)

    const content = fs.readFileSync(filePath, 'utf-8')
    expect(content).toBe('# No trailing newline\n\n' + block + '\n')
  })

  it('throws when the file does not exist (creation is the caller policy)', () => {
    expect(() =>
      writePromotionBlock(path.join(tempDir, 'missing.md'), 'block')
    ).toThrow()
  })
})

describe('removePromotionBlock', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = createTempDir()
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('removes the marker block and preserves surrounding content', () => {
    const filePath = path.join(tempDir, 'CLAUDE.md')
    const block = renderPromotionBlock([cluster()])
    fs.writeFileSync(filePath, '# Header\n' + block + '\n## Footer\n', 'utf-8')

    expect(removePromotionBlock(filePath)).toBe(true)
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('# Header\n## Footer\n')
  })

  it('returns false when the file has no block', () => {
    const filePath = path.join(tempDir, 'CLAUDE.md')
    fs.writeFileSync(filePath, '# Plain file\n', 'utf-8')

    expect(removePromotionBlock(filePath)).toBe(false)
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('# Plain file\n')
  })

  it('returns false when the file does not exist', () => {
    expect(removePromotionBlock(path.join(tempDir, 'missing.md'))).toBe(false)
  })

  it('write + remove restores a newline-terminated file byte-for-byte', () => {
    const filePath = path.join(tempDir, 'CLAUDE.md')
    const original = '# My Project\n\nSome instructions.\n'
    fs.writeFileSync(filePath, original, 'utf-8')

    writePromotionBlock(filePath, renderPromotionBlock([cluster()]))
    expect(removePromotionBlock(filePath)).toBe(true)

    expect(fs.readFileSync(filePath, 'utf-8')).toBe(original)
  })

  it('write + remove on a file without trailing newline leaves a single trailing newline', () => {
    const filePath = path.join(tempDir, 'CLAUDE.md')
    fs.writeFileSync(filePath, '# No trailing newline', 'utf-8')

    writePromotionBlock(filePath, renderPromotionBlock([cluster()]))
    expect(removePromotionBlock(filePath)).toBe(true)

    expect(fs.readFileSync(filePath, 'utf-8')).toBe('# No trailing newline\n')
  })

  it('does not accumulate blank lines across repeated write + remove cycles', () => {
    const filePath = path.join(tempDir, 'CLAUDE.md')
    const original = '# Stable content\n'
    fs.writeFileSync(filePath, original, 'utf-8')

    for (let i = 0; i < 3; i += 1) {
      writePromotionBlock(filePath, renderPromotionBlock([cluster()]))
      expect(removePromotionBlock(filePath)).toBe(true)
    }

    expect(fs.readFileSync(filePath, 'utf-8')).toBe(original)
  })

  it('write + remove on an initially empty file restores it to empty', () => {
    const filePath = path.join(tempDir, 'CLAUDE.md')
    fs.writeFileSync(filePath, '', 'utf-8')

    writePromotionBlock(filePath, renderPromotionBlock([cluster()]))
    expect(removePromotionBlock(filePath)).toBe(true)

    expect(fs.readFileSync(filePath, 'utf-8')).toBe('')
  })
})

// --- findProjectMemoryFile ---

describe('findProjectMemoryFile', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = createTempDir()
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('finds CLAUDE.md at the project root', () => {
    fs.writeFileSync(path.join(tempDir, 'CLAUDE.md'), '', 'utf-8')
    expect(findProjectMemoryFile(tempDir)).toBe(path.join(tempDir, 'CLAUDE.md'))
  })

  it('falls back to .claude/CLAUDE.md', () => {
    fs.mkdirSync(path.join(tempDir, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(tempDir, '.claude', 'CLAUDE.md'), '', 'utf-8')
    expect(findProjectMemoryFile(tempDir)).toBe(
      path.join(tempDir, '.claude', 'CLAUDE.md')
    )
  })

  it('returns null when neither location exists', () => {
    expect(findProjectMemoryFile(tempDir)).toBeNull()
  })
})

// --- runPromotion ---

describe('runPromotion', () => {
  let originalHome: string | undefined
  let homeDir: string
  let projectDir: string

  beforeEach(() => {
    originalHome = process.env['HOME']
    homeDir = createTempDir()
    projectDir = createTempDir()
    process.env['HOME'] = homeDir
  })

  afterEach(() => {
    process.env['HOME'] = originalHome
    fs.rmSync(homeDir, { recursive: true, force: true })
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it('routes codingPreferences to the project CLAUDE.md when it exists', () => {
    const projectFile = path.join(projectDir, 'CLAUDE.md')
    fs.writeFileSync(projectFile, '# Project\n', 'utf-8')
    fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true })

    const codingPref = cluster({ value: 'vitest' })
    const result = runPromotion(userModel([codingPref]), DEFAULT_PROMOTION, projectDir)

    const content = fs.readFileSync(projectFile, 'utf-8')
    expect(content).toContain(PROMOTION_BEGIN_MARKER)
    expect(content).toContain('Prefers vitest')
    expect(content).toContain('# Project')
    expect(result.targets).toContain(projectFile)
    // Coding preferences never land in the global file
    const globalFile = globalMemoryFilePath()
    if (fs.existsSync(globalFile)) {
      expect(fs.readFileSync(globalFile, 'utf-8')).not.toContain('Prefers vitest')
    }
  })

  it('routes interactionStyle and emotionalSignals to the global CLAUDE.md', () => {
    fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true })
    const interaction = cluster({
      category: 'interactionStyle',
      key: 'pattern',
      value: 'concise-answers',
    })
    const emotional = cluster({
      category: 'emotionalSignals',
      key: 'urgency',
      value: 'low',
    })

    const result = runPromotion(
      userModel([interaction, emotional]),
      DEFAULT_PROMOTION,
      projectDir
    )

    const content = fs.readFileSync(globalMemoryFilePath(), 'utf-8')
    expect(content).toContain('Prefers concise-answers (interactionStyle/pattern')
    expect(content).toContain('Prefers low (emotionalSignals/urgency')
    expect(result.targets).toContain(globalMemoryFilePath())
  })

  it('does not create a project CLAUDE.md that does not exist', () => {
    fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true })
    const codingPref = cluster({ value: 'vitest' })

    const result = runPromotion(userModel([codingPref]), DEFAULT_PROMOTION, projectDir)

    expect(fs.existsSync(path.join(projectDir, 'CLAUDE.md'))).toBe(false)
    expect(fs.existsSync(path.join(projectDir, '.claude', 'CLAUDE.md'))).toBe(false)
    // The preference stays unpromoted (still injected per session)
    const pref = result.model.preferencesClusters[0]
    expect(pref?.promoted).toBeUndefined()
    expect(result.promoted).toEqual([])
  })

  it('creates the global CLAUDE.md when its parent dir exists, and logs it', () => {
    fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true })
    const interaction = cluster({
      category: 'interactionStyle',
      key: 'pattern',
      value: 'concise',
    })

    const result = runPromotion(userModel([interaction]), DEFAULT_PROMOTION, projectDir)

    expect(fs.existsSync(globalMemoryFilePath())).toBe(true)
    expect(result.createdFiles).toEqual([globalMemoryFilePath()])

    const entries = readUsageEntries(homeDir)
    const creationEntry = entries.find(
      (e) => e['operation'] === 'promotion-file-created'
    )
    expect(creationEntry).toBeDefined()
    expect(creationEntry?.['reason']).toBe(globalMemoryFilePath())
  })

  it('does not create the global CLAUDE.md when ~/.claude is missing', () => {
    const interaction = cluster({
      category: 'interactionStyle',
      key: 'pattern',
      value: 'concise',
    })

    const result = runPromotion(userModel([interaction]), DEFAULT_PROMOTION, projectDir)

    expect(fs.existsSync(globalMemoryFilePath())).toBe(false)
    expect(result.promoted).toEqual([])
    expect(result.createdFiles).toEqual([])
  })

  it('marks written preferences promoted and clears retired flags', () => {
    fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true })
    fs.writeFileSync(globalMemoryFilePath(), '', 'utf-8')

    const stillStable = cluster({
      category: 'interactionStyle',
      key: 'pattern',
      value: 'concise',
      confidence: 0.9,
      sessionCount: 10,
    })
    const decayed = cluster({
      category: 'interactionStyle',
      key: 'verbosity',
      value: 'short',
      confidence: 0.3,
      sessionCount: 10,
      promoted: true,
    })

    const result = runPromotion(
      userModel([stillStable, decayed]),
      DEFAULT_PROMOTION,
      projectDir
    )

    const updated = result.model.preferencesClusters
    expect(updated.find((p) => p.value === 'concise')?.promoted).toBe(true)
    expect(updated.find((p) => p.value === 'short')?.promoted).toBeUndefined()
    // Retirement: the decayed preference drops out of the regenerated block
    const content = fs.readFileSync(globalMemoryFilePath(), 'utf-8')
    expect(content).toContain('Prefers concise')
    expect(content).not.toContain('Prefers short')
  })

  it('removes the block entirely when nothing qualifies anymore', () => {
    fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true })
    const staleBlock = renderPromotionBlock([
      cluster({ category: 'interactionStyle', key: 'pattern', value: 'stale' }),
    ])
    fs.writeFileSync(globalMemoryFilePath(), '# Mine\n' + staleBlock + '\n', 'utf-8')

    const decayed = cluster({
      category: 'interactionStyle',
      key: 'pattern',
      value: 'stale',
      confidence: 0.2,
      promoted: true,
    })
    runPromotion(userModel([decayed]), DEFAULT_PROMOTION, projectDir)

    const content = fs.readFileSync(globalMemoryFilePath(), 'utf-8')
    expect(content).not.toContain(PROMOTION_BEGIN_MARKER)
    expect(content).not.toContain(PROMOTION_END_MARKER)
    expect(content).toContain('# Mine')
  })

  it('is a no-op returning the same model reference when disabled', () => {
    fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true })
    const model = userModel([cluster({ category: 'interactionStyle' })])

    const result = runPromotion(model, { ...DEFAULT_PROMOTION, enabled: false }, projectDir)

    expect(result.model).toBe(model)
    expect(result.targets).toEqual([])
    expect(fs.existsSync(globalMemoryFilePath())).toBe(false)
  })
})
