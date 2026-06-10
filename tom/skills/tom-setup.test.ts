import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { setup, formatSetupResult } from './tom-setup'

describe('setup', () => {
  let originalHome: string | undefined
  let tempDir: string

  beforeEach(() => {
    originalHome = process.env['HOME']
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tom-setup-test-'))
    process.env['HOME'] = tempDir
  })

  afterEach(() => {
    process.env['HOME'] = originalHome
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('creates config.json with defaults when missing', () => {
    const result = setup()

    expect(result.created).toBe(true)
    expect(result.alreadyExists).toBe(false)
    expect(result.error).toBeUndefined()

    const configPath = path.join(tempDir, '.claude', 'tom', 'config.json')
    expect(result.configPath).toBe(configPath)
    expect(fs.existsSync(configPath)).toBe(true)

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    expect(config.enabled).toBe(true)
    expect(config.consultThreshold).toBe('medium')
    expect(config.models).toEqual({ memoryUpdate: 'haiku', consultation: 'sonnet' })
    expect(config.preferenceDecayDays).toBe(30)
    expect(config.maxSessionsRetained).toBe(100)
  })

  it('does not overwrite an existing config', () => {
    const tomDir = path.join(tempDir, '.claude', 'tom')
    fs.mkdirSync(tomDir, { recursive: true })
    const configPath = path.join(tomDir, 'config.json')
    fs.writeFileSync(configPath, JSON.stringify({ enabled: false }), 'utf-8')

    const result = setup()

    expect(result.created).toBe(false)
    expect(result.alreadyExists).toBe(true)

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    expect(config).toEqual({ enabled: false })
  })

  it('does not touch ~/.claude/settings.json (hooks come from the plugin)', () => {
    setup()

    const settingsPath = path.join(tempDir, '.claude', 'settings.json')
    expect(fs.existsSync(settingsPath)).toBe(false)
  })

  it('returns an error result when the config cannot be written', () => {
    // Make ~/.claude/tom an unwritable *file* so mkdir/write fails
    const claudeDir = path.join(tempDir, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.writeFileSync(path.join(claudeDir, 'tom'), 'not a directory', 'utf-8')

    const result = setup()

    expect(result.created).toBe(false)
    expect(result.alreadyExists).toBe(false)
    expect(result.error).toBeDefined()
  })
})

describe('formatSetupResult', () => {
  it('formats a created result with default settings and hook note', () => {
    const output = formatSetupResult({
      created: true,
      alreadyExists: false,
      configPath: '/home/user/.claude/tom/config.json',
    })

    expect(output).toContain('# ToM Setup')
    expect(output).toContain('Created config at `/home/user/.claude/tom/config.json`.')
    expect(output).toContain('Consult threshold: medium')
    expect(output).toContain('Memory update model: haiku')
    expect(output).toContain('Consultation model: sonnet')
    expect(output).toContain('registered automatically by the plugin')
  })

  it('formats an already-exists result', () => {
    const output = formatSetupResult({
      created: false,
      alreadyExists: true,
      configPath: '/home/user/.claude/tom/config.json',
    })

    expect(output).toContain('Config already exists')
    expect(output).toContain('/tom-status')
  })

  it('formats an error result', () => {
    const output = formatSetupResult({
      created: false,
      alreadyExists: false,
      configPath: '/home/user/.claude/tom/config.json',
      error: 'EACCES: permission denied',
    })

    expect(output).toContain('Failed to create config: EACCES: permission denied')
  })
})
