import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import { buildMemoryIndex } from './memory-index.js'
import type { SessionLog, SessionModel, UserModel } from './schemas.js'

// --- Test Fixtures ---

function createTestSessionLog(sessionId: string): SessionLog {
  return {
    sessionId,
    startedAt: '2026-01-15T10:00:00.000Z',
    endedAt: '2026-01-15T11:00:00.000Z',
    interactions: [
      {
        toolName: 'Edit',
        parameterShape: { file_path: 'string', old_string: 'string', new_string: 'string' },
        outcomeSummary: 'File edited successfully',
        timestamp: '2026-01-15T10:05:00.000Z',
      },
      {
        toolName: 'Read',
        parameterShape: { file_path: 'string' },
        outcomeSummary: 'File read successfully',
        timestamp: '2026-01-15T10:10:00.000Z',
      },
      {
        toolName: 'Bash',
        parameterShape: { command: 'string' },
        outcomeSummary: 'Command completed with error',
        timestamp: '2026-01-15T10:15:00.000Z',
      },
    ],
  }
}

function createTestSessionModel(sessionId: string): SessionModel {
  return {
    sessionId,
    intent: 'code modification',
    interactionPatterns: ['uses-Edit', 'uses-Read'],
    codingPreferences: ['typescript', 'functional-style'],
    satisfactionSignals: {
      frustration: false,
      satisfaction: true,
      urgency: 'low',
    },
  }
}

function createTestUserModel(): UserModel {
  return {
    preferencesClusters: [
      {
        category: 'codingPreferences',
        key: 'preference',
        value: 'typescript',
        confidence: 0.8,
        lastUpdated: '2026-01-15T10:00:00.000Z',
        sessionCount: 5,
      },
    ],
    interactionStyleSummary: 'prefers concise responses',
    codingStyleSummary: 'functional TypeScript',
    projectOverrides: {},
  }
}

// --- Test Helpers ---

let testDir: string
let originalHome: string | undefined
let originalCwd: () => string

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tom-memory-index-test-'))
  originalHome = process.env['HOME']
  process.env['HOME'] = testDir
  originalCwd = process.cwd
  process.cwd = () => testDir
})

afterEach(() => {
  process.env['HOME'] = originalHome
  process.cwd = originalCwd
  fs.rmSync(testDir, { recursive: true, force: true })
})

function writeTestFile(relativePath: string, data: unknown): void {
  const fullPath = path.join(testDir, '.claude', 'tom', relativePath)
  fs.mkdirSync(path.dirname(fullPath), { recursive: true })
  fs.writeFileSync(fullPath, JSON.stringify(data, null, 2))
}

// --- Tests ---

describe('buildMemoryIndex', () => {
  it('builds index from session logs and models', () => {
    const sessionLog = createTestSessionLog('session-1')
    const sessionModel = createTestSessionModel('session-1')
    const userModel = createTestUserModel()

    writeTestFile('sessions/session-1.json', sessionLog)
    writeTestFile('session-models/session-1.json', sessionModel)
    writeTestFile('user-model.json', userModel)

    const index = buildMemoryIndex('global')

    expect(index.documentCount).toBe(3)
  })

  it('returns empty index when no files exist', () => {
    const index = buildMemoryIndex('global')

    expect(index.documentCount).toBe(0)
  })

  it('indexes keyed Tier 2 preference entries by key and value tokens', () => {
    const model: SessionModel = {
      sessionId: 'session-keyed',
      intent: 'configure workflow',
      interactionPatterns: [
        'uses-Edit',
        { key: 'communication_style', value: 'terse' },
      ],
      codingPreferences: [{ key: 'issue_tracking', value: 'beads' }],
    }
    writeTestFile('session-models/session-keyed.json', model)

    const index = buildMemoryIndex('global')

    const doc = index.docs.find(d => d.id === 'model:session-keyed')
    expect(doc).toBeDefined()
    expect(doc?.termFreqs['issue_tracking']).toBeGreaterThan(0)
    expect(doc?.termFreqs['beads']).toBeGreaterThan(0)
    expect(doc?.termFreqs['communication_style']).toBeGreaterThan(0)
    expect(doc?.termFreqs['terse']).toBeGreaterThan(0)
    // Keyed entries must never stringify to '[object Object]'
    expect(doc?.termFreqs['object']).toBeUndefined()
    // Legacy bare strings still index
    expect(doc?.termFreqs['edit']).toBeGreaterThan(0)
  })
})
