import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import { TomConfigSchema, readTomConfig, isTomEnabled } from './config.js'

// --- Test Helpers ---

let tempDir: string
let originalHome: string | undefined

function setupTempHome(): void {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tom-config-test-'))
  originalHome = process.env['HOME']
  process.env['HOME'] = tempDir
}

function teardownTempHome(): void {
  process.env['HOME'] = originalHome
  fs.rmSync(tempDir, { recursive: true, force: true })
}

function writeSettings(tom: unknown): void {
  const claudeDir = path.join(tempDir, '.claude')
  fs.mkdirSync(claudeDir, { recursive: true })
  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({ tom }),
    'utf-8'
  )
}

// --- Schema Tests ---

describe('TomConfigSchema', () => {
  it('should parse empty object with all defaults', () => {
    const result = TomConfigSchema.parse({})
    expect(result).toEqual({
      enabled: false,
      consultThreshold: 'medium',
      models: {
        memoryUpdate: 'haiku',
        consultation: 'sonnet',
      },
      preferenceDecayDays: 30,
      maxSessionsRetained: 100,
    })
  })

  it('should parse full config', () => {
    const input = {
      enabled: true,
      consultThreshold: 'high',
      models: {
        memoryUpdate: 'sonnet',
        consultation: 'opus',
      },
      preferenceDecayDays: 60,
      maxSessionsRetained: 200,
    }
    const result = TomConfigSchema.parse(input)
    expect(result).toEqual(input)
  })

  it('should parse partial config with defaults filling in', () => {
    const result = TomConfigSchema.parse({
      enabled: true,
    })
    expect(result.enabled).toBe(true)
    expect(result.consultThreshold).toBe('medium')
    expect(result.models.memoryUpdate).toBe('haiku')
    expect(result.models.consultation).toBe('sonnet')
    expect(result.preferenceDecayDays).toBe(30)
    expect(result.maxSessionsRetained).toBe(100)
  })

  it('should accept all valid threshold values', () => {
    for (const threshold of ['low', 'medium', 'high'] as const) {
      const result = TomConfigSchema.parse({ consultThreshold: threshold })
      expect(result.consultThreshold).toBe(threshold)
    }
  })

  it('should reject invalid threshold values', () => {
    expect(() => TomConfigSchema.parse({ consultThreshold: 'extreme' })).toThrow()
  })

  it('should reject extra fields in strict mode', () => {
    expect(() =>
      TomConfigSchema.parse({ enabled: true, unknownField: 'value' })
    ).toThrow()
  })

  it('should parse partial models with defaults', () => {
    const result = TomConfigSchema.parse({
      models: { memoryUpdate: 'opus' },
    })
    expect(result.models.memoryUpdate).toBe('opus')
    expect(result.models.consultation).toBe('sonnet')
  })
})

// --- readTomConfig Tests ---

describe('readTomConfig', () => {
  beforeEach(setupTempHome)
  afterEach(teardownTempHome)

  it('should return defaults when settings file does not exist', () => {
    const config = readTomConfig()
    expect(config.enabled).toBe(false)
    expect(config.consultThreshold).toBe('medium')
    expect(config.models.memoryUpdate).toBe('haiku')
    expect(config.models.consultation).toBe('sonnet')
    expect(config.preferenceDecayDays).toBe(30)
    expect(config.maxSessionsRetained).toBe(100)
  })

  it('should return defaults when settings file has no tom key', () => {
    const claudeDir = path.join(tempDir, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({ otherKey: true }),
      'utf-8'
    )
    const config = readTomConfig()
    expect(config.enabled).toBe(false)
  })

  it('should return defaults when settings file has invalid JSON', () => {
    const claudeDir = path.join(tempDir, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      'not json!!!',
      'utf-8'
    )
    const config = readTomConfig()
    expect(config.enabled).toBe(false)
  })

  it('should read full config from settings.json', () => {
    writeSettings({
      enabled: true,
      consultThreshold: 'high',
      models: { memoryUpdate: 'sonnet', consultation: 'opus' },
      preferenceDecayDays: 14,
      maxSessionsRetained: 50,
    })
    const config = readTomConfig()
    expect(config.enabled).toBe(true)
    expect(config.consultThreshold).toBe('high')
    expect(config.models.memoryUpdate).toBe('sonnet')
    expect(config.models.consultation).toBe('opus')
    expect(config.preferenceDecayDays).toBe(14)
    expect(config.maxSessionsRetained).toBe(50)
  })

  it('should apply defaults for missing fields', () => {
    writeSettings({ enabled: true })
    const config = readTomConfig()
    expect(config.enabled).toBe(true)
    expect(config.consultThreshold).toBe('medium')
    expect(config.models.memoryUpdate).toBe('haiku')
    expect(config.preferenceDecayDays).toBe(30)
    expect(config.maxSessionsRetained).toBe(100)
  })

  it('should return defaults when tom key fails validation', () => {
    writeSettings({
      enabled: true,
      consultThreshold: 'invalid_threshold',
    })
    const config = readTomConfig()
    // Falls back to all defaults since validation fails
    expect(config.enabled).toBe(false)
    expect(config.consultThreshold).toBe('medium')
  })

  it('should return defaults when tom is null', () => {
    writeSettings(null)
    const config = readTomConfig()
    expect(config.enabled).toBe(false)
  })
})

// --- isTomEnabled Tests ---

describe('isTomEnabled', () => {
  beforeEach(setupTempHome)
  afterEach(teardownTempHome)

  it('should return false when no settings file exists', () => {
    expect(isTomEnabled()).toBe(false)
  })

  it('should return false when tom.enabled is false', () => {
    writeSettings({ enabled: false })
    expect(isTomEnabled()).toBe(false)
  })

  it('should return true when tom.enabled is true', () => {
    writeSettings({ enabled: true })
    expect(isTomEnabled()).toBe(true)
  })

  it('should return false when tom.enabled is not a boolean', () => {
    writeSettings({ enabled: 'yes' })
    // 'yes' is not boolean, validation fails, returns defaults (enabled=false)
    expect(isTomEnabled()).toBe(false)
  })
})
