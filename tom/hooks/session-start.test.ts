import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { Readable } from 'node:stream'
import { buildModelSummary, buildHookOutput, main } from './session-start'
import type { UserModel, PreferenceCluster } from '../schemas'

// --- Test Helpers ---

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tom-session-start-test-'))
}

function pref(
  key: string,
  value: string,
  confidence: number,
  category: string = 'codingPreferences'
): PreferenceCluster {
  return {
    category,
    key,
    value,
    confidence,
    lastUpdated: '2026-06-01T10:00:00.000Z',
    sessionCount: 3,
  }
}

function createUserModel(overrides: Partial<UserModel> = {}): UserModel {
  return {
    preferencesClusters: [],
    interactionStyleSummary: '',
    codingStyleSummary: '',
    projectOverrides: {},
    ...overrides,
  }
}

function payloadStream(payload: Record<string, unknown>): Readable {
  return Readable.from([JSON.stringify(payload)])
}

// --- buildModelSummary ---

describe('buildModelSummary', () => {
  it('returns null for an empty model', () => {
    expect(buildModelSummary(createUserModel())).toBeNull()
  })

  it('lists preferences with confidence >= 0.5, highest first', () => {
    const model = createUserModel({
      preferencesClusters: [
        pref('testing', 'vitest', 0.6),
        pref('language', 'typescript', 0.9),
      ],
    })

    const summary = buildModelSummary(model)
    expect(summary).not.toBeNull()
    const lines = (summary ?? '').split('\n')
    expect(lines[0]).toContain('ToM user preferences')
    expect(lines[1]).toBe('- codingPreferences/language: typescript (90%)')
    expect(lines[2]).toBe('- codingPreferences/testing: vitest (60%)')
  })

  it('omits preferences below the 0.5 confidence floor', () => {
    const model = createUserModel({
      preferencesClusters: [
        pref('language', 'typescript', 0.9),
        pref('framework', 'react', 0.3),
      ],
    })

    const summary = buildModelSummary(model) ?? ''
    expect(summary).toContain('typescript')
    expect(summary).not.toContain('react')
  })

  it('returns null when all preferences are low-confidence and no summaries exist', () => {
    const model = createUserModel({
      preferencesClusters: [pref('framework', 'react', 0.2)],
    })
    expect(buildModelSummary(model)).toBeNull()
  })

  it('caps preference lines so the summary stays compact (~10 lines)', () => {
    const manyPrefs = Array.from({ length: 20 }, (_, i) =>
      pref(`key-${i}`, `value-${i}`, 0.9)
    )
    const model = createUserModel({
      preferencesClusters: manyPrefs,
      interactionStyleSummary: 'prefers concise replies',
      codingStyleSummary: 'typescript focused',
    })

    const lines = (buildModelSummary(model) ?? '').split('\n')
    expect(lines.length).toBeLessThanOrEqual(10)
  })

  it('excludes promoted preferences from the injected summary', () => {
    const promotedPref = { ...pref('testing', 'vitest', 0.95), promoted: true }
    const model = createUserModel({
      preferencesClusters: [
        promotedPref,
        pref('language', 'typescript', 0.9),
      ],
    })

    const summary = buildModelSummary(model) ?? ''
    // The promoted preference already rides along via CLAUDE.md
    expect(summary).not.toContain('vitest')
    expect(summary).toContain('typescript')
  })

  it('returns null when every confident preference is promoted and no summaries exist', () => {
    const model = createUserModel({
      preferencesClusters: [
        { ...pref('testing', 'vitest', 0.95), promoted: true },
      ],
    })
    expect(buildModelSummary(model)).toBeNull()
  })

  it('includes interaction and coding style summaries when present', () => {
    const model = createUserModel({
      interactionStyleSummary: 'prefers concise replies',
      codingStyleSummary: 'typescript focused',
    })

    const summary = buildModelSummary(model) ?? ''
    expect(summary).toContain('Interaction style: prefers concise replies')
    expect(summary).toContain('Coding style: typescript focused')
  })
})

// --- buildHookOutput ---

describe('buildHookOutput', () => {
  it('produces the documented SessionStart hookSpecificOutput shape', () => {
    const output = buildHookOutput('summary text')
    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'summary text',
      },
    })
  })
})

// --- main ---

