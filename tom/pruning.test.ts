import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { pruneOldSessions } from './pruning'

// --- Test Helpers ---

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tom-prune-test-'))
}

function createSessionLog(
  sessionId: string,
  startedAt: string
) {
  return {
    sessionId,
    startedAt,
    endedAt: '2026-02-02T23:00:00.000Z',
    interactions: [],
  }
}

function writeSession(
  tomDir: string,
  sessionId: string,
  startedAt: string
): void {
  const sessionsDir = path.join(tomDir, 'sessions')
  fs.mkdirSync(sessionsDir, { recursive: true })
  const filePath = path.join(sessionsDir, `${sessionId}.json`)
  fs.writeFileSync(filePath, JSON.stringify(createSessionLog(sessionId, startedAt)), 'utf-8')
}

function writeSessionModel(
  tomDir: string,
  sessionId: string
): void {
  const modelsDir = path.join(tomDir, 'session-models')
  fs.mkdirSync(modelsDir, { recursive: true })
  const filePath = path.join(modelsDir, `${sessionId}.json`)
  const model = {
    sessionId,
    intent: 'test intent',
    interactionPatterns: ['uses-Edit'],
    codingPreferences: [],
    satisfactionSignals: {
      frustration: false,
      satisfaction: true,
      urgency: 'low',
    },
  }
  fs.writeFileSync(filePath, JSON.stringify(model), 'utf-8')
}

