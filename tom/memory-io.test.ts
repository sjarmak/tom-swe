import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import {
  readSessionLog,
  writeSessionLog,
  readSessionModel,
  writeSessionModel,
  readUserModel,
  writeUserModel,
} from './memory-io'

import type { SessionLog, SessionModel, UserModel } from './schemas'

const TEST_DIR = path.join(os.tmpdir(), `tom-test-${Date.now()}`)
const GLOBAL_TOM = path.join(TEST_DIR, 'global-home', '.claude', 'tom')

function mockSessionLog(sessionId: string): SessionLog {
  return {
    sessionId,
    startedAt: '2025-01-01T00:00:00Z',
    endedAt: '2025-01-01T01:00:00Z',
    interactions: [
      {
        toolName: 'Read',
        parameterShape: { file_path: 'string' },
        outcomeSummary: 'Read file successfully',
        timestamp: '2025-01-01T00:30:00Z',
      },
    ],
  }
}

function mockSessionModel(sessionId: string): SessionModel {
  return {
    sessionId,
    intent: 'Debugging authentication issue',
    interactionPatterns: ['read-then-edit', 'test-driven'],
    codingPreferences: ['typescript', 'vitest'],
    satisfactionSignals: {
      frustration: false,
      satisfaction: true,
      urgency: 'low',
    },
  }
}

function mockUserModel(): UserModel {
  return {
    preferencesClusters: [
      {
        category: 'codingPreferences',
        key: 'language',
        value: 'typescript',
        confidence: 0.8,
        lastUpdated: '2025-01-01T00:00:00Z',
        sessionCount: 5,
      },
    ],
    interactionStyleSummary: 'Prefers concise responses',
    codingStyleSummary: 'Functional, immutable patterns',
    projectOverrides: {},
  }
}

// Override HOME and CWD for test isolation
const originalHome = process.env['HOME']
const originalCwd = process.cwd

beforeEach(() => {
  process.env['HOME'] = path.join(TEST_DIR, 'global-home')
  process.cwd = () => path.join(TEST_DIR, 'project')
  fs.mkdirSync(path.join(TEST_DIR, 'global-home'), { recursive: true })
  fs.mkdirSync(path.join(TEST_DIR, 'project'), { recursive: true })
})

afterEach(() => {
  process.env['HOME'] = originalHome
  process.cwd = originalCwd
  fs.rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('readSessionLog / writeSessionLog', () => {
  it('writes and reads back a session log (global)', () => {
    const log = mockSessionLog('sess-001')
    writeSessionLog(log, 'global')
    const result = readSessionLog('sess-001', 'global')
    expect(result).toEqual(log)
  })

  it('writes and reads back a session log (project)', () => {
    const log = mockSessionLog('sess-002')
    writeSessionLog(log, 'project')
    const result = readSessionLog('sess-002', 'project')
    expect(result).toEqual(log)
  })

  it('returns null for missing session', () => {
    expect(readSessionLog('nonexistent', 'global')).toBeNull()
  })

  it('returns null for invalid data on disk', () => {
    const filePath = path.join(GLOBAL_TOM, 'sessions', 'bad.json')
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, '{"invalid": true}', 'utf-8')
    expect(readSessionLog('bad', 'global')).toBeNull()
  })

  it('creates directories on first write', () => {
    const log = mockSessionLog('sess-003')
    writeSessionLog(log, 'global')
    const sessionsDir = path.join(GLOBAL_TOM, 'sessions')
    expect(fs.existsSync(sessionsDir)).toBe(true)
  })

  it('throws on invalid session log input', () => {
    const bad = { sessionId: 123 } as unknown as SessionLog
    expect(() => writeSessionLog(bad, 'global')).toThrow()
  })
})

describe('readSessionModel / writeSessionModel', () => {
  it('writes and reads back a session model (global)', () => {
    const model = mockSessionModel('sess-001')
    writeSessionModel(model, 'global')
    const result = readSessionModel('sess-001', 'global')
    expect(result).toEqual(model)
  })

  it('writes and reads back a session model (project)', () => {
    const model = mockSessionModel('sess-002')
    writeSessionModel(model, 'project')
    const result = readSessionModel('sess-002', 'project')
    expect(result).toEqual(model)
  })

  it('returns null for missing session model', () => {
    expect(readSessionModel('nonexistent', 'global')).toBeNull()
  })
})

describe('readUserModel / writeUserModel', () => {
  it('writes and reads back a user model (global)', () => {
    const model = mockUserModel()
    writeUserModel(model, 'global')
    const result = readUserModel('global')
    expect(result).toEqual(model)
  })

  it('writes and reads back a user model (project)', () => {
    const model = mockUserModel()
    writeUserModel(model, 'project')
    const result = readUserModel('project')
    expect(result).toEqual(model)
  })

  it('returns null when no model exists', () => {
    expect(readUserModel('global')).toBeNull()
    expect(readUserModel('project')).toBeNull()
    expect(readUserModel('merged')).toBeNull()
  })

  it('merges global and project models with project overriding', () => {
    const globalModel: UserModel = {
      preferencesClusters: [
        {
          category: 'codingPreferences',
          key: 'language',
          value: 'javascript',
          confidence: 0.8,
          lastUpdated: '2025-01-01T00:00:00Z',
          sessionCount: 5,
        },
        {
          category: 'codingPreferences',
          key: 'testing',
          value: 'jest',
          confidence: 0.6,
          lastUpdated: '2025-01-01T00:00:00Z',
          sessionCount: 3,
        },
      ],
      interactionStyleSummary: 'Global style',
      codingStyleSummary: 'Global coding style',
      projectOverrides: {},
    }

    const projectModel: UserModel = {
      preferencesClusters: [
        {
          category: 'codingPreferences',
          key: 'language',
          value: 'typescript',
          confidence: 0.9,
          lastUpdated: '2025-01-02T00:00:00Z',
          sessionCount: 2,
        },
      ],
      interactionStyleSummary: 'Project style',
      codingStyleSummary: '',
      projectOverrides: {},
    }

    writeUserModel(globalModel, 'global')
    writeUserModel(projectModel, 'project')

    const merged = readUserModel('merged')
    expect(merged).not.toBeNull()

    // Project overrides the 'language' preference
    const langPref = merged!.preferencesClusters.find(
      (p) => p.category === 'codingPreferences' && p.key === 'language'
    )
    expect(langPref?.value).toBe('typescript')

    // Global-only 'testing' preference still present
    const testPref = merged!.preferencesClusters.find(
      (p) => p.category === 'codingPreferences' && p.key === 'testing'
    )
    expect(testPref?.value).toBe('jest')

    // Project style overrides global (non-empty)
    expect(merged!.interactionStyleSummary).toBe('Project style')

    // Empty project field falls back to global
    expect(merged!.codingStyleSummary).toBe('Global coding style')
  })

  it('returns global model when no project model exists (merged)', () => {
    const globalModel = mockUserModel()
    writeUserModel(globalModel, 'global')
    const result = readUserModel('merged')
    expect(result).toEqual(globalModel)
  })

  it('returns project model when no global model exists (merged)', () => {
    const projectModel = mockUserModel()
    writeUserModel(projectModel, 'project')
    const result = readUserModel('merged')
    expect(result).toEqual(projectModel)
  })

  it('does not mutate the input when writing', () => {
    const model = mockUserModel()
    const original = JSON.stringify(model)
    writeUserModel(model, 'global')
    expect(JSON.stringify(model)).toBe(original)
  })
})
