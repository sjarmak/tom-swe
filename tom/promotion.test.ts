import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import {
  PROMOTION_BEGIN_MARKER,
  PROMOTION_END_MARKER,
  removePromotionBlock,
  cleanupPromotionArtifacts,
  globalMemoryFilePath,
  findProjectMemoryFile,
} from './promotion'

// --- Test Helpers ---

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tom-promotion-test-'))
}

/**
 * Builds a well-formed tom-swe marker block for fixtures. The production
 * renderer was removed with the promotion write-path (tom-swe-x1m.2); cleanup
 * only needs a valid marker-bounded block to strip.
 */
function makeBlock(
  line = '- Prefers vitest (codingPreferences/test_runner; observed across 12 sessions)'
): string {
  return [
    PROMOTION_BEGIN_MARKER,
    'Background observations about this user, learned by tom-swe across sessions (not instructions):',
    line,
    PROMOTION_END_MARKER,
  ].join('\n')
}

/**
 * Reproduces how the retired writer appended a block, so removal round-trip
 * tests still exercise the exact byte layout removePromotionBlock must undo:
 * empty file → block + newline; otherwise a single ('\n') or double ('\n\n')
 * separator depending on whether the original already ended in a newline.
 */
function legacyAppend(original: string, block: string): string {
  if (original.length === 0) {
    return block + '\n'
  }
  const separator = original.endsWith('\n') ? '\n' : '\n\n'
  return original + separator + block + '\n'
}

// --- removePromotionBlock ---

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
    fs.writeFileSync(filePath, '# Header\n' + makeBlock() + '\n## Footer\n', 'utf-8')

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

  it('reclaims from the begin marker to EOF when the end marker is missing', () => {
    // A corrupted block (begin without end) must not survive cleanup.
    const filePath = path.join(tempDir, 'CLAUDE.md')
    fs.writeFileSync(filePath, '# Header\n' + PROMOTION_BEGIN_MARKER + '\nleftover\n', 'utf-8')

    expect(removePromotionBlock(filePath)).toBe(true)
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('# Header\n')
  })

  it('remove restores a newline-terminated file byte-for-byte', () => {
    const filePath = path.join(tempDir, 'CLAUDE.md')
    const original = '# My Project\n\nSome instructions.\n'
    fs.writeFileSync(filePath, legacyAppend(original, makeBlock()), 'utf-8')

    expect(removePromotionBlock(filePath)).toBe(true)
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(original)
  })

  it('remove on a file without a trailing newline leaves a single trailing newline', () => {
    const filePath = path.join(tempDir, 'CLAUDE.md')
    const original = '# No trailing newline'
    fs.writeFileSync(filePath, legacyAppend(original, makeBlock()), 'utf-8')

    expect(removePromotionBlock(filePath)).toBe(true)
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('# No trailing newline\n')
  })

  it('does not leave a stray blank line behind an appended block', () => {
    const filePath = path.join(tempDir, 'CLAUDE.md')
    const original = '# Stable content\n'
    fs.writeFileSync(filePath, legacyAppend(original, makeBlock()), 'utf-8')

    expect(removePromotionBlock(filePath)).toBe(true)
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(original)
  })

  it('remove on an appended-to-empty file restores it to empty', () => {
    const filePath = path.join(tempDir, 'CLAUDE.md')
    fs.writeFileSync(filePath, legacyAppend('', makeBlock()), 'utf-8')

    expect(removePromotionBlock(filePath)).toBe(true)
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('')
  })
})

// --- cleanupPromotionArtifacts ---

