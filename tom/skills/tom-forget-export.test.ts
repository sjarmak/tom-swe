import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import {
  forgetSession,
  formatForgetResult,
  collectExportData,
  exportToFile,
  formatExportResult,
  main,
} from './tom-forget-export'
import type { ForgetResult, ExportData } from './tom-forget-export'
import type { SessionLog, SessionModel, UserModel } from '../schemas'

// --- Test Setup ---

let tempDir: string
let projectDir: string
let originalHome: string | undefined
let originalCwd: typeof process.cwd

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tom-forget-export-test-'))
  projectDir = path.join(tempDir, 'project')
  fs.mkdirSync(projectDir, { recursive: true })

  originalHome = process.env['HOME']
  process.env['HOME'] = tempDir

  originalCwd = process.cwd
  process.cwd = () => projectDir
})

afterEach(() => {
  process.env['HOME'] = originalHome
  process.cwd = originalCwd
  fs.rmSync(tempDir, { recursive: true, force: true })
})

// --- Helpers ---

function createSettings(tomConfig: Record<string, unknown>): void {
  const settingsDir = path.join(tempDir, '.claude')
  fs.mkdirSync(settingsDir, { recursive: true })
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({ tom: tomConfig }),
    'utf-8'
  )
}

function makeSessionLog(sessionId: string, startedAt: string): SessionLog {
  return {
    sessionId,
    startedAt,
    endedAt: new Date(new Date(startedAt).getTime() + 3600000).toISOString(),
    interactions: [],
  }
}

function makeSessionModel(sessionId: string): SessionModel {
  return {
    sessionId,
    intent: `Intent for ${sessionId}`,
    interactionPatterns: ['pattern-a'],
    codingPreferences: ['pref-a'],
    satisfactionSignals: {
      frustration: false,
      satisfaction: true,
      urgency: 'low' as const,
    },
  }
}

function createSessionLog(
  sessionId: string,
  startedAt: string,
  scope: 'global' | 'project'
): void {
  const baseDir =
    scope === 'global'
      ? path.join(tempDir, '.claude', 'tom')
      : path.join(projectDir, '.claude', 'tom')
  const sessionsDir = path.join(baseDir, 'sessions')
  fs.mkdirSync(sessionsDir, { recursive: true })
  fs.writeFileSync(
    path.join(sessionsDir, `${sessionId}.json`),
    JSON.stringify(makeSessionLog(sessionId, startedAt)),
    'utf-8'
  )
}

function createSessionModel(
  sessionId: string,
  scope: 'global' | 'project'
): void {
  const baseDir =
    scope === 'global'
      ? path.join(tempDir, '.claude', 'tom')
      : path.join(projectDir, '.claude', 'tom')
  const modelsDir = path.join(baseDir, 'session-models')
  fs.mkdirSync(modelsDir, { recursive: true })
  fs.writeFileSync(
    path.join(modelsDir, `${sessionId}.json`),
    JSON.stringify(makeSessionModel(sessionId)),
    'utf-8'
  )
}

function createUserModel(scope: 'global' | 'project'): void {
  const baseDir =
    scope === 'global'
      ? path.join(tempDir, '.claude', 'tom')
      : path.join(projectDir, '.claude', 'tom')
  fs.mkdirSync(baseDir, { recursive: true })

  const model: UserModel = {
    preferencesClusters: [
      {
        category: 'codingPreferences',
        key: 'preference',
        value: 'pref-a',
        confidence: 0.5,
        lastUpdated: '2026-01-15T00:00:00.000Z',
        sessionCount: 3,
      },
    ],
    interactionStyleSummary: '',
    codingStyleSummary: '',
    projectOverrides: {},
  }

  fs.writeFileSync(
    path.join(baseDir, 'user-model.json'),
    JSON.stringify(model),
    'utf-8'
  )
}

