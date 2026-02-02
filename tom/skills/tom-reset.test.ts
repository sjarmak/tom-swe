import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import {
  performReset,
  formatResetResult,
  formatConfirmationPrompt,
  formatBytes,
  main,
} from './tom-reset'
import type { ResetResult } from './tom-reset'

// --- Test Setup ---

let tempDir: string
let originalHome: string | undefined
let originalCwd: typeof process.cwd

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tom-reset-test-'))
  originalHome = process.env['HOME']
  process.env['HOME'] = tempDir

  originalCwd = process.cwd
  // Use separate project dir to avoid global/project path overlap
  const projectDir = path.join(tempDir, 'project')
  fs.mkdirSync(projectDir, { recursive: true })
  process.cwd = () => projectDir
})

afterEach(() => {
  process.env['HOME'] = originalHome
  process.cwd = originalCwd
  fs.rmSync(tempDir, { recursive: true, force: true })
})

// --- Helpers ---

function createGlobalTomData(): void {
  const tomDir = path.join(tempDir, '.claude', 'tom')

  // Sessions (Tier 1)
  const sessionsDir = path.join(tomDir, 'sessions')
  fs.mkdirSync(sessionsDir, { recursive: true })
  fs.writeFileSync(
    path.join(sessionsDir, 'session-1.json'),
    JSON.stringify({
      sessionId: 'session-1',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T01:00:00.000Z',
      interactions: [],
    }),
    'utf-8'
  )
  fs.writeFileSync(
    path.join(sessionsDir, 'session-2.json'),
    JSON.stringify({
      sessionId: 'session-2',
      startedAt: '2026-01-02T00:00:00.000Z',
      endedAt: '2026-01-02T01:00:00.000Z',
      interactions: [],
    }),
    'utf-8'
  )

  // Session models (Tier 2)
  const modelsDir = path.join(tomDir, 'session-models')
  fs.mkdirSync(modelsDir, { recursive: true })
  fs.writeFileSync(
    path.join(modelsDir, 'session-1.json'),
    JSON.stringify({ sessionId: 'session-1', intent: 'test' }),
    'utf-8'
  )

  // User model (Tier 3)
  fs.writeFileSync(
    path.join(tomDir, 'user-model.json'),
    JSON.stringify({
      preferencesClusters: [],
      interactionStyleSummary: '',
      codingStyleSummary: '',
      projectOverrides: {},
    }),
    'utf-8'
  )

  // Usage log
  fs.writeFileSync(
    path.join(tomDir, 'usage.log'),
    '{"timestamp":"2026-01-01","operation":"test","model":"haiku","tokenCount":100}\n',
    'utf-8'
  )

  // BM25 index
  fs.writeFileSync(
    path.join(tomDir, 'bm25-index.json'),
    JSON.stringify({ documentCount: 0, avgDocLength: 0, docs: [], idf: {} }),
    'utf-8'
  )
}

function createProjectTomData(): void {
  const projectDir = process.cwd()
  const tomDir = path.join(projectDir, '.claude', 'tom')

  const sessionsDir = path.join(tomDir, 'sessions')
  fs.mkdirSync(sessionsDir, { recursive: true })
  fs.writeFileSync(
    path.join(sessionsDir, 'proj-session-1.json'),
    JSON.stringify({
      sessionId: 'proj-session-1',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T01:00:00.000Z',
      interactions: [],
    }),
    'utf-8'
  )

  fs.writeFileSync(
    path.join(tomDir, 'user-model.json'),
    JSON.stringify({
      preferencesClusters: [],
      interactionStyleSummary: '',
      codingStyleSummary: '',
      projectOverrides: {},
    }),
    'utf-8'
  )
}

// --- Tests ---

describe('performReset', () => {
  it('returns zero counts when no ToM data exists', () => {
    const result = performReset()

    expect(result.totalFileCount).toBe(0)
    expect(result.totalBytes).toBe(0)
    expect(result.globalDeleted.fileCount).toBe(0)
    expect(result.projectDeleted.fileCount).toBe(0)
  })

  it('deletes all global ToM data', () => {
    createGlobalTomData()
    const tomDir = path.join(tempDir, '.claude', 'tom')

    expect(fs.existsSync(tomDir)).toBe(true)

    const result = performReset()

    expect(result.globalDeleted.fileCount).toBe(6)
    expect(result.globalDeleted.totalBytes).toBeGreaterThan(0)
    expect(fs.existsSync(tomDir)).toBe(false)
  })

  it('deletes all project ToM data', () => {
    createProjectTomData()
    const projectTomDir = path.join(process.cwd(), '.claude', 'tom')

    expect(fs.existsSync(projectTomDir)).toBe(true)

    const result = performReset()

    expect(result.projectDeleted.fileCount).toBe(2)
    expect(result.projectDeleted.totalBytes).toBeGreaterThan(0)
    expect(fs.existsSync(projectTomDir)).toBe(false)
  })

  it('deletes both global and project data', () => {
    createGlobalTomData()
    createProjectTomData()

    const result = performReset()

    expect(result.totalFileCount).toBe(8)
    expect(result.totalBytes).toBeGreaterThan(0)
    expect(result.globalDeleted.fileCount).toBe(6)
    expect(result.projectDeleted.fileCount).toBe(2)
  })

  it('does not delete settings.json', () => {
    const settingsDir = path.join(tempDir, '.claude')
    fs.mkdirSync(settingsDir, { recursive: true })
    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({ tom: { enabled: true } }),
      'utf-8'
    )
    createGlobalTomData()

    performReset()

    // settings.json should still exist
    expect(fs.existsSync(path.join(settingsDir, 'settings.json'))).toBe(true)
  })

  it('reports correct total bytes', () => {
    createGlobalTomData()

    const result = performReset()

    expect(result.totalBytes).toBe(
      result.globalDeleted.totalBytes + result.projectDeleted.totalBytes
    )
  })

  it('handles overlapping global and project paths gracefully', () => {
    // When HOME and cwd point to same base, global and project paths are same
    process.cwd = () => tempDir
    createGlobalTomData()

    const result = performReset()

    // Project should report 0 since it's the same directory already deleted
    expect(result.projectDeleted.fileCount).toBe(0)
    expect(result.totalFileCount).toBe(result.globalDeleted.fileCount)
  })
})

