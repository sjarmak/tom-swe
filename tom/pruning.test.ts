import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { pruneOldSessions } from './pruning'

// --- Test Helpers ---

const HOURS = 60 * 60 * 1000
const DAYS = 24 * HOURS

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tom-prune-test-'))
}

function setMtime(filePath: string, ageMs: number): void {
  const when = new Date(Date.now() - ageMs)
  fs.utimesSync(filePath, when, when)
}

function createSessionLog(sessionId: string) {
  return {
    sessionId,
    startedAt: '2026-02-02T22:00:00.000Z',
    endedAt: '2026-02-02T23:00:00.000Z',
    interactions: [],
  }
}

/** Writes a Tier 1 log whose last activity (mtime) is ageMs in the past. */
function writeSession(tomDir: string, sessionId: string, ageMs: number): string {
  const sessionsDir = path.join(tomDir, 'sessions')
  fs.mkdirSync(sessionsDir, { recursive: true })
  const filePath = path.join(sessionsDir, `${sessionId}.json`)
  fs.writeFileSync(filePath, JSON.stringify(createSessionLog(sessionId)), 'utf-8')
  setMtime(filePath, ageMs)
  return filePath
}

/** Writes a schema-valid Tier 2 model; endedAt omitted when undefined. */
function writeSessionModel(
  tomDir: string,
  sessionId: string,
  endedAt?: string,
  mtimeAgeMs: number = 0
): string {
  const modelsDir = path.join(tomDir, 'session-models')
  fs.mkdirSync(modelsDir, { recursive: true })
  const filePath = path.join(modelsDir, `${sessionId}.json`)
  const model = {
    sessionId,
    intent: 'test intent',
    interactionPatterns: [{ key: 'tool_usage', value: 'edit-heavy' }],
    codingPreferences: [],
    ...(endedAt !== undefined ? { endedAt } : {}),
  }
  fs.writeFileSync(filePath, JSON.stringify(model), 'utf-8')
  setMtime(filePath, mtimeAgeMs)
  return filePath
}