describe('main', () => {
  let originalHome: string | undefined
  let originalCwd: string
  let originalInternal: string | undefined
  let tempDir: string
  let stdoutData: string

  function enableTom(): void {
    const tomDir = path.join(tempDir, '.claude', 'tom')
    fs.mkdirSync(tomDir, { recursive: true })
    fs.writeFileSync(
      path.join(tomDir, 'config.json'),
      JSON.stringify({ enabled: true }),
      'utf-8'
    )
  }

  function writeUserModel(model: UserModel): void {
    const tomDir = path.join(tempDir, '.claude', 'tom')
    fs.mkdirSync(tomDir, { recursive: true })
    fs.writeFileSync(
      path.join(tomDir, 'user-model.json'),
      JSON.stringify(model),
      'utf-8'
    )
  }

  beforeEach(() => {
    originalHome = process.env['HOME']
    originalCwd = process.cwd()
    originalInternal = process.env['TOM_SWE_INTERNAL']
    tempDir = createTempDir()
    process.env['HOME'] = tempDir
    process.chdir(tempDir)
    delete process.env['TOM_SWE_INTERNAL']
    stdoutData = ''
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Buffer) => {
      stdoutData += typeof chunk === 'string' ? chunk : chunk.toString()
      return true
    }) as typeof process.stdout.write
    ;(process.stdout as any).__originalWrite = originalWrite
  })

  afterEach(() => {
    process.env['HOME'] = originalHome
    process.chdir(originalCwd)
    if (originalInternal !== undefined) {
      process.env['TOM_SWE_INTERNAL'] = originalInternal
    } else {
      delete process.env['TOM_SWE_INTERNAL']
    }
    if ((process.stdout as any).__originalWrite) {
      process.stdout.write = (process.stdout as any).__originalWrite
      delete (process.stdout as any).__originalWrite
    }
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('is silent when tom is not enabled', async () => {
    writeUserModel(createUserModel({
      preferencesClusters: [pref('language', 'typescript', 0.9)],
    }))

    await main(payloadStream({ session_id: 's1', hook_event_name: 'SessionStart', source: 'startup' }))
    expect(stdoutData).toBe('')
  })

  it('is silent when TOM_SWE_INTERNAL is "1"', async () => {
    enableTom()
    process.env['TOM_SWE_INTERNAL'] = '1'
    writeUserModel(createUserModel({
      preferencesClusters: [pref('language', 'typescript', 0.9)],
    }))

    await main(payloadStream({ session_id: 's1', hook_event_name: 'SessionStart' }))
    expect(stdoutData).toBe('')
  })

  it('is silent when no user model exists', async () => {
    enableTom()

    await main(payloadStream({ session_id: 's1', hook_event_name: 'SessionStart' }))
    expect(stdoutData).toBe('')
  })

  it('is silent when the model has nothing confident to report', async () => {
    enableTom()
    writeUserModel(createUserModel({
      preferencesClusters: [pref('framework', 'react', 0.2)],
    }))

    await main(payloadStream({ session_id: 's1', hook_event_name: 'SessionStart' }))
    expect(stdoutData).toBe('')
  })

  it('emits the SessionStart hookSpecificOutput JSON when a model exists', async () => {
    enableTom()
    writeUserModel(createUserModel({
      preferencesClusters: [pref('language', 'typescript', 0.9)],
      interactionStyleSummary: 'prefers concise replies',
      codingStyleSummary: 'typescript focused',
    }))

    await main(payloadStream({ session_id: 's1', hook_event_name: 'SessionStart', source: 'startup' }))

    const output = JSON.parse(stdoutData)
    expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart')
    expect(output.hookSpecificOutput.additionalContext).toContain(
      'codingPreferences/language: typescript (90%)'
    )
    expect(output.hookSpecificOutput.additionalContext).toContain(
      'Interaction style: prefers concise replies'
    )
    expect(Object.keys(output)).toEqual(['hookSpecificOutput'])
  })

  it('works on empty stdin (payload fields are not required)', async () => {
    enableTom()
    writeUserModel(createUserModel({
      preferencesClusters: [pref('language', 'typescript', 0.9)],
    }))

    await main(Readable.from(['']))

    const output = JSON.parse(stdoutData)
    expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart')
  })
})
