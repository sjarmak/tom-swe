import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import { getInspectData, formatInspect, main } from './tom-inspect'
import type { InspectOutput, SessionEntry } from './tom-inspect'
import type { UserModel, SessionModel, SessionLog } from '../schemas'

// --- Test Setup ---

let tempDir: string
let projectDir: string
let originalHome: string | undefined
let originalCwd: typeof process.cwd

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tom-inspect-test-'))
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
  const tomDir = path.join(tempDir, '.claude', 'tom')
  fs.mkdirSync(tomDir, { recursive: true })
  fs.writeFileSync(
    path.join(tomDir, 'config.json'),
    JSON.stringify(tomConfig),
    'utf-8'
  )
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

  const session: SessionLog = {
    sessionId,
    startedAt,
    endedAt: startedAt,
    interactions: [],
  }
  fs.writeFileSync(
    path.join(sessionsDir, `${sessionId}.json`),
    JSON.stringify(session),
    'utf-8'
  )
}

function createSessionModel(
  sessionId: string,
  intent: string,
  scope: 'global' | 'project'
): void {
  const baseDir =
    scope === 'global'
      ? path.join(tempDir, '.claude', 'tom')
      : path.join(projectDir, '.claude', 'tom')
  const modelsDir = path.join(baseDir, 'session-models')
  fs.mkdirSync(modelsDir, { recursive: true })

  const model: SessionModel = {
    sessionId,
    intent,
    interactionPatterns: [],
    codingPreferences: [],
    satisfactionSignals: {
      frustration: false,
      satisfaction: true,
      urgency: 'low',
    },
  }
  fs.writeFileSync(
    path.join(modelsDir, `${sessionId}.json`),
    JSON.stringify(model),
    'utf-8'
  )
}

