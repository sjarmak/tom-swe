import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}))

import { spawnSync } from 'node:child_process'
import { judgeDerivability, buildGatePrompt } from './promotion-gate'
import type { GateCandidate } from './promotion-gate'

const mockSpawnSync = vi.mocked(spawnSync)

const CANDIDATES: GateCandidate[] = [
  { id: 'codingPreferences::testRunner::vitest', statement: '- Prefers vitest' },
  { id: 'codingPreferences::deploy::canary', statement: '- Prefers canary deploys' },
]

function cliResult(resultText: string): ReturnType<typeof spawnSync> {
  return {
    status: 0,
    stdout: JSON.stringify({ result: resultText, session_id: 's' }),
    stderr: '',
    pid: 1,
    output: [],
    signal: null,
  } as unknown as ReturnType<typeof spawnSync>
}

beforeEach(() => {
  mockSpawnSync.mockReset()
})

describe('buildGatePrompt', () => {
  it('lists candidates with ids and demands a JSON-array-only answer', () => {
    const prompt = buildGatePrompt(CANDIDATES)
    expect(prompt).toContain('codingPreferences::testRunner::vitest')
    expect(prompt).toContain('NOT derivable')
    expect(prompt).toContain('JSON array')
  })
})

describe('judgeDerivability', () => {
  it('returns the empty set without spawning for no candidates', () => {
    const result = judgeDerivability([], '/repo', 'haiku')
    expect(result).toEqual(new Set())
    expect(mockSpawnSync).not.toHaveBeenCalled()
  })

  it('spawns claude read-only in the project dir with the internal guard', () => {
    mockSpawnSync.mockReturnValue(cliResult('[]'))
    judgeDerivability(CANDIDATES, '/repo', 'haiku')

    const call = mockSpawnSync.mock.calls[0] ?? []
    const args = (call[1] ?? []) as string[]
    const opts = (call[2] ?? {}) as { cwd?: string; env?: Record<string, string> }
    expect(call[0]).toBe('claude')
    expect(args[args.indexOf('--model') + 1]).toBe('haiku')
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read,Glob,Grep')
    expect(opts.cwd).toBe('/repo')
    expect(opts.env?.['TOM_SWE_INTERNAL']).toBe('1')
  })

  it('returns the passing ids, tolerating prose around the JSON array', () => {
    mockSpawnSync.mockReturnValue(
      cliResult('After inspecting the repo: ["codingPreferences::deploy::canary"] is the answer.')
    )
    const result = judgeDerivability(CANDIDATES, '/repo', 'haiku')
    expect(result).toEqual(new Set(['codingPreferences::deploy::canary']))
  })

  it('drops hallucinated ids that were never candidates', () => {
    mockSpawnSync.mockReturnValue(
      cliResult('["codingPreferences::deploy::canary", "made::up::id"]')
    )
    const result = judgeDerivability(CANDIDATES, '/repo', 'haiku')
    expect(result).toEqual(new Set(['codingPreferences::deploy::canary']))
  })

  it('returns null on spawn failure, non-zero exit, or unparseable output', () => {
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'boom',
      pid: 1,
      output: [],
      signal: null,
    } as unknown as ReturnType<typeof spawnSync>)
    expect(judgeDerivability(CANDIDATES, '/repo', 'haiku')).toBeNull()

    mockSpawnSync.mockReturnValue(cliResult('no json array here'))
    expect(judgeDerivability(CANDIDATES, '/repo', 'haiku')).toBeNull()
  })
})
