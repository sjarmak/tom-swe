import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import { rebuildUserModelFromTier2, carryPromotedFlags } from './rebuild'
import type { SessionModel, UserModel } from './schemas'

let tempDir: string
let originalHome: string | undefined

function writeTier2(model: SessionModel): void {
  const dir = path.join(tempDir, '.claude', 'tom', 'session-models')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${model.sessionId}.json`),
    JSON.stringify(model),
    'utf-8'
  )
}

function sessionModel(
  sessionId: string,
  endedAt: string,
  prefs: ReadonlyArray<{ key: string; value: string }> = []
): SessionModel {
  return {
    sessionId,
    intent: 'test',
    interactionPatterns: [],
    codingPreferences: [...prefs],
    satisfactionSignals: { frustration: false, satisfaction: true, urgency: 'low' },
    corrections: [],
    endedAt,
  }
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tom-rebuild-test-'))
  originalHome = process.env['HOME']
  process.env['HOME'] = tempDir
})

afterEach(() => {
  process.env['HOME'] = originalHome
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('rebuildUserModelFromTier2', () => {
  it('is idempotent: re-analyzing a session replaces its contribution instead of stacking', () => {
    // The pre-rebuild bug: Stop fires per turn-end, so the same session
    // re-reinforced its preferences every turn (observed 9 analyses across
    // 4 sessions in dogfooding). Under rebuild, the model depends only on
    // the Tier 2 SET — rebuilding twice changes nothing.
    writeTier2(sessionModel('s1', '2026-06-10T10:00:00.000Z', [{ key: 'test_runner', value: 'vitest' }]))
    writeTier2(sessionModel('s2', '2026-06-10T11:00:00.000Z', [{ key: 'test_runner', value: 'vitest' }]))

    const first = rebuildUserModelFromTier2('global', 30, 0.5, null)
    const second = rebuildUserModelFromTier2('global', 30, 0.5, first)

    const pref1 = first.preferencesClusters.find((p) => p.key === 'test_runner')
    const pref2 = second.preferencesClusters.find((p) => p.key === 'test_runner')
    expect(pref1?.sessionCount).toBe(2)
    expect(pref2?.sessionCount).toBe(2)
    expect(pref2?.confidence).toBeCloseTo(pref1?.confidence ?? 0)

    // Overwriting one session's Tier 2 (re-analysis) keeps counts stable.
    writeTier2(sessionModel('s2', '2026-06-10T11:05:00.000Z', [{ key: 'test_runner', value: 'vitest' }]))
    const third = rebuildUserModelFromTier2('global', 30, 0.5, second)
    expect(third.preferencesClusters.find((p) => p.key === 'test_runner')?.sessionCount).toBe(2)
  })

  it('grounds decay in inter-session gaps via endedAt', () => {
    // One observation 90 days ago: at a 30-day half-life it should arrive
    // heavily decayed relative to a fresh observation.
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
    const fresh = new Date().toISOString()
    writeTier2(sessionModel('old', old, [{ key: 'old_style', value: 'tabs' }]))
    writeTier2(sessionModel('new', fresh, [{ key: 'new_style', value: 'spaces' }]))

    const model = rebuildUserModelFromTier2('global', 30, 0.5, null)
    const oldPref = model.preferencesClusters.find((p) => p.key === 'old_style')
    const newPref = model.preferencesClusters.find((p) => p.key === 'new_style')

    expect(newPref?.confidence).toBeCloseTo(0.1)
    // 0.1 * 2^(-90/30) = 0.0125
    expect(oldPref?.confidence ?? 0).toBeLessThan(0.02)
  })

  it('carries style summaries from the previous model and tolerates an empty store', () => {
    const previous: UserModel = {
      preferencesClusters: [],
      interactionStyleSummary: 'prefers concise',
      codingStyleSummary: 'typescript focused',
      projectOverrides: {},
    }
    const rebuilt = rebuildUserModelFromTier2('global', 30, 0.5, previous)
    expect(rebuilt.preferencesClusters).toEqual([])
    expect(rebuilt.interactionStyleSummary).toBe('prefers concise')
    expect(rebuilt.codingStyleSummary).toBe('typescript focused')
  })

  it('folds undated models at the earliest dated endedAt, never amplifying confidence', () => {
    // Anti-decay overflow regression: an undated (pre-v0.3.1) model used to
    // fold at wall-clock "now" — later than every dated session's endedAt —
    // so later folds computed negative day gaps and a decay factor > 1,
    // compounding confidence past 1.0 and failing write validation.
    const dated = '2026-06-10T10:00:00.000Z'
    const undated: SessionModel = {
      sessionId: 'legacy',
      intent: 'test',
      interactionPatterns: [],
      codingPreferences: [
        { key: 'shared_pref', value: 'v' },
        { key: 'legacy_only', value: 'w' },
      ],
    }
    writeTier2(undated)
    writeTier2(sessionModel('dated', dated, [{ key: 'shared_pref', value: 'v' }]))

    const model = rebuildUserModelFromTier2('global', 30, 0.5, null)

    for (const cluster of model.preferencesClusters) {
      expect(cluster.confidence).toBeLessThanOrEqual(1)
    }
    // Two reinforcements with a zero-day gap: exactly 0.1 + 0.1.
    const shared = model.preferencesClusters.find((p) => p.key === 'shared_pref')
    expect(shared?.confidence).toBeCloseTo(0.2)
    // The undated fold is pinned to the earliest dated endedAt, not wall clock.
    const legacyOnly = model.preferencesClusters.find((p) => p.key === 'legacy_only')
    expect(legacyOnly?.lastUpdated).toBe(dated)
  })

  it('skips unreadable Tier 2 files instead of failing the rebuild', () => {
    writeTier2(sessionModel('good', '2026-06-10T10:00:00.000Z', [{ key: 'k', value: 'v' }]))
    const dir = path.join(tempDir, '.claude', 'tom', 'session-models')
    fs.writeFileSync(path.join(dir, 'bad.json'), 'not json', 'utf-8')

    const model = rebuildUserModelFromTier2('global', 30, 0.5, null)
    expect(model.preferencesClusters.find((p) => p.key === 'k')).toBeDefined()
  })
})

describe('carryPromotedFlags', () => {
  it('carries persisted gate rejections onto matching rebuilt clusters', () => {
    const previous: UserModel = {
      preferencesClusters: [
        {
          category: 'codingPreferences',
          key: 'test_runner',
          value: 'vitest',
          confidence: 0.9,
          lastUpdated: '2026-06-01T00:00:00.000Z',
          sessionCount: 9,
          gateRejectedValue: 'vitest',
          gateRejectedAt: '2026-06-20T00:00:00.000Z',
        },
      ],
      interactionStyleSummary: '',
      codingStyleSummary: '',
      projectOverrides: {},
    }
    const rebuilt: UserModel = {
      ...previous,
      preferencesClusters: [
        {
          category: 'codingPreferences',
          key: 'test_runner',
          value: 'vitest',
          confidence: 0.85,
          lastUpdated: '2026-06-25T00:00:00.000Z',
          sessionCount: 10,
        },
      ],
    }

    const carried = carryPromotedFlags(rebuilt, previous)

    const pref = carried.preferencesClusters[0]
    expect(pref?.gateRejectedValue).toBe('vitest')
    expect(pref?.gateRejectedAt).toBe('2026-06-20T00:00:00.000Z')
  })

  it('restores promoted flags onto matching rebuilt clusters', () => {
    const previous: UserModel = {
      preferencesClusters: [
        {
          category: 'codingPreferences',
          key: 'test_runner',
          value: 'vitest',
          confidence: 0.9,
          lastUpdated: '2026-06-01T00:00:00.000Z',
          sessionCount: 9,
          promoted: true,
        },
      ],
      interactionStyleSummary: '',
      codingStyleSummary: '',
      projectOverrides: {},
    }
    const rebuilt: UserModel = {
      ...previous,
      preferencesClusters: [
        { ...previous.preferencesClusters[0]!, promoted: undefined },
        {
          category: 'codingPreferences',
          key: 'other',
          value: 'x',
          confidence: 0.5,
          lastUpdated: '2026-06-01T00:00:00.000Z',
          sessionCount: 3,
        },
      ],
    }

    const result = carryPromotedFlags(rebuilt, previous)
    expect(result.preferencesClusters.find((p) => p.key === 'test_runner')?.promoted).toBe(true)
    expect(result.preferencesClusters.find((p) => p.key === 'other')?.promoted).toBeUndefined()
  })
})