describe('pruneOldSessions', () => {
  let originalHome: string | undefined
  let tempDir: string

  beforeEach(() => {
    originalHome = process.env['HOME']
    tempDir = createTempDir()
    process.env['HOME'] = tempDir
  })

  afterEach(() => {
    process.env['HOME'] = originalHome
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  function globalTomDir(): string {
    return path.join(tempDir, '.claude', 'tom')
  }

  it('returns empty result when no sessions exist', () => {
    const result = pruneOldSessions(100, 'global')

    expect(result.prunedSessionIds).toEqual([])
    expect(result.sessionsBeforePrune).toBe(0)
    expect(result.sessionsAfterPrune).toBe(0)
    expect(result.indexRebuilt).toBe(false)
  })

  it('does not prune when session count is below limit', () => {
    const tomDir = globalTomDir()
    writeSession(tomDir, 'session-1', '2026-01-01T10:00:00.000Z')
    writeSession(tomDir, 'session-2', '2026-01-02T10:00:00.000Z')
    writeSession(tomDir, 'session-3', '2026-01-03T10:00:00.000Z')

    const result = pruneOldSessions(5, 'global')

    expect(result.prunedSessionIds).toEqual([])
    expect(result.sessionsBeforePrune).toBe(3)
    expect(result.sessionsAfterPrune).toBe(3)
    expect(result.indexRebuilt).toBe(false)
  })

  it('does not prune when session count equals limit', () => {
    const tomDir = globalTomDir()
    writeSession(tomDir, 'session-1', '2026-01-01T10:00:00.000Z')
    writeSession(tomDir, 'session-2', '2026-01-02T10:00:00.000Z')

    const result = pruneOldSessions(2, 'global')

    expect(result.prunedSessionIds).toEqual([])
    expect(result.sessionsBeforePrune).toBe(2)
    expect(result.sessionsAfterPrune).toBe(2)
    expect(result.indexRebuilt).toBe(false)
  })

  it('prunes oldest sessions when count exceeds limit', () => {
    const tomDir = globalTomDir()
    writeSession(tomDir, 'session-old', '2026-01-01T10:00:00.000Z')
    writeSession(tomDir, 'session-mid', '2026-01-15T10:00:00.000Z')
    writeSession(tomDir, 'session-new', '2026-02-01T10:00:00.000Z')

    const result = pruneOldSessions(2, 'global')

    expect(result.prunedSessionIds).toEqual(['session-old'])
    expect(result.sessionsBeforePrune).toBe(3)
    expect(result.sessionsAfterPrune).toBe(2)
    expect(result.indexRebuilt).toBe(true)
  })

  it('deletes Tier 1 session files for pruned sessions', () => {
    const tomDir = globalTomDir()
    writeSession(tomDir, 'session-1', '2026-01-01T10:00:00.000Z')
    writeSession(tomDir, 'session-2', '2026-01-02T10:00:00.000Z')
    writeSession(tomDir, 'session-3', '2026-01-03T10:00:00.000Z')

    pruneOldSessions(1, 'global')

    const sessionsDir = path.join(tomDir, 'sessions')
    const remaining = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'))
    expect(remaining).toEqual(['session-3.json'])
  })

  it('deletes corresponding Tier 2 session models for pruned sessions', () => {
    const tomDir = globalTomDir()
    writeSession(tomDir, 'session-1', '2026-01-01T10:00:00.000Z')
    writeSession(tomDir, 'session-2', '2026-01-02T10:00:00.000Z')
    writeSession(tomDir, 'session-3', '2026-01-03T10:00:00.000Z')
    writeSessionModel(tomDir, 'session-1')
    writeSessionModel(tomDir, 'session-2')
    writeSessionModel(tomDir, 'session-3')

    pruneOldSessions(1, 'global')

    const modelsDir = path.join(tomDir, 'session-models')
    const remaining = fs.readdirSync(modelsDir).filter(f => f.endsWith('.json'))
    expect(remaining).toEqual(['session-3.json'])
  })

  it('rebuilds BM25 index after pruning', () => {
    const tomDir = globalTomDir()
    writeSession(tomDir, 'session-1', '2026-01-01T10:00:00.000Z')
    writeSession(tomDir, 'session-2', '2026-01-02T10:00:00.000Z')

    const result = pruneOldSessions(1, 'global')

    expect(result.indexRebuilt).toBe(true)
    const indexPath = path.join(tomDir, 'bm25-index.json')
    expect(fs.existsSync(indexPath)).toBe(true)

    const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))
    expect(index).toHaveProperty('documentCount')
  })

  it('prunes multiple sessions when significantly over limit', () => {
    const tomDir = globalTomDir()
    writeSession(tomDir, 'session-a', '2026-01-01T10:00:00.000Z')
    writeSession(tomDir, 'session-b', '2026-01-02T10:00:00.000Z')
    writeSession(tomDir, 'session-c', '2026-01-03T10:00:00.000Z')
    writeSession(tomDir, 'session-d', '2026-01-04T10:00:00.000Z')
    writeSession(tomDir, 'session-e', '2026-01-05T10:00:00.000Z')

    const result = pruneOldSessions(2, 'global')

    expect(result.prunedSessionIds).toHaveLength(3)
    expect(result.prunedSessionIds).toContain('session-a')
    expect(result.prunedSessionIds).toContain('session-b')
    expect(result.prunedSessionIds).toContain('session-c')
    expect(result.sessionsAfterPrune).toBe(2)
  })

  it('handles missing session model files gracefully', () => {
    const tomDir = globalTomDir()
    writeSession(tomDir, 'session-1', '2026-01-01T10:00:00.000Z')
    writeSession(tomDir, 'session-2', '2026-01-02T10:00:00.000Z')
    // No session model files created — should not throw

    const result = pruneOldSessions(1, 'global')

    expect(result.prunedSessionIds).toEqual(['session-1'])
    expect(result.sessionsAfterPrune).toBe(1)
  })

  it('keeps newest sessions when pruning', () => {
    const tomDir = globalTomDir()
    writeSession(tomDir, 'oldest', '2026-01-01T10:00:00.000Z')
    writeSession(tomDir, 'middle', '2026-01-15T10:00:00.000Z')
    writeSession(tomDir, 'newest', '2026-02-01T10:00:00.000Z')

    pruneOldSessions(2, 'global')

    const sessionsDir = path.join(tomDir, 'sessions')
    const remaining = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json')).sort()
    expect(remaining).toEqual(['middle.json', 'newest.json'])
  })

  it('returns immutable result (new PruneResult object)', () => {
    const tomDir = globalTomDir()
    writeSession(tomDir, 'session-1', '2026-01-01T10:00:00.000Z')
    writeSession(tomDir, 'session-2', '2026-01-02T10:00:00.000Z')

    const result1 = pruneOldSessions(1, 'global')
    const result2 = pruneOldSessions(100, 'global')

    expect(result1).not.toBe(result2)
    expect(result1.prunedSessionIds).toHaveLength(1)
    expect(result2.prunedSessionIds).toHaveLength(0)
  })

  it('works with maxSessionsRetained of 0', () => {
    const tomDir = globalTomDir()
    writeSession(tomDir, 'session-1', '2026-01-01T10:00:00.000Z')
    writeSession(tomDir, 'session-2', '2026-01-02T10:00:00.000Z')

    const result = pruneOldSessions(0, 'global')

    expect(result.prunedSessionIds).toHaveLength(2)
    expect(result.sessionsAfterPrune).toBe(0)
  })

  it('handles empty sessions directory', () => {
    const tomDir = globalTomDir()
    const sessionsDir = path.join(tomDir, 'sessions')
    fs.mkdirSync(sessionsDir, { recursive: true })

    const result = pruneOldSessions(5, 'global')

    expect(result.prunedSessionIds).toEqual([])
    expect(result.sessionsBeforePrune).toBe(0)
  })

  describe('stale temp sweep', () => {
    const TWO_HOURS_MS = 2 * 60 * 60 * 1000

    function writeTempFile(dir: string, name: string, ageMs: number): string {
      fs.mkdirSync(dir, { recursive: true })
      const filePath = path.join(dir, name)
      fs.writeFileSync(filePath, 'orphaned', 'utf-8')
      const when = new Date(Date.now() - ageMs)
      fs.utimesSync(filePath, when, when)
      return filePath
    }

    it('removes stale *.tmp files across the tom dir and its subdirs', () => {
      const tomDir = globalTomDir()
      const a = writeTempFile(tomDir, 'user-model.json.123.0.abcd.tmp', TWO_HOURS_MS)
      const b = writeTempFile(path.join(tomDir, 'sessions'), 's1.json.9.1.ef01.tmp', TWO_HOURS_MS)
      const c = writeTempFile(path.join(tomDir, 'session-models'), 's2.json.9.2.ef02.tmp', TWO_HOURS_MS)
      const d = writeTempFile(path.join(tomDir, 'user-model-history'), 's3.json.9.3.ef03.tmp', TWO_HOURS_MS)

      const result = pruneOldSessions(5, 'global')

      expect(result.staleTempFilesRemoved).toBe(4)
      for (const f of [a, b, c, d]) expect(fs.existsSync(f)).toBe(false)
    })

    it('leaves recent *.tmp files (an in-flight write) untouched', () => {
      const tomDir = globalTomDir()
      const fresh = writeTempFile(tomDir, 'bm25-index.json.123.0.dead.tmp', 1000)

      const result = pruneOldSessions(5, 'global')

      expect(result.staleTempFilesRemoved).toBe(0)
      expect(fs.existsSync(fresh)).toBe(true)
    })

    it('never touches non-temp files', () => {
      const tomDir = globalTomDir()
      const real = writeTempFile(tomDir, 'user-model.json', TWO_HOURS_MS)

      const result = pruneOldSessions(5, 'global')

      expect(result.staleTempFilesRemoved).toBe(0)
      expect(fs.existsSync(real)).toBe(true)
    })

    it('sweeps even when no sessions are pruned', () => {
      const tomDir = globalTomDir()
      writeSession(tomDir, 'session-1', '2026-02-01T00:00:00.000Z')
      const stale = writeTempFile(tomDir, 'config.json.5.0.beef.tmp', TWO_HOURS_MS)

      const result = pruneOldSessions(5, 'global')

      expect(result.indexRebuilt).toBe(false)
      expect(result.staleTempFilesRemoved).toBe(1)
      expect(fs.existsSync(stale)).toBe(false)
    })
  })
})