function createUserModel(model: UserModel, scope: 'global' | 'project'): void {
  const baseDir =
    scope === 'global'
      ? path.join(tempDir, '.claude', 'tom')
      : path.join(projectDir, '.claude', 'tom')
  fs.mkdirSync(baseDir, { recursive: true })
  fs.writeFileSync(
    path.join(baseDir, 'user-model.json'),
    JSON.stringify(model),
    'utf-8'
  )
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

// --- Tests: getInspectData ---

describe('getInspectData', () => {
  it('returns empty sessions when no data exists', () => {
    const data = getInspectData()

    expect(data.sessions).toEqual([])
    expect(data.userModel).toBeNull()
    expect(data.totalSessionCount).toBe(0)
    expect(data.pruneCount).toBe(0)
  })

  it('lists global sessions sorted by date', () => {
    createSettings({ enabled: true })
    createSessionLog('s1', '2026-01-01T00:00:00.000Z', 'global')
    createSessionLog('s2', '2026-01-03T00:00:00.000Z', 'global')
    createSessionLog('s3', '2026-01-02T00:00:00.000Z', 'global')

    const data = getInspectData()

    expect(data.sessions).toHaveLength(3)
    expect(data.sessions[0]?.sessionId).toBe('s1')
    expect(data.sessions[1]?.sessionId).toBe('s3')
    expect(data.sessions[2]?.sessionId).toBe('s2')
  })

  it('includes intent from Tier 2 session model', () => {
    createSettings({ enabled: true })
    createSessionLog('s1', '2026-01-01T00:00:00.000Z', 'global')
    createSessionModel('s1', 'Implementing authentication system', 'global')

    const data = getInspectData()

    expect(data.sessions[0]?.intent).toBe(
      'Implementing authentication system'
    )
  })

  it('returns empty intent when no session model exists', () => {
    createSettings({ enabled: true })
    createSessionLog('s1', '2026-01-01T00:00:00.000Z', 'global')

    const data = getInspectData()

    expect(data.sessions[0]?.intent).toBe('')
  })

  it('includes project sessions', () => {
    createSettings({ enabled: true })
    createSessionLog('s1', '2026-01-01T00:00:00.000Z', 'global')
    createSessionLog('s2', '2026-01-02T00:00:00.000Z', 'project')

    const data = getInspectData()

    expect(data.sessions).toHaveLength(2)
    expect(data.sessions[0]?.scope).toBe('global')
    expect(data.sessions[1]?.scope).toBe('project')
  })

  it('deduplicates sessions with same ID across scopes', () => {
    createSettings({ enabled: true })
    createSessionLog('s1', '2026-01-01T00:00:00.000Z', 'global')
    createSessionLog('s1', '2026-01-01T00:00:00.000Z', 'project')

    const data = getInspectData()

    // Global takes precedence since it's processed first
    expect(data.sessions).toHaveLength(1)
    expect(data.sessions[0]?.scope).toBe('global')
  })

  it('reads merged user model', () => {
    createSettings({ enabled: true })
    createUserModel(sampleUserModel, 'global')

    const data = getInspectData()

    expect(data.userModel).not.toBeNull()
    expect(data.userModel?.preferencesClusters).toHaveLength(3)
  })

  it('calculates prune count when at limit', () => {
    createSettings({ enabled: true, maxSessionsRetained: 3 })
    createSessionLog('s1', '2026-01-01T00:00:00.000Z', 'global')
    createSessionLog('s2', '2026-01-02T00:00:00.000Z', 'global')
    createSessionLog('s3', '2026-01-03T00:00:00.000Z', 'global')

    const data = getInspectData()

    // At exactly the limit: adding one more would exceed, so 1 will be pruned
    expect(data.pruneCount).toBe(1)
    expect(data.sessions[0]?.willBePruned).toBe(true)
    expect(data.sessions[1]?.willBePruned).toBe(false)
    expect(data.sessions[2]?.willBePruned).toBe(false)
  })

  it('calculates prune count when over limit', () => {
    createSettings({ enabled: true, maxSessionsRetained: 2 })
    createSessionLog('s1', '2026-01-01T00:00:00.000Z', 'global')
    createSessionLog('s2', '2026-01-02T00:00:00.000Z', 'global')
    createSessionLog('s3', '2026-01-03T00:00:00.000Z', 'global')

    const data = getInspectData()

    // 3 sessions, max 2: adding one more = prune 2
    expect(data.pruneCount).toBe(2)
    expect(data.sessions[0]?.willBePruned).toBe(true)
    expect(data.sessions[1]?.willBePruned).toBe(true)
    expect(data.sessions[2]?.willBePruned).toBe(false)
  })

  it('reports zero prune count when under limit', () => {
    createSettings({ enabled: true, maxSessionsRetained: 100 })
    createSessionLog('s1', '2026-01-01T00:00:00.000Z', 'global')
    createSessionLog('s2', '2026-01-02T00:00:00.000Z', 'global')

    const data = getInspectData()

    expect(data.pruneCount).toBe(0)
    expect(data.sessions[0]?.willBePruned).toBe(false)
    expect(data.sessions[1]?.willBePruned).toBe(false)
  })
})

// --- Tests: formatInspect ---

describe('formatInspect', () => {
  it('shows empty state when no data exists', () => {
    const data: InspectOutput = {
      sessions: [],
      userModel: null,
      maxSessionsRetained: 100,
      totalSessionCount: 0,
      pruneCount: 0,
    }

    const output = formatInspect(data)

    expect(output).toContain('# ToM Inspect')
    expect(output).toContain('No sessions stored.')
    expect(output).toContain('No user model found.')
  })

  it('lists sessions with ID, date, and intent', () => {
    const sessions: SessionEntry[] = [
      {
        sessionId: 'abc-123',
        date: '2026-01-15T10:30:00.000Z',
        intent: 'Implementing dark mode',
        scope: 'global',
        willBePruned: false,
      },
    ]

    const data: InspectOutput = {
      sessions,
      userModel: null,
      maxSessionsRetained: 100,
      totalSessionCount: 1,
      pruneCount: 0,
    }

    const output = formatInspect(data)

    expect(output).toContain('**abc-123**')
    expect(output).toContain('2026-01-15')
    expect(output).toContain('Implementing dark mode')
    expect(output).toContain('global')
    expect(output).toContain('1 session(s) stored (max: 100)')
  })

  it('shows no-analysis label for sessions without intent', () => {
    const sessions: SessionEntry[] = [
      {
        sessionId: 'abc-123',
        date: '2026-01-15T10:30:00.000Z',
        intent: '',
        scope: 'global',
        willBePruned: false,
      },
    ]

    const data: InspectOutput = {
      sessions,
      userModel: null,
      maxSessionsRetained: 100,
      totalSessionCount: 1,
      pruneCount: 0,
    }

    const output = formatInspect(data)

    expect(output).toContain('(no analysis)')
  })

  it('highlights sessions that will be pruned', () => {
    const sessions: SessionEntry[] = [
      {
        sessionId: 'old-session',
        date: '2026-01-01T00:00:00.000Z',
        intent: 'Old work',
        scope: 'global',
        willBePruned: true,
      },
      {
        sessionId: 'new-session',
        date: '2026-01-15T00:00:00.000Z',
        intent: 'New work',
        scope: 'global',
        willBePruned: false,
      },
    ]

    const data: InspectOutput = {
      sessions,
      userModel: null,
      maxSessionsRetained: 2,
      totalSessionCount: 2,
      pruneCount: 1,
    }

    const output = formatInspect(data)

    expect(output).toContain('[WILL BE PRUNED]')
    expect(output).toContain(
      '1 session(s) will be pruned on next session analysis'
    )
    // Old session has prune marker, new session does not
    expect(output).toContain('old-session** ')
    expect(output).toContain('Old work [WILL BE PRUNED]')
    expect(output).not.toContain('New work [WILL BE PRUNED]')
  })

  it('renders user model with preferences grouped by category', () => {
    const data: InspectOutput = {
      sessions: [],
      userModel: sampleUserModel,
      maxSessionsRetained: 100,
      totalSessionCount: 0,
      pruneCount: 0,
    }

    const output = formatInspect(data)

    expect(output).toContain('## User Model (Tier 3)')
    expect(output).toContain('**codingPreferences**')
    expect(output).toContain('**interactionStyle**')
    expect(output).toContain('language: TypeScript (90% confidence')
    expect(output).toContain('testingApproach: TDD (70% confidence')
    expect(output).toContain('verbosity: concise (50% confidence')
  })

  it('renders interaction and coding style summaries', () => {
    const data: InspectOutput = {
      sessions: [],
      userModel: sampleUserModel,
      maxSessionsRetained: 100,
      totalSessionCount: 0,
      pruneCount: 0,
    }

    const output = formatInspect(data)

    expect(output).toContain('### Interaction Style')
    expect(output).toContain('Prefers concise, direct responses')
    expect(output).toContain('### Coding Style')
    expect(output).toContain('TypeScript-first with TDD approach')
  })

  it('renders project overrides', () => {
    const modelWithOverrides: UserModel = {
      ...sampleUserModel,
      projectOverrides: {
        '/home/user/my-project': [
          {
            category: 'codingPreferences',
            key: 'language',
            value: 'Python',
            confidence: 0.8,
            lastUpdated: '2026-01-15T00:00:00.000Z',
            sessionCount: 2,
          },
        ],
      },
    }

    const data: InspectOutput = {
      sessions: [],
      userModel: modelWithOverrides,
      maxSessionsRetained: 100,
      totalSessionCount: 0,
      pruneCount: 0,
    }

    const output = formatInspect(data)

    expect(output).toContain('### Project Overrides')
    expect(output).toContain('/home/user/my-project')
    expect(output).toContain('language: Python (80% confidence')
  })

  it('sorts preferences by confidence within each category', () => {
    const modelWithManyPrefs: UserModel = {
      ...sampleUserModel,
      preferencesClusters: [
        {
          category: 'codingPreferences',
          key: 'library',
          value: 'React',
          confidence: 0.3,
          lastUpdated: '2026-01-15T00:00:00.000Z',
          sessionCount: 1,
        },
        {
          category: 'codingPreferences',
          key: 'language',
          value: 'TypeScript',
          confidence: 0.9,
          lastUpdated: '2026-01-15T00:00:00.000Z',
          sessionCount: 5,
        },
      ],
    }

    const data: InspectOutput = {
      sessions: [],
      userModel: modelWithManyPrefs,
      maxSessionsRetained: 100,
      totalSessionCount: 0,
      pruneCount: 0,
    }

    const output = formatInspect(data)

    const langPos = output.indexOf('language: TypeScript')
    const libPos = output.indexOf('library: React')

    // Higher confidence (language) should come before lower confidence (library)
    expect(langPos).toBeLessThan(libPos)
  })

  it('omits style sections when summaries are empty', () => {
    const emptyModel: UserModel = {
      preferencesClusters: [],
      interactionStyleSummary: '',
      codingStyleSummary: '',
      projectOverrides: {},
    }

    const data: InspectOutput = {
      sessions: [],
      userModel: emptyModel,
      maxSessionsRetained: 100,
      totalSessionCount: 0,
      pruneCount: 0,
    }

    const output = formatInspect(data)

    expect(output).not.toContain('### Interaction Style')
    expect(output).not.toContain('### Coding Style')
  })
})

// --- Tests: main ---

describe('main', () => {
  it('writes formatted output to stdout', () => {
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
    expect(output).toContain('# ToM Inspect')
    expect(output).toContain('## Stored Sessions')
  })
})