function createUsageLog(entries: string[]): void {
  const tomDir = path.join(tempDir, '.claude', 'tom')
  fs.mkdirSync(tomDir, { recursive: true })
  fs.writeFileSync(
    path.join(tomDir, 'usage.log'),
    entries.join('\n') + '\n',
    'utf-8'
  )
}

// --- Forget Tests ---

describe('forgetSession', () => {
  it('returns not-found when session does not exist', () => {
    createSettings({ enabled: true })
    const result = forgetSession('nonexistent')
    expect(result.tier1Deleted).toBe(false)
    expect(result.tier2Deleted).toBe(false)
    expect(result.tier3Rebuilt).toBe(false)
  })

  it('deletes Tier 1 session log from global scope', () => {
    createSettings({ enabled: true })
    createSessionLog('sess-1', '2026-01-01T00:00:00.000Z', 'global')

    const result = forgetSession('sess-1')
    expect(result.tier1Deleted).toBe(true)
    expect(result.sessionId).toBe('sess-1')

    const sessionPath = path.join(
      tempDir, '.claude', 'tom', 'sessions', 'sess-1.json'
    )
    expect(fs.existsSync(sessionPath)).toBe(false)
  })

  it('deletes Tier 2 session model from global scope', () => {
    createSettings({ enabled: true })
    createSessionLog('sess-1', '2026-01-01T00:00:00.000Z', 'global')
    createSessionModel('sess-1', 'global')

    const result = forgetSession('sess-1')
    expect(result.tier1Deleted).toBe(true)
    expect(result.tier2Deleted).toBe(true)

    const modelPath = path.join(
      tempDir, '.claude', 'tom', 'session-models', 'sess-1.json'
    )
    expect(fs.existsSync(modelPath)).toBe(false)
  })

  it('rebuilds Tier 3 user model after deletion', () => {
    createSettings({ enabled: true })
    createSessionLog('sess-1', '2026-01-01T00:00:00.000Z', 'global')
    createSessionLog('sess-2', '2026-01-02T00:00:00.000Z', 'global')
    createSessionModel('sess-1', 'global')
    createSessionModel('sess-2', 'global')
    createUserModel('global')

    const result = forgetSession('sess-1')
    expect(result.tier3Rebuilt).toBe(true)

    // User model should still exist (rebuilt from remaining session)
    const modelPath = path.join(tempDir, '.claude', 'tom', 'user-model.json')
    expect(fs.existsSync(modelPath)).toBe(true)
  })

  it('handles session only in project scope', () => {
    createSettings({ enabled: true })
    createSessionLog('sess-proj', '2026-01-01T00:00:00.000Z', 'project')
    createSessionModel('sess-proj', 'project')

    const result = forgetSession('sess-proj')
    expect(result.tier1Deleted).toBe(true)
    expect(result.tier2Deleted).toBe(true)
    expect(result.tier3Rebuilt).toBe(true)
  })

  it('deletes from both scopes if session exists in both', () => {
    createSettings({ enabled: true })
    createSessionLog('sess-both', '2026-01-01T00:00:00.000Z', 'global')
    createSessionLog('sess-both', '2026-01-01T00:00:00.000Z', 'project')

    const result = forgetSession('sess-both')
    expect(result.tier1Deleted).toBe(true)

    const globalPath = path.join(
      tempDir, '.claude', 'tom', 'sessions', 'sess-both.json'
    )
    const projectPath = path.join(
      projectDir, '.claude', 'tom', 'sessions', 'sess-both.json'
    )
    expect(fs.existsSync(globalPath)).toBe(false)
    expect(fs.existsSync(projectPath)).toBe(false)
  })

  it('rebuilds BM25 index after deletion', () => {
    createSettings({ enabled: true })
    createSessionLog('sess-1', '2026-01-01T00:00:00.000Z', 'global')

    forgetSession('sess-1')

    const indexPath = path.join(tempDir, '.claude', 'tom', 'bm25-index.json')
    expect(fs.existsSync(indexPath)).toBe(true)
  })
})

