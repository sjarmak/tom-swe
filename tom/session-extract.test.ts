import { describe, it, expect } from 'vitest'
import { extractSessionModel } from './session-extract'
import type { Interaction, SessionLog } from './schemas'

// --- Test Helpers ---

function createSessionLog(
  sessionId: string,
  interactions: readonly Interaction[] = []
): SessionLog {
  return {
    sessionId,
    startedAt: '2026-02-02T10:00:00.000Z',
    endedAt: '2026-02-02T11:00:00.000Z',
    interactions: [...interactions],
  }
}

function createInteraction(
  toolName: string,
  parameterShape: Record<string, string> = {},
  outcomeSummary: string = 'success'
): Interaction {
  return {
    toolName,
    parameterShape,
    outcomeSummary,
    timestamp: '2026-02-02T10:30:00.000Z',
  }
}

describe('extractSessionModel', () => {
  it('extracts intent from most-used tool', () => {
    const log = createSessionLog('session-1', [
      createInteraction('Edit', {}, 'success'),
      createInteraction('Edit', {}, 'success'),
      createInteraction('Read', {}, 'success'),
    ])
    const model = extractSessionModel(log)
    expect(model.sessionId).toBe('session-1')
    expect(model.intent).toBe('brief code modification')
  })

  it('never emits interaction patterns (heuristics cannot detect them reliably)', () => {
    const log = createSessionLog('session-2', [
      createInteraction('Edit', {}, 'success'),
      createInteraction('Grep', {}, 'success'),
      createInteraction('Read', {}, 'success'),
    ])
    const model = extractSessionModel(log)
    expect(model.interactionPatterns).toEqual([])
  })

  it('never emits "uses-<Tool>" speculation even with many tools', () => {
    const log = createSessionLog('session-2b', [
      createInteraction('Edit', {}, 'success'),
      createInteraction('Grep', {}, 'success'),
      createInteraction('Read', {}, 'success'),
      createInteraction('Bash', {}, 'success'),
      createInteraction('Glob', {}, 'success'),
      createInteraction('Task', {}, 'success'),
    ])
    const model = extractSessionModel(log)
    expect(model.interactionPatterns).toEqual([])
    expect(model.interactionPatterns.some((p) => p.startsWith('uses-'))).toBe(false)
  })

  it('never emits coding preferences, even when file_path params are present', () => {
    const log = createSessionLog('session-8', [
      createInteraction('Edit', { file_path: 'src/app.ts' }, 'success'),
      createInteraction('Edit', { file_path: 'src/utils.ts', language: 'typescript' }, 'success'),
    ])
    const model = extractSessionModel(log)
    expect(model.codingPreferences).toEqual([])
    // No raw file path leaks into the returned model.
    expect(model.codingPreferences.some((p) => p.includes('src/'))).toBe(false)
  })

  it('handles empty session log', () => {
    const log = createSessionLog('empty-session', [])
    const model = extractSessionModel(log)
    expect(model.sessionId).toBe('empty-session')
    expect(model.intent).toBe('brief unknown usage')
    expect(model.interactionPatterns).toEqual([])
    expect(model.codingPreferences).toEqual([])
  })

  it('never extracts corrections (heuristics cannot detect them reliably)', () => {
    const log = createSessionLog('no-corrections', [
      createInteraction('Edit', { file_path: 'src/app.ts' }, 'error: failed'),
      createInteraction('Edit', { file_path: 'src/app.ts' }, 'success'),
    ])
    const model = extractSessionModel(log)
    expect(model.corrections).toEqual([])
  })

  it('returns a new object (immutable)', () => {
    const log = createSessionLog('immutable-test', [
      createInteraction('Edit', {}, 'success'),
    ])
    const model1 = extractSessionModel(log)
    const model2 = extractSessionModel(log)
    expect(model1).not.toBe(model2)
    expect(model1).toEqual(model2)
  })
})
