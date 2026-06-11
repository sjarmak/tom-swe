import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import {
  getModelForOperation,
  logUsage,
  readUsageLog,
  TELEMETRY_SCHEMA_VERSION,
} from './routing.js'

describe('routing', () => {
  let tmpDir: string
  let originalHome: string | undefined

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tom-routing-test-'))
    originalHome = process.env['HOME']
    process.env['HOME'] = tmpDir
  })

  afterEach(() => {
    process.env['HOME'] = originalHome
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('getModelForOperation', () => {
    it('returns default haiku for memoryUpdate when no config', () => {
      const result = getModelForOperation('memoryUpdate')
      expect(result).toBe('haiku')
    })

    it('returns default sonnet for consultation when no config', () => {
      const result = getModelForOperation('consultation')
      expect(result).toBe('sonnet')
    })

    it('returns default sonnet for profileInit when no config', () => {
      const result = getModelForOperation('profileInit')
      expect(result).toBe('sonnet')
    })

    it('reads memoryUpdate model from config.json', () => {
      const tomDir = path.join(tmpDir, '.claude', 'tom')
      fs.mkdirSync(tomDir, { recursive: true })
      fs.writeFileSync(
        path.join(tomDir, 'config.json'),
        JSON.stringify({ models: { memoryUpdate: 'opus' } }),
        'utf-8'
      )

      const result = getModelForOperation('memoryUpdate')
      expect(result).toBe('opus')
    })

    it('reads consultation model from config.json', () => {
      const tomDir = path.join(tmpDir, '.claude', 'tom')
      fs.mkdirSync(tomDir, { recursive: true })
      fs.writeFileSync(
        path.join(tomDir, 'config.json'),
        JSON.stringify({ models: { consultation: 'opus' } }),
        'utf-8'
      )

      const result = getModelForOperation('consultation')
      expect(result).toBe('opus')
    })

    it('reads profileInit from consultation config (shares config key)', () => {
      const tomDir = path.join(tmpDir, '.claude', 'tom')
      fs.mkdirSync(tomDir, { recursive: true })
      fs.writeFileSync(
        path.join(tomDir, 'config.json'),
        JSON.stringify({ models: { consultation: 'opus' } }),
        'utf-8'
      )

      const result = getModelForOperation('profileInit')
      expect(result).toBe('opus')
    })

    it('returns default when config has no models key', () => {
      const tomDir = path.join(tmpDir, '.claude', 'tom')
      fs.mkdirSync(tomDir, { recursive: true })
      fs.writeFileSync(
        path.join(tomDir, 'config.json'),
        JSON.stringify({ enabled: true }),
        'utf-8'
      )

      const result = getModelForOperation('memoryUpdate')
      expect(result).toBe('haiku')
    })

    it('returns default when model value is not a string', () => {
      const tomDir = path.join(tmpDir, '.claude', 'tom')
      fs.mkdirSync(tomDir, { recursive: true })
      fs.writeFileSync(
        path.join(tomDir, 'config.json'),
        JSON.stringify({ models: { memoryUpdate: 123 } }),
        'utf-8'
      )

      const result = getModelForOperation('memoryUpdate')
      expect(result).toBe('haiku')
    })

    it('returns default when config file is invalid JSON', () => {
      const tomDir = path.join(tmpDir, '.claude', 'tom')
      fs.mkdirSync(tomDir, { recursive: true })
      fs.writeFileSync(
        path.join(tomDir, 'config.json'),
        'not json',
        'utf-8'
      )

      const result = getModelForOperation('memoryUpdate')
      expect(result).toBe('haiku')
    })

    it('returns default when settings file does not exist', () => {
      const result = getModelForOperation('consultation')
      expect(result).toBe('sonnet')
    })
  })

  describe('logUsage', () => {
    it('appends a JSON line to usage.log', () => {
      const tomDir = path.join(tmpDir, '.claude', 'tom')
      fs.mkdirSync(tomDir, { recursive: true })

      logUsage({
        timestamp: '2026-01-15T10:00:00.000Z',
        operation: 'session-analysis',
        model: 'haiku',
        tokenCount: 150,
      })

      const logPath = path.join(tomDir, 'usage.log')
      const content = fs.readFileSync(logPath, 'utf-8')
      const parsed = JSON.parse(content.trim()) as Record<string, unknown>

      expect(parsed['timestamp']).toBe('2026-01-15T10:00:00.000Z')
      expect(parsed['operation']).toBe('session-analysis')
      expect(parsed['model']).toBe('haiku')
      expect(parsed['tokenCount']).toBe(150)
    })

    it('stamps the telemetry schema version on every entry', () => {
      logUsage({
        timestamp: '2026-01-15T10:00:00.000Z',
        operation: 'session-analysis',
        model: 'haiku',
        tokenCount: 150,
      })

      const logPath = path.join(tmpDir, '.claude', 'tom', 'usage.log')
      const parsed = JSON.parse(
        fs.readFileSync(logPath, 'utf-8').trim()
      ) as Record<string, unknown>
      expect(parsed['v']).toBe(TELEMETRY_SCHEMA_VERSION)
    })

    it('preserves durationMs and structured detail fields', () => {
      logUsage({
        timestamp: '2026-01-15T10:00:00.000Z',
        operation: 'prompt-hook',
        model: 'none',
        tokenCount: 0,
        durationMs: 42,
        detail: { consulted: true, promptChars: 17 },
      })

      const logPath = path.join(tmpDir, '.claude', 'tom', 'usage.log')
      const parsed = JSON.parse(
        fs.readFileSync(logPath, 'utf-8').trim()
      ) as Record<string, unknown>
      expect(parsed['durationMs']).toBe(42)
      expect(parsed['detail']).toEqual({ consulted: true, promptChars: 17 })
    })

    it('creates directories if they do not exist', () => {
      logUsage({
        timestamp: '2026-01-15T10:00:00.000Z',
        operation: 'consultation',
        model: 'sonnet',
        tokenCount: 200,
      })

      const logPath = path.join(tmpDir, '.claude', 'tom', 'usage.log')
      expect(fs.existsSync(logPath)).toBe(true)
    })

    it('appends multiple entries as separate lines', () => {
      logUsage({
        timestamp: '2026-01-15T10:00:00.000Z',
        operation: 'consultation',
        model: 'sonnet',
        tokenCount: 100,
      })

      logUsage({
        timestamp: '2026-01-15T11:00:00.000Z',
        operation: 'session-analysis',
        model: 'haiku',
        tokenCount: 200,
      })

      const logPath = path.join(tmpDir, '.claude', 'tom', 'usage.log')
      const content = fs.readFileSync(logPath, 'utf-8')
      const lines = content.trim().split('\n')

      expect(lines).toHaveLength(2)

      const first = JSON.parse(lines[0] ?? '') as Record<string, unknown>
      const second = JSON.parse(lines[1] ?? '') as Record<string, unknown>

      expect(first['operation']).toBe('consultation')
      expect(second['operation']).toBe('session-analysis')
    })

    it('records optional sessionId and reason fields when provided', () => {
      logUsage({
        timestamp: '2026-01-15T10:00:00.000Z',
        operation: 'session-analysis-fallback',
        model: 'none',
        tokenCount: 0,
        sessionId: 'session-42',
        reason: 'timeout: claude did not respond',
      })

      const logPath = path.join(tmpDir, '.claude', 'tom', 'usage.log')
      const content = fs.readFileSync(logPath, 'utf-8')
      const parsed = JSON.parse(content.trim()) as Record<string, unknown>

      expect(parsed['sessionId']).toBe('session-42')
      expect(parsed['reason']).toBe('timeout: claude did not respond')
    })

    it('includes all required fields in log entry', () => {
      logUsage({
        timestamp: '2026-01-15T10:00:00.000Z',
        operation: 'profile-init',
        model: 'sonnet',
        tokenCount: 500,
      })

      const logPath = path.join(tmpDir, '.claude', 'tom', 'usage.log')
      const content = fs.readFileSync(logPath, 'utf-8')
      const parsed = JSON.parse(content.trim()) as Record<string, unknown>

      expect(Object.keys(parsed)).toEqual(
        expect.arrayContaining(['timestamp', 'operation', 'model', 'tokenCount'])
      )
    })
  })

  describe('readUsageLog', () => {
    it('returns empty results when the log does not exist', () => {
      const result = readUsageLog()
      expect(result.entries).toEqual([])
      expect(result.invalidLines).toBe(0)
    })

    it('round-trips entries written by logUsage', () => {
      logUsage({
        timestamp: '2026-01-15T10:00:00.000Z',
        operation: 'prompt-hook',
        model: 'none',
        tokenCount: 0,
        durationMs: 12,
        detail: { consulted: false },
      })
      logUsage({
        timestamp: '2026-01-15T11:00:00.000Z',
        operation: 'session-analysis',
        model: 'haiku',
        tokenCount: 900,
      })

      const result = readUsageLog()
      expect(result.entries).toHaveLength(2)
      expect(result.invalidLines).toBe(0)
      expect(result.entries[0]?.operation).toBe('prompt-hook')
      expect(result.entries[0]?.detail).toEqual({ consulted: false })
      expect(result.entries[1]?.tokenCount).toBe(900)
    })

    it('counts malformed and schema-invalid lines instead of dropping them silently', () => {
      logUsage({
        timestamp: '2026-01-15T10:00:00.000Z',
        operation: 'prompt-hook',
        model: 'none',
        tokenCount: 0,
      })
      const logPath = path.join(tmpDir, '.claude', 'tom', 'usage.log')
      fs.appendFileSync(logPath, 'not json at all\n', 'utf-8')
      fs.appendFileSync(logPath, JSON.stringify({ operation: 42 }) + '\n', 'utf-8')

      const result = readUsageLog()
      expect(result.entries).toHaveLength(1)
      expect(result.invalidLines).toBe(2)
    })
  })
})
