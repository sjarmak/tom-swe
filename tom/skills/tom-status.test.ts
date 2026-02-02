import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import { getStatus, formatStatus, main } from './tom-status'
import type { StatusOutput } from './tom-status'
import type { UserModel } from '../schemas'

// --- Test Setup ---

let tempDir: string
let originalHome: string | undefined
let originalCwd: typeof process.cwd

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tom-status-test-'))
  originalHome = process.env['HOME']
  process.env['HOME'] = tempDir

  originalCwd = process.cwd
  process.cwd = () => tempDir
})

afterEach(() => {
  process.env['HOME'] = originalHome
  process.cwd = originalCwd
  fs.rmSync(tempDir, { recursive: true, force: true })
})

// --- Helpers ---

function createSettings(tomConfig: Record<string, unknown>): void {
  const tomDir = path.join(tempDir, '.claude', 'tom')
  fs.mkdirSync(tomDir, { recursive: true })
  fs.writeFileSync(
    path.join(tomDir, 'config.json'),
    JSON.stringify(tomConfig),
    'utf-8'
  )
}

function createUserModel(model: UserModel, scope: 'global' | 'project'): void {
  const baseDir =
    scope === 'global'
      ? path.join(tempDir, '.claude', 'tom')
      : path.join(tempDir, '.claude', 'tom')
  fs.mkdirSync(baseDir, { recursive: true })
  fs.writeFileSync(
    path.join(baseDir, 'user-model.json'),
    JSON.stringify(model),
    'utf-8'
  )
}

function createSessionFiles(count: number): void {
  const sessionsDir = path.join(tempDir, '.claude', 'tom', 'sessions')
  fs.mkdirSync(sessionsDir, { recursive: true })
  for (let i = 0; i < count; i++) {
    const session = {
      sessionId: `session-${i}`,
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T01:00:00.000Z',
      interactions: [],
    }
    fs.writeFileSync(
      path.join(sessionsDir, `session-${i}.json`),
      JSON.stringify(session),
      'utf-8'
    )
  }
}

function createSessionModelFiles(count: number): void {
  const modelsDir = path.join(tempDir, '.claude', 'tom', 'session-models')
  fs.mkdirSync(modelsDir, { recursive: true })
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(
      path.join(modelsDir, `session-${i}.json`),
      JSON.stringify({ sessionId: `session-${i}` }),
      'utf-8'
    )
  }
}

const sampleUserModel: UserModel = {
  preferencesClusters: [
    {
      category: 'codingPreferences',
      key: 'language',
      value: 'TypeScript',
      confidence: 0.9,
      lastUpdated: '2026-01-15T00:00:00.000Z',
      sessionCount: 5,
    },
    {
      category: 'codingPreferences',
      key: 'testingApproach',
      value: 'TDD',
      confidence: 0.7,
      lastUpdated: '2026-01-14T00:00:00.000Z',
      sessionCount: 3,
    },
    {
      category: 'interactionStyle',
      key: 'verbosity',
      value: 'concise',
      confidence: 0.5,
      lastUpdated: '2026-01-13T00:00:00.000Z',
      sessionCount: 2,
    },
  ],
  interactionStyleSummary: 'Prefers concise, direct responses',
  codingStyleSummary: 'TypeScript-first with TDD approach',
  projectOverrides: {},
}

// --- Tests ---