function writeSnapshot(tomDir: string, sessionId: string): string {
  const historyDir = path.join(tomDir, 'user-model-history')
  fs.mkdirSync(historyDir, { recursive: true })
  const filePath = path.join(historyDir, `${sessionId}.json`)
  fs.writeFileSync(filePath, '{}', 'utf-8')
  return filePath
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAYS).toISOString()
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
    const result = pruneOldSessions(100, 'global', 30)

    expect(result.prunedSessionIds).toEqual([])
    expect(result.expiredModelIds).toEqual([])
    expect(result.sessionsBeforePrune).toBe(0)
    expect(result.sessionsAfterPrune).toBe(0)
  })

  it('does not prune when session count is at or below limit', () => {
    const tomDir = globalTomDir()
    writeSession(tomDir, 'session-1', 30 * HOURS)
    writeSession(tomDir, 'session-2', 20 * HOURS)
    writeSession(tomDir, 'session-3', 10 * HOURS)

    const below = pruneOldSessions(5, 'global', 30)
    expect(below.prunedSessionIds).toEqual([])
    expect(below.sessionsAfterPrune).toBe(3)

    const equal = pruneOldSessions(3, 'global', 30)
    expect(equal.prunedSessionIds).toEqual([])
    expect(equal.sessionsAfterPrune).toBe(3)
  })

  it('prunes sessions with the oldest activity when count exceeds limit', () => {
    const tomDir = globalTomDir()
    writeSession(tomDir, 'session-old', 72 * HOURS)
    writeSession(tomDir, 'session-mid', 48 * HOURS)
    writeSession(tomDir, 'session-new', 10 * HOURS)

    const result = pruneOldSessions(2, 'global', 30)

    expect(result.prunedSessionIds).toEqual(['session-old'])
    expect(result.sessionsBeforePrune).toBe(3)
    expect(result.sessionsAfterPrune).toBe(2)

    const sessionsDir = path.join(tomDir, 'sessions')
    const remaining = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json')).sort()
    expect(remaining).toEqual(['session-mid.json', 'session-new.json'])
  })

  it('orders by last activity, not file creation order', () => {
    const tomDir = globalTomDir()
    // Written first but touched most recently — must survive.
    writeSession(tomDir, 'written-first', 5 * HOURS)
    writeSession(tomDir, 'written-mid', 80 * HOURS)
    writeSession(tomDir, 'written-last', 60 * HOURS)

    pruneOldSessions(2, 'global', 30)

    const sessionsDir = path.join(tomDir, 'sessions')
    const remaining = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json')).sort()
    expect(remaining).toEqual(['written-first.json', 'written-last.json'])
  })

  it('counts a fresher capture sidecar as session activity', () => {
    const tomDir = globalTomDir()
    // Log file looks ancient, but its sidecar shows recent capture activity.
    writeSession(tomDir, 'sidecar-active', 90 * HOURS)
    const sidecarPath = path.join(tomDir, 'sessions', 'sidecar-active.jsonl')
    fs.writeFileSync(sidecarPath, '{}\n', 'utf-8')
    setMtime(sidecarPath, 3 * HOURS)
    writeSession(tomDir, 'genuinely-old', 50 * HOURS)
    writeSession(tomDir, 'fresh', 4 * HOURS)

    const result = pruneOldSessions(2, 'global', 30)

    expect(result.prunedSessionIds).toEqual(['genuinely-old'])
    expect(fs.existsSync(path.join(tomDir, 'sessions', 'sidecar-active.json'))).toBe(true)
  })

  it('never prunes a session active within the guard window, even over cap', () => {
    const tomDir = globalTomDir()
    // All three active within the last 2h; cap of 1 must still prune nothing.
    writeSession(tomDir, 'live-1', 90 * 60 * 1000)
    writeSession(tomDir, 'live-2', 60 * 60 * 1000)
    writeSession(tomDir, 'live-3', 10 * 60 * 1000)

    const result = pruneOldSessions(1, 'global', 30)

    expect(result.prunedSessionIds).toEqual([])
    expect(result.sessionsAfterPrune).toBe(3)
  })

  it('deletes the capture sidecar alongside a pruned log', () => {
    const tomDir = globalTomDir()
    writeSession(tomDir, 'with-sidecar', 80 * HOURS)
    const sidecarPath = path.join(tomDir, 'sessions', 'with-sidecar.jsonl')
    fs.writeFileSync(sidecarPath, '{}\n', 'utf-8')
    setMtime(sidecarPath, 80 * HOURS)
    writeSession(tomDir, 'kept', 5 * HOURS)

    pruneOldSessions(1, 'global', 30)

    expect(fs.existsSync(path.join(tomDir, 'sessions', 'with-sidecar.json'))).toBe(false)
    expect(fs.existsSync(sidecarPath)).toBe(false)
  })

  it('retains Tier 2 models and snapshots when their Tier 1 log is pruned', () => {
    // The regression this file exists for: deleting models with their logs
    // collapsed the memory horizon to the Tier 1 window (174/180 models lost).
    const tomDir = globalTomDir()
    writeSession(tomDir, 'evicted', 80 * HOURS)
    writeSession(tomDir, 'kept', 5 * HOURS)
    writeSessionModel(tomDir, 'evicted', isoDaysAgo(3))
    const snapshotPath = writeSnapshot(tomDir, 'evicted')

    const result = pruneOldSessions(1, 'global', 30)

    expect(result.prunedSessionIds).toEqual(['evicted'])
    expect(result.expiredModelIds).toEqual([])
    expect(fs.existsSync(path.join(tomDir, 'session-models', 'evicted.json'))).toBe(true)
    expect(fs.existsSync(snapshotPath)).toBe(true)
  })

  it('expires Tier 2 models (and their snapshots) older than the retention window', () => {
    const tomDir = globalTomDir()
    writeSessionModel(tomDir, 'stale', isoDaysAgo(45))
    writeSessionModel(tomDir, 'fresh', isoDaysAgo(5))
    const staleSnapshot = writeSnapshot(tomDir, 'stale')
    const freshSnapshot = writeSnapshot(tomDir, 'fresh')

    const result = pruneOldSessions(100, 'global', 30)

    expect(result.expiredModelIds).toEqual(['stale'])
    expect(fs.existsSync(path.join(tomDir, 'session-models', 'stale.json'))).toBe(false)
    expect(fs.existsSync(staleSnapshot)).toBe(false)
    expect(fs.existsSync(path.join(tomDir, 'session-models', 'fresh.json'))).toBe(true)
    expect(fs.existsSync(freshSnapshot)).toBe(true)
  })

  it('expires undated models by file mtime fallback', () => {
    const tomDir = globalTomDir()
    writeSessionModel(tomDir, 'undated-old', undefined, 45 * DAYS)
    writeSessionModel(tomDir, 'undated-fresh', undefined, 5 * DAYS)

    const result = pruneOldSessions(100, 'global', 30)

    expect(result.expiredModelIds).toEqual(['undated-old'])
    expect(fs.existsSync(path.join(tomDir, 'session-models', 'undated-old.json'))).toBe(false)
    expect(fs.existsSync(path.join(tomDir, 'session-models', 'undated-fresh.json'))).toBe(true)
  })

  it('prunes multiple sessions when significantly over limit', () => {
    const tomDir = globalTomDir()
    writeSession(tomDir, 'session-a', 90 * HOURS)
    writeSession(tomDir, 'session-b', 80 * HOURS)
    writeSession(tomDir, 'session-c', 70 * HOURS)
    writeSession(tomDir, 'session-d', 60 * HOURS)
    writeSession(tomDir, 'session-e', 5 * HOURS)

    const result = pruneOldSessions(2, 'global', 30)

    expect(result.prunedSessionIds).toEqual(['session-a', 'session-b', 'session-c'])
    expect(result.sessionsAfterPrune).toBe(2)
  })

  describe('time-keyed Tier 1 expiry', () => {
    it('expires a Tier 1 log older than the retention window even under the count cap', () => {
      const tomDir = globalTomDir()
      // Well under the count cap (100), but its last activity predates the
      // 30-day retention window — its raw content should not outlive the
      // window in which its evidence matters.
      writeSession(tomDir, 'ancient', 40 * DAYS)
      writeSession(tomDir, 'recent', 3 * HOURS)

      const result = pruneOldSessions(100, 'global', 30)

      expect(result.prunedSessionIds).toEqual(['ancient'])
      expect(result.sessionsAfterPrune).toBe(1)
      const sessionsDir = path.join(tomDir, 'sessions')
      expect(fs.existsSync(path.join(sessionsDir, 'ancient.json'))).toBe(false)
      expect(fs.existsSync(path.join(sessionsDir, 'recent.json'))).toBe(true)
    })

    it('keeps a log within the retention window when under the count cap', () => {
      const tomDir = globalTomDir()
      writeSession(tomDir, 'within-window', 20 * DAYS)

      const result = pruneOldSessions(100, 'global', 30)

      expect(result.prunedSessionIds).toEqual([])
      expect(result.sessionsAfterPrune).toBe(1)
    })

    it('deletes each session once when both over the cap and past the window', () => {
      const tomDir = globalTomDir()
      // Two ancient logs (past the window) plus a fresh one; cap of 1.
      // Both ancient logs are count-cap victims AND time-expired — each
      // must appear once, not twice, in the result.
      writeSession(tomDir, 'old-a', 50 * DAYS)
      writeSession(tomDir, 'old-b', 45 * DAYS)
      writeSession(tomDir, 'fresh', 2 * HOURS)

      const result = pruneOldSessions(1, 'global', 30)

      // Ascending last-activity order: the 50-day log precedes the 45-day one.
      expect(result.prunedSessionIds).toEqual(['old-a', 'old-b'])
      expect(result.sessionsAfterPrune).toBe(1)
    })

    it('does not time-expire when the retention window is not exceeded', () => {
      const tomDir = globalTomDir()
      // 10-day-old logs under a 30-day window and under the cap: kept.
      writeSession(tomDir, 's1', 10 * DAYS)
      writeSession(tomDir, 's2', 12 * DAYS)

      const result = pruneOldSessions(100, 'global', 30)

      expect(result.prunedSessionIds).toEqual([])
    })
  })

  it('handles missing session model files gracefully', () => {
    const tomDir = globalTomDir()
    writeSession(tomDir, 'session-1', 80 * HOURS)
    writeSession(tomDir, 'session-2', 5 * HOURS)
    // No session model files created — should not throw

    const result = pruneOldSessions(1, 'global', 30)

    expect(result.prunedSessionIds).toEqual(['session-1'])
    expect(result.sessionsAfterPrune).toBe(1)
  })

  it('returns immutable result (new PruneResult object)', () => {
    const tomDir = globalTomDir()
    writeSession(tomDir, 'session-1', 80 * HOURS)
    writeSession(tomDir, 'session-2', 5 * HOURS)

    const result1 = pruneOldSessions(1, 'global', 30)
    const result2 = pruneOldSessions(100, 'global', 30)

    expect(result1).not.toBe(result2)
    expect(result1.prunedSessionIds).toHaveLength(1)
    expect(result2.prunedSessionIds).toHaveLength(0)
  })

  it('works with maxSessionsRetained of 0', () => {
    const tomDir = globalTomDir()
    writeSession(tomDir, 'session-1', 80 * HOURS)
    writeSession(tomDir, 'session-2', 70 * HOURS)

    const result = pruneOldSessions(0, 'global', 30)

    expect(result.prunedSessionIds).toHaveLength(2)
    expect(result.sessionsAfterPrune).toBe(0)
  })

  it('handles empty sessions directory', () => {
    const tomDir = globalTomDir()
    fs.mkdirSync(path.join(tomDir, 'sessions'), { recursive: true })

    const result = pruneOldSessions(5, 'global', 30)

    expect(result.prunedSessionIds).toEqual([])
    expect(result.sessionsBeforePrune).toBe(0)
  })

  describe('stale temp and lock sweep', () => {
    const TWO_HOURS_MS = 2 * HOURS

    function writeAgedFile(dir: string, name: string, ageMs: number): string {
      fs.mkdirSync(dir, { recursive: true })
      const filePath = path.join(dir, name)
      fs.writeFileSync(filePath, 'orphaned', 'utf-8')
      setMtime(filePath, ageMs)
      return filePath
    }

    it('removes stale *.tmp files across the tom dir and its subdirs', () => {
      const tomDir = globalTomDir()
      const a = writeAgedFile(tomDir, 'user-model.json.123.0.abcd.tmp', TWO_HOURS_MS)
      const b = writeAgedFile(path.join(tomDir, 'sessions'), 's1.json.9.1.ef01.tmp', TWO_HOURS_MS)
      const c = writeAgedFile(path.join(tomDir, 'session-models'), 's2.json.9.2.ef02.tmp', TWO_HOURS_MS)
      const d = writeAgedFile(path.join(tomDir, 'user-model-history'), 's3.json.9.3.ef03.tmp', TWO_HOURS_MS)

      const result = pruneOldSessions(5, 'global', 30)

      expect(result.staleTempFilesRemoved).toBe(4)
      for (const f of [a, b, c, d]) expect(fs.existsSync(f)).toBe(false)
    })

    it('leaves recent *.tmp files (an in-flight write) untouched', () => {
      const tomDir = globalTomDir()
      const fresh = writeAgedFile(tomDir, 'bm25-index.json.123.0.dead.tmp', 1000)

      const result = pruneOldSessions(5, 'global', 30)

      expect(result.staleTempFilesRemoved).toBe(0)
      expect(fs.existsSync(fresh)).toBe(true)
    })

    it('removes orphaned analysis locks but keeps fresh ones', () => {
      const tomDir = globalTomDir()
      const modelsDir = path.join(tomDir, 'session-models')
      const orphaned = writeAgedFile(modelsDir, 'dead-session.lock', 20 * 60 * 1000)
      const live = writeAgedFile(modelsDir, 'live-session.lock', 30 * 1000)

      const result = pruneOldSessions(5, 'global', 30)

      expect(result.staleTempFilesRemoved).toBe(1)
      expect(fs.existsSync(orphaned)).toBe(false)
      expect(fs.existsSync(live)).toBe(true)
    })

    it('never touches non-temp files', () => {
      const tomDir = globalTomDir()
      const real = writeAgedFile(tomDir, 'user-model.json', TWO_HOURS_MS)

      const result = pruneOldSessions(5, 'global', 30)

      expect(result.staleTempFilesRemoved).toBe(0)
      expect(fs.existsSync(real)).toBe(true)
    })

    it('sweeps even when no sessions are pruned', () => {
      const tomDir = globalTomDir()
      writeSession(tomDir, 'session-1', 5 * HOURS)
      const stale = writeAgedFile(tomDir, 'config.json.5.0.beef.tmp', TWO_HOURS_MS)

      const result = pruneOldSessions(5, 'global', 30)

      expect(result.staleTempFilesRemoved).toBe(1)
      expect(fs.existsSync(stale)).toBe(false)
    })
  })
})
