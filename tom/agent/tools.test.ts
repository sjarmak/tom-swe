import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import {
  createInvocationState,
  searchMemory,
  readMemoryFile,
  analyzeSession,
  initializeUserProfile,
  giveSuggestions,
  buildMemoryIndex,
} from './tools.js'
import type { AgentInvocationState } from './tools.js'
import { buildIndex } from '../bm25.js'
import type { SessionLog, SessionModel, UserModel, ToMSuggestion } from '../schemas.js'

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
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tom-agent-test-'))
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

describe('createInvocationState', () => {
  it('creates state with default max operations', () => {
    const state = createInvocationState()
    expect(state.operationCount).toBe(0)
    expect(state.maxOperations).toBe(3)
  })

  it('creates state with custom max operations', () => {
    const state = createInvocationState(5)
    expect(state.operationCount).toBe(0)
    expect(state.maxOperations).toBe(5)
  })
})

describe('searchMemory', () => {
  it('returns search results from BM25 index', () => {
    const index = buildIndex([
      { id: 'doc1', content: 'typescript functional programming', tier: 2 },
      { id: 'doc2', content: 'python object oriented', tier: 1 },
    ])
    const state = createInvocationState()

    const { result, state: newState } = searchMemory(
      { query: 'typescript' },
      state,
      index
    )

    expect(result.results.length).toBe(1)
    expect(result.results[0]?.id).toBe('doc1')
    expect(newState.operationCount).toBe(1)
  })

  it('respects k parameter', () => {
    const index = buildIndex([
      { id: 'doc1', content: 'typescript react frontend', tier: 1 },
      { id: 'doc2', content: 'typescript node backend', tier: 1 },
      { id: 'doc3', content: 'typescript testing vitest', tier: 1 },
    ])
    const state = createInvocationState()

    const { result } = searchMemory({ query: 'typescript', k: 2 }, state, index)

    expect(result.results.length).toBe(2)
  })

  it('blocks when operation limit reached', () => {
    const index = buildIndex([
      { id: 'doc1', content: 'typescript', tier: 1 },
    ])
    const state: AgentInvocationState = { operationCount: 3, maxOperations: 3 }

    const { result, state: newState } = searchMemory(
      { query: 'typescript' },
      state,
      index
    )

    expect(result.results).toEqual([])
    expect(newState.operationCount).toBe(3)
  })
})

describe('readMemoryFile', () => {
  it('reads a Tier 1 session log', () => {
    const sessionLog = createTestSessionLog('session-1')
    writeTestFile('sessions/session-1.json', sessionLog)

    const state = createInvocationState()
    const { result, state: newState } = readMemoryFile(
      { tier: 1, id: 'session-1', scope: 'global' },
      state
    )

    expect(result.data).not.toBeNull()
    expect((result.data as SessionLog).sessionId).toBe('session-1')
    expect(newState.operationCount).toBe(1)
  })

  it('reads a Tier 2 session model', () => {
    const model = createTestSessionModel('session-1')
    writeTestFile('session-models/session-1.json', model)

    const state = createInvocationState()
    const { result } = readMemoryFile(
      { tier: 2, id: 'session-1', scope: 'global' },
      state
    )

    expect(result.data).not.toBeNull()
    expect((result.data as SessionModel).intent).toBe('code modification')
  })

  it('reads a Tier 3 user model', () => {
    const userModel = createTestUserModel()
    writeTestFile('user-model.json', userModel)

    const state = createInvocationState()
    const { result } = readMemoryFile(
      { tier: 3, id: 'user-model', scope: 'global' },
      state
    )

    expect(result.data).not.toBeNull()
    expect((result.data as UserModel).codingStyleSummary).toBe('functional TypeScript')
  })

  it('returns null for missing files', () => {
    const state = createInvocationState()
    const { result } = readMemoryFile(
      { tier: 1, id: 'nonexistent', scope: 'global' },
      state
    )

    expect(result.data).toBeNull()
  })

  it('blocks when operation limit reached', () => {
    const state: AgentInvocationState = { operationCount: 3, maxOperations: 3 }
    const { result, state: newState } = readMemoryFile(
      { tier: 3, id: 'user-model' },
      state
    )

    expect(result.data).toBeNull()
    expect(newState.operationCount).toBe(3)
  })
})