describe('getStatus', () => {
  it('returns default config when no settings exist', () => {
    const status = getStatus()

    expect(status.hasModel).toBe(false)
    expect(status.config.enabled).toBe(false)
    expect(status.config.consultThreshold).toBe('medium')
    expect(status.config.models.memoryUpdate).toBe('haiku')
    expect(status.config.models.consultation).toBe('sonnet')
    expect(status.config.preferenceDecayDays).toBe(30)
    expect(status.config.maxSessionsRetained).toBe(100)
  })

  it('reads custom config from settings', () => {
    createSettings({
      enabled: true,
      consultThreshold: 'high',
      models: { memoryUpdate: 'sonnet', consultation: 'opus' },
      preferenceDecayDays: 60,
      maxSessionsRetained: 50,
    })

    const status = getStatus()

    expect(status.config.enabled).toBe(true)
    expect(status.config.consultThreshold).toBe('high')
    expect(status.config.models.memoryUpdate).toBe('sonnet')
    expect(status.config.models.consultation).toBe('opus')
    expect(status.config.preferenceDecayDays).toBe(60)
    expect(status.config.maxSessionsRetained).toBe(50)
  })

  it('returns hasModel=false when no user model exists', () => {
    const status = getStatus()

    expect(status.hasModel).toBe(false)
    expect(status.topPreferences).toEqual([])
    expect(status.interactionStyleSummary).toBe('')
    expect(status.codingStyleSummary).toBe('')
  })

  it('returns user model data when model exists', () => {
    createSettings({ enabled: true })
    createUserModel(sampleUserModel, 'global')

    const status = getStatus()

    expect(status.hasModel).toBe(true)
    expect(status.topPreferences).toHaveLength(3)
    expect(status.interactionStyleSummary).toBe(
      'Prefers concise, direct responses'
    )
    expect(status.codingStyleSummary).toBe(
      'TypeScript-first with TDD approach'
    )
  })

  it('returns top preferences sorted by confidence', () => {
    createSettings({ enabled: true })
    createUserModel(sampleUserModel, 'global')

    const status = getStatus()

    expect(status.topPreferences[0]?.confidence).toBe(0.9)
    expect(status.topPreferences[1]?.confidence).toBe(0.7)
    expect(status.topPreferences[2]?.confidence).toBe(0.5)
  })

  it('counts Tier 1 session files', () => {
    // HOME and cwd both point to tempDir, so global and project paths overlap
    // Files are counted once per directory that exists
    const projectDir = path.join(tempDir, 'project')
    fs.mkdirSync(projectDir, { recursive: true })
    process.cwd = () => projectDir

    createSettings({ enabled: true })
    createSessionFiles(5)

    const status = getStatus()

    // Only global sessions exist (5 files), project dir has no sessions
    expect(status.storage.tier1SessionCount).toBe(5)
  })

  it('counts Tier 2 model files', () => {
    const projectDir = path.join(tempDir, 'project')
    fs.mkdirSync(projectDir, { recursive: true })
    process.cwd = () => projectDir

    createSettings({ enabled: true })
    createSessionModelFiles(3)

    const status = getStatus()

    // Only global session-models exist (3 files), project dir has none
    expect(status.storage.tier2ModelCount).toBe(3)
  })

  it('measures Tier 3 user model size', () => {
    createSettings({ enabled: true })
    createUserModel(sampleUserModel, 'global')

    const status = getStatus()

    expect(status.storage.tier3SizeBytes).toBeGreaterThan(0)
  })

  it('returns zero storage stats when no files exist', () => {
    const status = getStatus()

    expect(status.storage.tier1SessionCount).toBe(0)
    expect(status.storage.tier2ModelCount).toBe(0)
    expect(status.storage.tier3SizeBytes).toBe(0)
  })

  it('limits top preferences to 10', () => {
    const manyPrefs: UserModel = {
      ...sampleUserModel,
      preferencesClusters: Array.from({ length: 15 }, (_, i) => ({
        category: 'codingPreferences',
        key: `pref-${i}`,
        value: `value-${i}`,
        confidence: (15 - i) / 15,
        lastUpdated: '2026-01-15T00:00:00.000Z',
        sessionCount: 1,
      })),
    }
    createSettings({ enabled: true })
    createUserModel(manyPrefs, 'global')

    const status = getStatus()

    expect(status.topPreferences).toHaveLength(10)
  })
})

