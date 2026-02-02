import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { ensureGitignoreEntry, formatResult } from './gitignore'

describe('ensureGitignoreEntry', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'tom-gitignore-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('returns no_gitignore when .gitignore does not exist', () => {
    const result = ensureGitignoreEntry(tempDir)
    expect(result.action).toBe('no_gitignore')
    expect(result.gitignorePath).toBe(path.join(tempDir, '.gitignore'))
  })

  it('does not create .gitignore when it does not exist', () => {
    ensureGitignoreEntry(tempDir)
    expect(fs.existsSync(path.join(tempDir, '.gitignore'))).toBe(false)
  })

  it('adds entry to empty .gitignore', () => {
    fs.writeFileSync(path.join(tempDir, '.gitignore'), '')
    const result = ensureGitignoreEntry(tempDir)
    expect(result.action).toBe('added')
    const content = fs.readFileSync(path.join(tempDir, '.gitignore'), 'utf-8')
    expect(content).toContain('.claude/tom/')
  })

  it('adds entry to .gitignore with existing entries', () => {
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'node_modules/\ndist/\n')
    const result = ensureGitignoreEntry(tempDir)
    expect(result.action).toBe('added')
    const content = fs.readFileSync(path.join(tempDir, '.gitignore'), 'utf-8')
    expect(content).toBe('node_modules/\ndist/\n.claude/tom/\n')
  })

  it('adds newline before entry when file does not end with newline', () => {
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'node_modules/')
    const result = ensureGitignoreEntry(tempDir)
    expect(result.action).toBe('added')
    const content = fs.readFileSync(path.join(tempDir, '.gitignore'), 'utf-8')
    expect(content).toBe('node_modules/\n.claude/tom/\n')
  })

  it('returns already_present when entry exists', () => {
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'node_modules/\n.claude/tom/\n')
    const result = ensureGitignoreEntry(tempDir)
    expect(result.action).toBe('already_present')
  })

  it('does not modify file when entry already present', () => {
    const original = 'node_modules/\n.claude/tom/\ndist/\n'
    fs.writeFileSync(path.join(tempDir, '.gitignore'), original)
    ensureGitignoreEntry(tempDir)
    const content = fs.readFileSync(path.join(tempDir, '.gitignore'), 'utf-8')
    expect(content).toBe(original)
  })

  it('detects entry with surrounding whitespace', () => {
    fs.writeFileSync(path.join(tempDir, '.gitignore'), '  .claude/tom/  \n')
    const result = ensureGitignoreEntry(tempDir)
    expect(result.action).toBe('already_present')
  })

  it('does not treat partial matches as present', () => {
    fs.writeFileSync(path.join(tempDir, '.gitignore'), '.claude/tom/extra\n.claude/\n')
    const result = ensureGitignoreEntry(tempDir)
    expect(result.action).toBe('added')
  })

  it('is append-only — preserves all existing entries', () => {
    const original = '# comment\nnode_modules/\n*.log\n'
    fs.writeFileSync(path.join(tempDir, '.gitignore'), original)
    ensureGitignoreEntry(tempDir)
    const content = fs.readFileSync(path.join(tempDir, '.gitignore'), 'utf-8')
    expect(content.startsWith(original)).toBe(true)
  })
})

describe('formatResult', () => {
  it('formats added result', () => {
    const msg = formatResult({ action: 'added', gitignorePath: '/foo/.gitignore' })
    expect(msg).toContain('Added')
    expect(msg).toContain('.claude/tom/')
  })

  it('formats already_present result', () => {
    const msg = formatResult({ action: 'already_present', gitignorePath: '/foo/.gitignore' })
    expect(msg).toContain('already present')
  })

  it('formats no_gitignore result', () => {
    const msg = formatResult({ action: 'no_gitignore', gitignorePath: '/foo/.gitignore' })
    expect(msg).toContain('No .gitignore')
  })
})

describe('main entry point', () => {
  let originalCwd: () => string
  let originalStdout: typeof process.stdout.write
  let tempDir: string
  let output: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'tom-gitignore-main-'))
    originalCwd = process.cwd
    originalStdout = process.stdout.write
    output = ''
    process.cwd = () => tempDir
    process.stdout.write = ((chunk: string) => {
      output += chunk
      return true
    }) as typeof process.stdout.write
  })

  afterEach(() => {
    process.cwd = originalCwd
    process.stdout.write = originalStdout
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('outputs no_gitignore message when no .gitignore', () => {
    const result = ensureGitignoreEntry(tempDir)
    process.stdout.write(formatResult(result) + '\n')
    expect(output).toContain('No .gitignore')
  })

  it('outputs added message when .gitignore exists', () => {
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'node_modules/\n')
    const result = ensureGitignoreEntry(tempDir)
    process.stdout.write(formatResult(result) + '\n')
    expect(output).toContain('Added')
  })
})