describe('formatForgetResult', () => {
  it('formats not-found result', () => {
    const result: ForgetResult = {
      sessionId: 'abc',
      tier1Deleted: false,
      tier2Deleted: false,
      tier3Rebuilt: false,
    }
    const output = formatForgetResult(result)
    expect(output).toContain('not found')
    expect(output).toContain('abc')
  })

  it('formats successful deletion', () => {
    const result: ForgetResult = {
      sessionId: 'sess-1',
      tier1Deleted: true,
      tier2Deleted: true,
      tier3Rebuilt: true,
    }
    const output = formatForgetResult(result)
    expect(output).toContain('sess-1')
    expect(output).toContain('deleted')
    expect(output).toContain('rebuilt')
  })

  it('formats partial deletion (no Tier 2)', () => {
    const result: ForgetResult = {
      sessionId: 'sess-1',
      tier1Deleted: true,
      tier2Deleted: false,
      tier3Rebuilt: true,
    }
    const output = formatForgetResult(result)
    expect(output).toContain('Tier 1 session log: deleted')
    expect(output).toContain('Tier 2 session model: not found')
  })
})

// --- Export Tests ---

describe('collectExportData', () => {
  it('returns empty export when no data exists', () => {
    createSettings({ enabled: true })
    const data = collectExportData()
    expect(data.version).toBe('1.0')
    expect(data.tier1Sessions).toHaveLength(0)
    expect(data.tier2Models).toHaveLength(0)
    expect(data.tier3UserModel).toBeNull()
    expect(data.usageLog).toHaveLength(0)
    expect(data.exportedAt).toBeTruthy()
  })

  it('collects sessions from global scope', () => {
    createSettings({ enabled: true })
    createSessionLog('sess-1', '2026-01-01T00:00:00.000Z', 'global')
    createSessionLog('sess-2', '2026-01-02T00:00:00.000Z', 'global')

    const data = collectExportData()
    expect(data.tier1Sessions).toHaveLength(2)
  })

  it('collects session models', () => {
    createSettings({ enabled: true })
    createSessionLog('sess-1', '2026-01-01T00:00:00.000Z', 'global')
    createSessionModel('sess-1', 'global')

    const data = collectExportData()
    expect(data.tier2Models).toHaveLength(1)
    expect(data.tier2Models[0]?.sessionId).toBe('sess-1')
  })

  it('collects user model', () => {
    createSettings({ enabled: true })
    createUserModel('global')

    const data = collectExportData()
    expect(data.tier3UserModel).not.toBeNull()
    expect(data.tier3UserModel?.preferencesClusters).toHaveLength(1)
  })

  it('collects usage log entries', () => {
    createSettings({ enabled: true })
    const entries = [
      JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', operation: 'test', model: 'haiku', tokenCount: 100 }),
      JSON.stringify({ timestamp: '2026-01-01T01:00:00.000Z', operation: 'test2', model: 'sonnet', tokenCount: 200 }),
    ]
    createUsageLog(entries)

    const data = collectExportData()
    expect(data.usageLog).toHaveLength(2)
  })

  it('deduplicates sessions across scopes', () => {
    createSettings({ enabled: true })
    createSessionLog('sess-dup', '2026-01-01T00:00:00.000Z', 'global')
    createSessionLog('sess-dup', '2026-01-01T00:00:00.000Z', 'project')

    const data = collectExportData()
    expect(data.tier1Sessions).toHaveLength(1)
  })

  it('includes config in export', () => {
    createSettings({ enabled: true, maxSessionsRetained: 50 })

    const data = collectExportData()
    expect(data.config.enabled).toBe(true)
    expect(data.config.maxSessionsRetained).toBe(50)
  })
})