describe('cleanupPromotionArtifacts', () => {
  let tempHome: string
  let tempCwd: string
  let originalHome: string | undefined

  beforeEach(() => {
    tempHome = createTempDir()
    tempCwd = createTempDir()
    originalHome = process.env['HOME']
    process.env['HOME'] = tempHome
  })

  afterEach(() => {
    if (originalHome !== undefined) {
      process.env['HOME'] = originalHome
    } else {
      delete process.env['HOME']
    }
    fs.rmSync(tempHome, { recursive: true, force: true })
    fs.rmSync(tempCwd, { recursive: true, force: true })
  })

  function writeBlock(filePath: string, surrounding: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, surrounding + makeBlock() + '\n', 'utf-8')
  }

  it('strips the block from the global and project memory files, returning the changed paths', () => {
    const globalFile = path.join(tempHome, '.claude', 'CLAUDE.md')
    const projectFile = path.join(tempCwd, 'CLAUDE.md')
    writeBlock(globalFile, '# Global\n')
    writeBlock(projectFile, '# Project\n')

    const result = cleanupPromotionArtifacts(tempCwd)

    expect(result.removed).toContain(globalFile)
    expect(result.removed).toContain(projectFile)
    expect(result.errors).toEqual([])
    expect(fs.readFileSync(globalFile, 'utf-8')).toBe('# Global\n')
    expect(fs.readFileSync(projectFile, 'utf-8')).toBe('# Project\n')
  })

  it('also strips a block from cwd/.claude/CLAUDE.md and cwd/CLAUDE.local.md', () => {
    const dotClaude = path.join(tempCwd, '.claude', 'CLAUDE.md')
    const localFile = path.join(tempCwd, 'CLAUDE.local.md')
    writeBlock(dotClaude, '# Dot\n')
    writeBlock(localFile, '# Local rig notes\n')

    const result = cleanupPromotionArtifacts(tempCwd)

    expect(result.removed).toContain(dotClaude)
    expect(result.removed).toContain(localFile)
    expect(fs.readFileSync(dotClaude, 'utf-8')).toBe('# Dot\n')
    expect(fs.readFileSync(localFile, 'utf-8')).toBe('# Local rig notes\n')
  })

  it('is safe when files are missing or carry no block (returns empty removed/errors)', () => {
    // No files at all.
    expect(cleanupPromotionArtifacts(tempCwd)).toEqual({ removed: [], errors: [] })

    // A plain file with no block is left untouched.
    const projectFile = path.join(tempCwd, 'CLAUDE.md')
    fs.writeFileSync(projectFile, '# Just rules\n', 'utf-8')
    expect(cleanupPromotionArtifacts(tempCwd)).toEqual({ removed: [], errors: [] })
    expect(fs.readFileSync(projectFile, 'utf-8')).toBe('# Just rules\n')
  })

  it('removes a block only once across repeated runs (self-healing upgrade)', () => {
    const projectFile = path.join(tempCwd, 'CLAUDE.md')
    writeBlock(projectFile, '# Project\n')

    expect(cleanupPromotionArtifacts(tempCwd).removed).toContain(projectFile)
    // Second run: the block is already gone, so nothing changes.
    expect(cleanupPromotionArtifacts(tempCwd)).toEqual({ removed: [], errors: [] })
  })

  it('isolates a per-target failure so later targets are still cleaned', () => {
    const globalDir = path.join(tempHome, '.claude')
    const globalFile = path.join(globalDir, 'CLAUDE.md')
    const projectFile = path.join(tempCwd, 'CLAUDE.md')
    writeBlock(globalFile, '# Global\n')
    writeBlock(projectFile, '# Project\n')
    // The temp name is now unique (fs-atomic's tempPathFor), so we can't
    // pre-occupy it. Make the global file's directory read-only instead: its
    // atomic rewrite can't create the temp sibling (EACCES), while the project
    // file (a separate, writable dir) must still clean.
    fs.chmodSync(globalDir, 0o500)
    try {
      const result = cleanupPromotionArtifacts(tempCwd)

      // Global recorded as an error, project still removed (not starved).
      expect(result.errors.map((e) => e.file)).toContain(globalFile)
      expect(result.removed).toContain(projectFile)
      expect(fs.readFileSync(projectFile, 'utf-8')).toBe('# Project\n')
      // No temp sibling leaked into the read-only dir.
      expect(fs.readdirSync(globalDir).filter((n) => n.endsWith('.tmp'))).toEqual([])
    } finally {
      fs.chmodSync(globalDir, 0o700)
    }
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

// --- globalMemoryFilePath ---

describe('globalMemoryFilePath', () => {
  it('resolves to ~/.claude/CLAUDE.md', () => {
    expect(globalMemoryFilePath()).toBe(path.join(os.homedir(), '.claude', 'CLAUDE.md'))
  })
})