describe('analyzeSession', () => {
  it('extracts session model from session log', () => {
    const sessionLog = createTestSessionLog('session-1')
    writeTestFile('sessions/session-1.json', sessionLog)

    const state = createInvocationState()
    const { result, state: newState } = analyzeSession(
      { sessionId: 'session-1', scope: 'global' },
      state
    )

    expect(result.sessionModel).not.toBeNull()
    expect(result.sessionModel?.sessionId).toBe('session-1')
    expect(result.sessionModel?.intent).toContain('code modification')
    expect(result.sessionModel?.interactionPatterns).toContain('uses-Edit')
    expect(newState.operationCount).toBe(1)
  })

  it('writes the extracted session model', () => {
    const sessionLog = createTestSessionLog('session-1')
    writeTestFile('sessions/session-1.json', sessionLog)

    const state = createInvocationState()
    analyzeSession({ sessionId: 'session-1', scope: 'global' }, state)

    const modelPath = path.join(testDir, '.claude', 'tom', 'session-models', 'session-1.json')
    expect(fs.existsSync(modelPath)).toBe(true)
  })

  it('returns null for missing session', () => {
    const state = createInvocationState()
    const { result } = analyzeSession(
      { sessionId: 'nonexistent', scope: 'global' },
      state
    )

    expect(result.sessionModel).toBeNull()
  })

  it('detects frustration from error outcomes', () => {
    const sessionLog: SessionLog = {
      sessionId: 'frustrated-session',
      startedAt: '2026-01-15T10:00:00.000Z',
      endedAt: '2026-01-15T11:00:00.000Z',
      interactions: [
        { toolName: 'Bash', parameterShape: { command: 'string' }, outcomeSummary: 'Command failed with error', timestamp: '2026-01-15T10:05:00.000Z' },
        { toolName: 'Bash', parameterShape: { command: 'string' }, outcomeSummary: 'Build error occurred', timestamp: '2026-01-15T10:10:00.000Z' },
        { toolName: 'Bash', parameterShape: { command: 'string' }, outcomeSummary: 'Retry failed again', timestamp: '2026-01-15T10:15:00.000Z' },
      ],
    }
    writeTestFile('sessions/frustrated-session.json', sessionLog)

    const state = createInvocationState()
    const { result } = analyzeSession(
      { sessionId: 'frustrated-session', scope: 'global' },
      state
    )

    expect(result.sessionModel?.satisfactionSignals.frustration).toBe(true)
  })

  it('blocks when operation limit reached', () => {
    const state: AgentInvocationState = { operationCount: 3, maxOperations: 3 }
    const { result } = analyzeSession({ sessionId: 'session-1' }, state)

    expect(result.sessionModel).toBeNull()
  })
})

describe('initializeUserProfile', () => {
  it('creates empty profile when no sessions exist', () => {
    const result = initializeUserProfile({ scope: 'global' })

    expect(result.created).toBe(true)
    expect(result.sessionCount).toBe(0)

    const modelPath = path.join(testDir, '.claude', 'tom', 'user-model.json')
    expect(fs.existsSync(modelPath)).toBe(true)
  })

  it('bootstraps from existing session models', () => {
    const model1 = createTestSessionModel('session-1')
    const model2 = createTestSessionModel('session-2')
    writeTestFile('session-models/session-1.json', model1)
    writeTestFile('session-models/session-2.json', model2)

    const result = initializeUserProfile({ scope: 'global' })

    expect(result.created).toBe(true)
    expect(result.sessionCount).toBe(2)
  })

  it('does not overwrite existing profile', () => {
    const existingModel = createTestUserModel()
    writeTestFile('user-model.json', existingModel)

    const result = initializeUserProfile({ scope: 'global' })

    expect(result.created).toBe(false)
  })

  it('does not count as memory operation', () => {
    // initializeUserProfile does not accept or modify state
    // Verify it completes without state parameter
    const result = initializeUserProfile({ scope: 'global' })
    expect(result.created).toBe(true)
  })
})

describe('giveSuggestions', () => {
  it('validates and returns suggestions', () => {
    const suggestions: ToMSuggestion[] = [
      {
        type: 'preference',
        content: 'User prefers functional patterns over classes',
        confidence: 0.8,
        sourceSessions: ['session-1', 'session-2'],
      },
      {
        type: 'style',
        content: 'User prefers concise responses',
        confidence: 0.6,
        sourceSessions: ['session-3'],
      },
    ]

    const result = giveSuggestions({ suggestions })

    expect(result.accepted).toBe(2)
    expect(result.suggestions).toEqual(suggestions)
  })

  it('filters out invalid suggestions', () => {
    const suggestions = [
      {
        type: 'preference',
        content: 'Valid suggestion',
        confidence: 0.5,
        sourceSessions: ['session-1'],
      },
      {
        type: 'invalid-type' as 'preference',
        content: 'Invalid suggestion',
        confidence: 0.5,
        sourceSessions: [],
      },
    ] as ToMSuggestion[]

    const result = giveSuggestions({ suggestions })

    expect(result.accepted).toBe(1)
    expect(result.suggestions.length).toBe(1)
  })

  it('does not count as memory operation', () => {
    // giveSuggestions does not accept or modify state
    const result = giveSuggestions({ suggestions: [] })
    expect(result.accepted).toBe(0)
  })
})

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
})

describe('operation limit enforcement', () => {
  it('allows up to 3 operations then blocks', () => {
    const index = buildIndex([
      { id: 'doc1', content: 'test content', tier: 1 },
    ])

    let state = createInvocationState()

    // Operation 1
    const r1 = searchMemory({ query: 'test' }, state, index)
    state = r1.state
    expect(state.operationCount).toBe(1)

    // Operation 2
    const r2 = readMemoryFile({ tier: 3, id: 'user-model' }, state)
    state = r2.state
    expect(state.operationCount).toBe(2)

    // Operation 3
    const r3 = searchMemory({ query: 'content' }, state, index)
    state = r3.state
    expect(state.operationCount).toBe(3)

    // Operation 4 should be blocked
    const r4 = searchMemory({ query: 'blocked' }, state, index)
    expect(r4.result.results).toEqual([])
    expect(r4.state.operationCount).toBe(3)
  })
})