describe('exportToFile', () => {
  it('creates export file in current directory', () => {
    createSettings({ enabled: true })
    createSessionLog('sess-1', '2026-01-01T00:00:00.000Z', 'global')

    const filePath = exportToFile()
    expect(filePath).toContain('tom-export-')
    expect(filePath).toContain('.json')
    expect(filePath.startsWith(projectDir)).toBe(true)
    expect(fs.existsSync(filePath)).toBe(true)

    const content = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ExportData
    expect(content.version).toBe('1.0')
    expect(content.tier1Sessions).toHaveLength(1)

    // Clean up export file
    fs.unlinkSync(filePath)
  })

  it('export file is valid JSON', () => {
    createSettings({ enabled: true })
    createUserModel('global')

    const filePath = exportToFile()
    const raw = fs.readFileSync(filePath, 'utf-8')
    expect(() => JSON.parse(raw)).not.toThrow()

    fs.unlinkSync(filePath)
  })
})

describe('formatExportResult', () => {
  it('formats export summary', () => {
    const data: ExportData = {
      exportedAt: '2026-01-01T00:00:00.000Z',
      version: '1.0',
      config: {
        enabled: true,
        consultThreshold: 'medium',
        models: { memoryUpdate: 'haiku', consultation: 'sonnet' },
        preferenceDecayDays: 30,
        maxSessionsRetained: 100,
      },
      tier1Sessions: [makeSessionLog('s1', '2026-01-01T00:00:00.000Z')],
      tier2Models: [makeSessionModel('s1')],
      tier3UserModel: null,
      usageLog: ['line1', 'line2'],
    }

    const output = formatExportResult('/some/path/export.json', data)
    expect(output).toContain('/some/path/export.json')
    expect(output).toContain('Tier 1 sessions: 1')
    expect(output).toContain('Tier 2 session models: 1')
    expect(output).toContain('Tier 3 user model: none')
    expect(output).toContain('Usage log entries: 2')
    expect(output).toContain('self-contained')
  })

  it('shows present when user model exists', () => {
    const data: ExportData = {
      exportedAt: '2026-01-01T00:00:00.000Z',
      version: '1.0',
      config: {
        enabled: true,
        consultThreshold: 'medium',
        models: { memoryUpdate: 'haiku', consultation: 'sonnet' },
        preferenceDecayDays: 30,
        maxSessionsRetained: 100,
      },
      tier1Sessions: [],
      tier2Models: [],
      tier3UserModel: {
        preferencesClusters: [],
        interactionStyleSummary: '',
        codingStyleSummary: '',
        projectOverrides: {},
      },
      usageLog: [],
    }

    const output = formatExportResult('/path/export.json', data)
    expect(output).toContain('Tier 3 user model: present')
  })
})

// --- CLI Entry Point Tests ---

describe('main', () => {
  let originalArgv: string[]
  let stdoutOutput: string

  beforeEach(() => {
    originalArgv = process.argv
    stdoutOutput = ''
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutOutput += String(chunk)
      return true
    }) as typeof process.stdout.write
  })

  afterEach(() => {
    process.argv = originalArgv
  })

  it('shows usage when no command provided', () => {
    process.argv = ['node', 'script']
    main()
    expect(stdoutOutput).toContain('Usage')
  })

  it('shows usage for forget without session-id', () => {
    process.argv = ['node', 'script', 'forget']
    main()
    expect(stdoutOutput).toContain('Usage')
    expect(stdoutOutput).toContain('session-id')
  })

  it('runs forget with session-id', () => {
    createSettings({ enabled: true })
    createSessionLog('sess-cli', '2026-01-01T00:00:00.000Z', 'global')

    process.argv = ['node', 'script', 'forget', 'sess-cli']
    main()
    expect(stdoutOutput).toContain('sess-cli')
    expect(stdoutOutput).toContain('deleted')
  })

  it('runs export command', () => {
    createSettings({ enabled: true })

    process.argv = ['node', 'script', 'export']
    main()
    expect(stdoutOutput).toContain('ToM Export')
    expect(stdoutOutput).toContain('tom-export-')

    // Clean up any created export files
    const files = fs.readdirSync(projectDir)
    for (const file of files) {
      if (file.startsWith('tom-export-')) {
        fs.unlinkSync(path.join(projectDir, file))
      }
    }
  })
})