describe('formatResetResult', () => {
  it('shows no-data message when nothing was deleted', () => {
    const result: ResetResult = {
      globalDeleted: { fileCount: 0, totalBytes: 0 },
      projectDeleted: { fileCount: 0, totalBytes: 0 },
      totalFileCount: 0,
      totalBytes: 0,
    }

    const output = formatResetResult(result)

    expect(output).toContain('# ToM Reset Complete')
    expect(output).toContain('No ToM data found to delete.')
  })

  it('shows global deleted summary', () => {
    const result: ResetResult = {
      globalDeleted: { fileCount: 6, totalBytes: 2048 },
      projectDeleted: { fileCount: 0, totalBytes: 0 },
      totalFileCount: 6,
      totalBytes: 2048,
    }

    const output = formatResetResult(result)

    expect(output).toContain('Total files deleted: 6')
    expect(output).toContain('Total size freed: 2.0 KB')
    expect(output).toContain('Global (~/.claude/tom/): 6 files')
    expect(output).not.toContain('Project (.claude/tom/)')
  })

  it('shows both global and project deleted summary', () => {
    const result: ResetResult = {
      globalDeleted: { fileCount: 6, totalBytes: 2048 },
      projectDeleted: { fileCount: 2, totalBytes: 512 },
      totalFileCount: 8,
      totalBytes: 2560,
    }

    const output = formatResetResult(result)

    expect(output).toContain('Total files deleted: 8')
    expect(output).toContain('Global (~/.claude/tom/): 6 files')
    expect(output).toContain('Project (.claude/tom/): 2 files')
  })

  it('shows config preserved message', () => {
    const result: ResetResult = {
      globalDeleted: { fileCount: 1, totalBytes: 100 },
      projectDeleted: { fileCount: 0, totalBytes: 0 },
      totalFileCount: 1,
      totalBytes: 100,
    }

    const output = formatResetResult(result)

    expect(output).toContain('Configuration in settings.json was preserved.')
    expect(output).toContain(
      'ToM will begin learning again from your next session.'
    )
  })
})

describe('formatConfirmationPrompt', () => {
  it('lists all data types that will be deleted', () => {
    const output = formatConfirmationPrompt()

    expect(output).toContain('# ToM Reset')
    expect(output).toContain('session logs (Tier 1)')
    expect(output).toContain('session models (Tier 2)')
    expect(output).toContain('User model (Tier 3)')
    expect(output).toContain('Usage log')
    expect(output).toContain('BM25 search index')
  })

  it('states config will be preserved', () => {
    const output = formatConfirmationPrompt()

    expect(output).toContain('Configuration in settings.json will be preserved.')
  })

  it('asks for confirmation', () => {
    const output = formatConfirmationPrompt()

    expect(output).toContain('Are you sure you want to proceed?')
  })
})

describe('formatBytes', () => {
  it('formats zero bytes', () => {
    expect(formatBytes(0)).toBe('0 B')
  })

  it('formats bytes under 1KB', () => {
    expect(formatBytes(500)).toBe('500 B')
  })

  it('formats kilobytes', () => {
    expect(formatBytes(2048)).toBe('2.0 KB')
  })

  it('formats megabytes', () => {
    expect(formatBytes(1048576)).toBe('1.0 MB')
  })
})

describe('main', () => {
  it('shows confirmation prompt without --confirm flag', () => {
    const chunks: string[] = []
    const originalWrite = process.stdout.write
    const originalArgv = process.argv
    process.stdout.write = ((chunk: string) => {
      chunks.push(chunk)
      return true
    }) as typeof process.stdout.write
    process.argv = ['node', 'tom-reset.js']

    try {
      main()
    } finally {
      process.stdout.write = originalWrite
      process.argv = originalArgv
    }

    const output = chunks.join('')
    expect(output).toContain('# ToM Reset')
    expect(output).toContain('Are you sure you want to proceed?')
  })

  it('performs reset with --confirm flag', () => {
    createGlobalTomData()
    const tomDir = path.join(tempDir, '.claude', 'tom')

    const chunks: string[] = []
    const originalWrite = process.stdout.write
    const originalArgv = process.argv
    process.stdout.write = ((chunk: string) => {
      chunks.push(chunk)
      return true
    }) as typeof process.stdout.write
    process.argv = ['node', 'tom-reset.js', '--confirm']

    try {
      main()
    } finally {
      process.stdout.write = originalWrite
      process.argv = originalArgv
    }

    const output = chunks.join('')
    expect(output).toContain('# ToM Reset Complete')
    expect(output).toContain('Total files deleted:')
    expect(fs.existsSync(tomDir)).toBe(false)
  })

  it('shows no-data message when confirming with no data', () => {
    const chunks: string[] = []
    const originalWrite = process.stdout.write
    const originalArgv = process.argv
    process.stdout.write = ((chunk: string) => {
      chunks.push(chunk)
      return true
    }) as typeof process.stdout.write
    process.argv = ['node', 'tom-reset.js', '--confirm']

    try {
      main()
    } finally {
      process.stdout.write = originalWrite
      process.argv = originalArgv
    }

    const output = chunks.join('')
    expect(output).toContain('No ToM data found to delete.')
  })
})
