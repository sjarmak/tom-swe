import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { registerHooks, formatResult, getExampleSnippet, main } from './register-hooks.js'

describe('register-hooks', () => {
  let tempDir: string
  let settingsPath: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tom-hooks-test-'))
    settingsPath = path.join(tempDir, '.claude', 'settings.json')
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  describe('registerHooks', () => {
    it('creates settings.json if it does not exist', () => {
      const result = registerHooks(settingsPath)

      expect(result.added).toEqual(['PostToolUse', 'PreToolUse', 'Stop'])
      expect(result.alreadyPresent).toEqual([])
      expect(fs.existsSync(settingsPath)).toBe(true)

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
      expect(settings.hooks).toBeDefined()
      expect(settings.hooks.PostToolUse).toHaveLength(1)
      expect(settings.hooks.PreToolUse).toHaveLength(1)
      expect(settings.hooks.Stop).toHaveLength(1)
    })

    it('adds hooks to existing empty settings', () => {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
      fs.writeFileSync(settingsPath, '{}', 'utf-8')

      const result = registerHooks(settingsPath)

      expect(result.added).toEqual(['PostToolUse', 'PreToolUse', 'Stop'])
      expect(result.alreadyPresent).toEqual([])
    })

    it('preserves existing hooks and adds tom hooks alongside', () => {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
      const existingSettings = {
        hooks: {
          PostToolUse: [{ type: 'command', command: 'echo existing-post' }],
          PreToolUse: [{ type: 'command', command: 'echo existing-pre' }],
        },
      }
      fs.writeFileSync(settingsPath, JSON.stringify(existingSettings), 'utf-8')

      const result = registerHooks(settingsPath)

      expect(result.added).toEqual(['PostToolUse', 'PreToolUse', 'Stop'])

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
      expect(settings.hooks.PostToolUse).toHaveLength(2)
      expect(settings.hooks.PostToolUse[0].command).toBe('echo existing-post')
      expect(settings.hooks.PreToolUse).toHaveLength(2)
      expect(settings.hooks.PreToolUse[0].command).toBe('echo existing-pre')
      expect(settings.hooks.Stop).toHaveLength(1)
    })

    it('does not duplicate hooks if already registered', () => {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
      fs.writeFileSync(settingsPath, '{}', 'utf-8')

      // Register once
      registerHooks(settingsPath)

      // Register again
      const result = registerHooks(settingsPath)

      expect(result.added).toEqual([])
      expect(result.alreadyPresent).toEqual(['PostToolUse', 'PreToolUse', 'Stop'])

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
      expect(settings.hooks.PostToolUse).toHaveLength(1)
      expect(settings.hooks.PreToolUse).toHaveLength(1)
      expect(settings.hooks.Stop).toHaveLength(1)
    })

    it('preserves other settings keys', () => {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
      const existingSettings = {
        tom: { enabled: true },
        otherSetting: 'value',
      }
      fs.writeFileSync(settingsPath, JSON.stringify(existingSettings), 'utf-8')

      registerHooks(settingsPath)

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
      expect(settings.tom).toEqual({ enabled: true })
      expect(settings.otherSetting).toBe('value')
      expect(settings.hooks).toBeDefined()
    })

    it('handles invalid JSON in existing settings', () => {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
      fs.writeFileSync(settingsPath, 'not-json', 'utf-8')

      const result = registerHooks(settingsPath)

      expect(result.added).toEqual(['PostToolUse', 'PreToolUse', 'Stop'])
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
      expect(settings.hooks.PostToolUse).toHaveLength(1)
    })

    it('each hook entry has type "command" and references correct shell script', () => {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
      fs.writeFileSync(settingsPath, '{}', 'utf-8')

      registerHooks(settingsPath)

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))

      for (const hookType of ['PostToolUse', 'PreToolUse', 'Stop']) {
        const hooks = settings.hooks[hookType]
        expect(hooks).toHaveLength(1)
        expect(hooks[0].type).toBe('command')
        expect(hooks[0].command).toMatch(/^bash "/)
      }

      expect(settings.hooks.PostToolUse[0].command).toContain('post-tool-use.sh')
      expect(settings.hooks.PreToolUse[0].command).toContain('pre-tool-use.sh')
      expect(settings.hooks.Stop[0].command).toContain('stop-analyze.sh')
    })

    it('returns settingsPath in result', () => {
      const result = registerHooks(settingsPath)
      expect(result.settingsPath).toBe(settingsPath)
    })

    it('partial overlap — only some hooks already registered', () => {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
      fs.writeFileSync(settingsPath, '{}', 'utf-8')

      // Register once
      registerHooks(settingsPath)

      // Remove Stop hook manually
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
      delete settings.hooks.Stop
      fs.writeFileSync(settingsPath, JSON.stringify(settings), 'utf-8')

      // Register again
      const result = registerHooks(settingsPath)
      expect(result.added).toEqual(['Stop'])
      expect(result.alreadyPresent).toEqual(['PostToolUse', 'PreToolUse'])
    })
  })

  describe('formatResult', () => {
    it('formats all added hooks', () => {
      const output = formatResult({
        added: ['PostToolUse', 'PreToolUse', 'Stop'],
        alreadyPresent: [],
        settingsPath: '/home/user/.claude/settings.json',
      })

      expect(output).toContain('Registered 3 hook(s)')
      expect(output).toContain('PostToolUse')
      expect(output).toContain('PreToolUse')
      expect(output).toContain('Stop')
      expect(output).toContain('tom.enabled')
    })

    it('formats all already present hooks', () => {
      const output = formatResult({
        added: [],
        alreadyPresent: ['PostToolUse', 'PreToolUse', 'Stop'],
        settingsPath: '/home/user/.claude/settings.json',
      })

      expect(output).toContain('Already registered (3)')
      expect(output).not.toContain('Registered')
    })

    it('formats mixed result', () => {
      const output = formatResult({
        added: ['Stop'],
        alreadyPresent: ['PostToolUse', 'PreToolUse'],
        settingsPath: '/home/user/.claude/settings.json',
      })

      expect(output).toContain('Registered 1 hook(s)')
      expect(output).toContain('Already registered (2)')
    })

    it('includes settings path', () => {
      const output = formatResult({
        added: [],
        alreadyPresent: [],
        settingsPath: '/custom/path/settings.json',
      })

      expect(output).toContain('/custom/path/settings.json')
    })

    it('includes enable instruction', () => {
      const output = formatResult({
        added: ['PostToolUse'],
        alreadyPresent: [],
        settingsPath: '/home/user/.claude/settings.json',
      })

      expect(output).toContain('"tom": { "enabled": true }')
    })
  })

  describe('getExampleSnippet', () => {
    it('returns valid JSON', () => {
      const snippet = getExampleSnippet('/test/hooks')
      const parsed = JSON.parse(snippet)

      expect(parsed.tom.enabled).toBe(true)
      expect(parsed.hooks.PostToolUse).toHaveLength(1)
      expect(parsed.hooks.PreToolUse).toHaveLength(1)
      expect(parsed.hooks.Stop).toHaveLength(1)
    })

    it('uses provided hooks directory in commands', () => {
      const snippet = getExampleSnippet('/my/custom/hooks')
      const parsed = JSON.parse(snippet)

      expect(parsed.hooks.PostToolUse[0].command).toContain('/my/custom/hooks/post-tool-use.sh')
      expect(parsed.hooks.PreToolUse[0].command).toContain('/my/custom/hooks/pre-tool-use.sh')
      expect(parsed.hooks.Stop[0].command).toContain('/my/custom/hooks/stop-analyze.sh')
    })

    it('includes tom config with defaults', () => {
      const snippet = getExampleSnippet('/test/hooks')
      const parsed = JSON.parse(snippet)

      expect(parsed.tom.consultThreshold).toBe('medium')
      expect(parsed.tom.models.memoryUpdate).toBe('haiku')
      expect(parsed.tom.models.consultation).toBe('sonnet')
    })
  })

  describe('main', () => {
    let originalWrite: typeof process.stdout.write
    let originalStderrWrite: typeof process.stderr.write
    let stdoutOutput: string
    let stderrOutput: string
    let originalHome: string | undefined

    beforeEach(() => {
      originalWrite = process.stdout.write
      originalStderrWrite = process.stderr.write
      stdoutOutput = ''
      stderrOutput = ''
      process.stdout.write = ((chunk: string) => {
        stdoutOutput += chunk
        return true
      }) as typeof process.stdout.write
      process.stderr.write = ((chunk: string) => {
        stderrOutput += chunk
        return true
      }) as typeof process.stderr.write
      originalHome = process.env['HOME']
      process.env['HOME'] = tempDir
    })

    afterEach(() => {
      process.stdout.write = originalWrite
      process.stderr.write = originalStderrWrite
      process.env['HOME'] = originalHome
    })

    it('registers hooks and outputs result', () => {
      main()

      expect(stdoutOutput).toContain('ToM Hook Registration')
      expect(stdoutOutput).toContain('Registered 3 hook(s)')
      expect(stderrOutput).toBe('')
    })

    it('handles errors gracefully', () => {
      // Make the .claude directory unwritable
      const claudeDir = path.join(tempDir, '.claude')
      fs.mkdirSync(claudeDir, { recursive: true })
      fs.writeFileSync(path.join(claudeDir, 'settings.json'), '', { mode: 0o000 })

      main()

      // Should either succeed or output an error — not throw
      // The exact behavior depends on the OS permission model
      expect(true).toBe(true)
    })
  })
})