describe('formatStatus', () => {
  it('shows no-model message when hasModel is false', () => {
    const status: StatusOutput = {
      hasModel: false,
      config: {
        enabled: false,
        consultThreshold: 'medium',
        models: { memoryUpdate: 'haiku', consultation: 'sonnet' },
        preferenceDecayDays: 30,
        maxSessionsRetained: 100,
      },
      storage: { tier1SessionCount: 0, tier2ModelCount: 0, tier3SizeBytes: 0 },
      topPreferences: [],
      interactionStyleSummary: '',
      codingStyleSummary: '',
    }

    const output = formatStatus(status)

    expect(output).toContain(
      'No user model found. ToM will begin learning after your first session.'
    )
  })

  it('includes configuration section', () => {
    const status: StatusOutput = {
      hasModel: false,
      config: {
        enabled: true,
        consultThreshold: 'high',
        models: { memoryUpdate: 'sonnet', consultation: 'opus' },
        preferenceDecayDays: 60,
        maxSessionsRetained: 50,
      },
      storage: { tier1SessionCount: 0, tier2ModelCount: 0, tier3SizeBytes: 0 },
      topPreferences: [],
      interactionStyleSummary: '',
      codingStyleSummary: '',
    }

    const output = formatStatus(status)

    expect(output).toContain('Enabled: Yes')
    expect(output).toContain('Consult Threshold: high')
    expect(output).toContain('memoryUpdate=sonnet')
    expect(output).toContain('consultation=opus')
    expect(output).toContain('Preference Decay: 60 days')
    expect(output).toContain('Max Sessions Retained: 50')
  })

  it('includes storage section', () => {
    const status: StatusOutput = {
      hasModel: false,
      config: {
        enabled: true,
        consultThreshold: 'medium',
        models: { memoryUpdate: 'haiku', consultation: 'sonnet' },
        preferenceDecayDays: 30,
        maxSessionsRetained: 100,
      },
      storage: {
        tier1SessionCount: 5,
        tier2ModelCount: 3,
        tier3SizeBytes: 2048,
      },
      topPreferences: [],
      interactionStyleSummary: '',
      codingStyleSummary: '',
    }

    const output = formatStatus(status)

    expect(output).toContain('Tier 1 Sessions: 5')
    expect(output).toContain('Tier 2 Models: 3')
    expect(output).toContain('Tier 3 User Model: 2.0 KB')
  })

  it('includes top preferences when model exists', () => {
    const status: StatusOutput = {
      hasModel: true,
      config: {
        enabled: true,
        consultThreshold: 'medium',
        models: { memoryUpdate: 'haiku', consultation: 'sonnet' },
        preferenceDecayDays: 30,
        maxSessionsRetained: 100,
      },
      storage: {
        tier1SessionCount: 5,
        tier2ModelCount: 5,
        tier3SizeBytes: 1024,
      },
      topPreferences: [
        {
          category: 'codingPreferences',
          key: 'language',
          value: 'TypeScript',
          confidence: 0.9,
          lastUpdated: '2026-01-15T00:00:00.000Z',
          sessionCount: 5,
        },
      ],
      interactionStyleSummary: 'Prefers concise responses',
      codingStyleSummary: 'TypeScript-first TDD',
    }

    const output = formatStatus(status)

    expect(output).toContain('Top Preferences (by confidence)')
    expect(output).toContain(
      '[codingPreferences] language: TypeScript (90% confidence, 5 sessions)'
    )
  })

  it('includes interaction and coding style summaries', () => {
    const status: StatusOutput = {
      hasModel: true,
      config: {
        enabled: true,
        consultThreshold: 'medium',
        models: { memoryUpdate: 'haiku', consultation: 'sonnet' },
        preferenceDecayDays: 30,
        maxSessionsRetained: 100,
      },
      storage: {
        tier1SessionCount: 1,
        tier2ModelCount: 1,
        tier3SizeBytes: 512,
      },
      topPreferences: [],
      interactionStyleSummary: 'Prefers concise, direct responses',
      codingStyleSummary: 'TypeScript-first with TDD approach',
    }

    const output = formatStatus(status)

    expect(output).toContain('## Interaction Style')
    expect(output).toContain('Prefers concise, direct responses')
    expect(output).toContain('## Coding Style')
    expect(output).toContain('TypeScript-first with TDD approach')
  })

  it('omits style sections when summaries are empty', () => {
    const status: StatusOutput = {
      hasModel: true,
      config: {
        enabled: true,
        consultThreshold: 'medium',
        models: { memoryUpdate: 'haiku', consultation: 'sonnet' },
        preferenceDecayDays: 30,
        maxSessionsRetained: 100,
      },
      storage: {
        tier1SessionCount: 1,
        tier2ModelCount: 1,
        tier3SizeBytes: 512,
      },
      topPreferences: [],
      interactionStyleSummary: '',
      codingStyleSummary: '',
    }

    const output = formatStatus(status)

    expect(output).not.toContain('## Interaction Style')
    expect(output).not.toContain('## Coding Style')
  })

  it('formats bytes correctly', () => {
    const makeStatus = (bytes: number): StatusOutput => ({
      hasModel: false,
      config: {
        enabled: false,
        consultThreshold: 'medium',
        models: { memoryUpdate: 'haiku', consultation: 'sonnet' },
        preferenceDecayDays: 30,
        maxSessionsRetained: 100,
      },
      storage: { tier1SessionCount: 0, tier2ModelCount: 0, tier3SizeBytes: bytes },
      topPreferences: [],
      interactionStyleSummary: '',
      codingStyleSummary: '',
    })

    expect(formatStatus(makeStatus(0))).toContain('0 B')
    expect(formatStatus(makeStatus(500))).toContain('500 B')
    expect(formatStatus(makeStatus(2048))).toContain('2.0 KB')
    expect(formatStatus(makeStatus(1048576))).toContain('1.0 MB')
  })
})

describe('main', () => {
  it('writes formatted status to stdout', () => {
    const chunks: string[] = []
    const originalWrite = process.stdout.write
    process.stdout.write = ((chunk: string) => {
      chunks.push(chunk)
      return true
    }) as typeof process.stdout.write

    try {
      main()
    } finally {
      process.stdout.write = originalWrite
    }

    const output = chunks.join('')
    expect(output).toContain('# ToM Status')
    expect(output).toContain('## Configuration')
  })
})
