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

  it('extracts interaction patterns from top tools', () => {
    const log = createSessionLog('session-2', [
      createInteraction('Edit', {}, 'success'),
      createInteraction('Grep', {}, 'success'),
      createInteraction('Read', {}, 'success'),
    ])
    const model = extractSessionModel(log)
    expect(model.interactionPatterns).toContain('uses-Edit')
    expect(model.interactionPatterns).toContain('uses-Grep')
    expect(model.interactionPatterns).toContain('uses-Read')
  })

  it('detects frustration from error outcomes', () => {
    const interactions = Array.from({ length: 10 }, (_, i) =>
      createInteraction('Bash', {}, i < 4 ? 'error: command failed' : 'success')
    )
    const log = createSessionLog('session-3', interactions)
    const model = extractSessionModel(log)
    expect(model.satisfactionSignals.frustration).toBe(true)
  })

  it('detects satisfaction from success outcomes', () => {
    const interactions = Array.from({ length: 10 }, () =>
      createInteraction('Edit', {}, 'success: completed')
    )
    const log = createSessionLog('session-4', interactions)
    const model = extractSessionModel(log)
    expect(model.satisfactionSignals.satisfaction).toBe(true)
  })

  it('sets urgency based on interaction count', () => {
    const fewInteractions = Array.from({ length: 5 }, () =>
      createInteraction('Read', {}, 'success')
    )
    const log1 = createSessionLog('session-5', fewInteractions)
    expect(extractSessionModel(log1).satisfactionSignals.urgency).toBe('low')

    const mediumInteractions = Array.from({ length: 15 }, () =>
      createInteraction('Read', {}, 'success')
    )
    const log2 = createSessionLog('session-6', mediumInteractions)
    expect(extractSessionModel(log2).satisfactionSignals.urgency).toBe('medium')

    const manyInteractions = Array.from({ length: 25 }, () =>
      createInteraction('Read', {}, 'success')
    )
    const log3 = createSessionLog('session-7', manyInteractions)
    expect(extractSessionModel(log3).satisfactionSignals.urgency).toBe('high')
  })

  it('extracts coding preferences from file_path parameters', () => {
    const log = createSessionLog('session-8', [
      createInteraction('Edit', { file_path: 'src/app.ts' }, 'success'),
      createInteraction('Edit', { file_path: 'src/utils.ts' }, 'success'),
    ])
    const model = extractSessionModel(log)
    expect(model.codingPreferences).toContain('src/app.ts')
    expect(model.codingPreferences).toContain('src/utils.ts')
  })

  it('handles empty session log', () => {
    const log = createSessionLog('empty-session', [])
    const model = extractSessionModel(log)
    expect(model.sessionId).toBe('empty-session')
    expect(model.intent).toBe('brief unknown usage')
    expect(model.interactionPatterns).toEqual([])
    expect(model.codingPreferences).toEqual([])
    expect(model.satisfactionSignals.frustration).toBe(false)
    expect(model.satisfactionSignals.satisfaction).toBe(false)
    expect(model.satisfactionSignals.urgency).toBe('low')
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
