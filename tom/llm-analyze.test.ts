import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'

import {
  analyzeSessionWithLlm,
  parseAnalysisOutput,
  buildAnalysisPrompt,
  LLM_ANALYSIS_TIMEOUT_MS,
} from './llm-analyze'
import type { SessionLog, SessionModel } from './schemas'

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))

const mockSpawn = vi.mocked(spawn)

// --- Test Helpers ---

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly kill = vi.fn(() => true)
}

function makeSessionLog(sessionId = 'llm-test-session'): SessionLog {
  return {
    sessionId,
    startedAt: '2026-06-10T10:00:00.000Z',
    endedAt: '2026-06-10T11:00:00.000Z',
    interactions: [
      {
        toolName: 'Edit',
        parameterShape: { file_path: 'src/app.ts' },
        outcomeSummary: 'success',
        timestamp: '2026-06-10T10:30:00.000Z',
      },
    ],
  }
}

function makeSessionModel(sessionId = 'llm-test-session'): SessionModel {
  return {
    sessionId,
    intent: 'refactoring the app module',
    interactionPatterns: ['edits-then-tests'],
    codingPreferences: ['typescript', 'strict mode'],
    satisfactionSignals: {
      frustration: false,
      satisfaction: true,
      urgency: 'low',
    },
  }
}

function wrapperOutput(resultText: string, usage?: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: resultText,
    ...(usage !== undefined ? { usage } : {}),
  })
}

/**
 * Configures the spawn mock to return a fake child that emits the given
 * stdout and close code on the next macrotask tick.
 */
function spawnEmitting(stdout: string, code: number, stderr = ''): FakeChildProcess {
  const child = new FakeChildProcess()
  mockSpawn.mockReturnValue(child as never)
  setImmediate(() => {
    if (stdout !== '') {
      child.stdout.emit('data', stdout)
    }
    if (stderr !== '') {
      child.stderr.emit('data', stderr)
    }
    child.emit('close', code)
  })
  return child
}

beforeEach(() => {
  mockSpawn.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

// --- buildAnalysisPrompt ---

describe('buildAnalysisPrompt', () => {
  it('describes every SessionModel field and embeds the session log', () => {
    const log = makeSessionLog('prompt-session')
    const prompt = buildAnalysisPrompt(log)

    expect(prompt).toContain('"sessionId": "prompt-session"')
    expect(prompt).toContain('"intent"')
    expect(prompt).toContain('"interactionPatterns"')
    expect(prompt).toContain('"codingPreferences"')
    expect(prompt).toContain('"satisfactionSignals"')
    expect(prompt).toContain('low | medium | high')
    expect(prompt).toContain(JSON.stringify(log))
  })
})

// --- analyzeSessionWithLlm ---

describe('analyzeSessionWithLlm', () => {
  it('returns the validated model and token usage on success', async () => {
    const log = makeSessionLog()
    const model = makeSessionModel()
    spawnEmitting(
      wrapperOutput(JSON.stringify(model), { input_tokens: 100, output_tokens: 50 }),
      0
    )

    const result = await analyzeSessionWithLlm(log, 'haiku')

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.path).toBe('llm')
      expect(result.model).toEqual(model)
      expect(result.tokensUsed).toBe(150)
    }
  })

  it('spawns claude headlessly with model, output format, and internal guard', async () => {
    const log = makeSessionLog()
    spawnEmitting(wrapperOutput(JSON.stringify(makeSessionModel())), 0)

    await analyzeSessionWithLlm(log, 'claude-sonnet-4-6')

    expect(mockSpawn).toHaveBeenCalledTimes(1)
    const [command, args, options] = mockSpawn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string>; stdio: unknown },
    ]
    expect(command).toBe('claude')
    expect(args[0]).toBe('-p')
    expect(args[1]).toContain('Session log (JSON)')
    expect(args).toContain('--model')
    expect(args).toContain('claude-sonnet-4-6')
    expect(args).toContain('--output-format')
    expect(args).toContain('json')
    expect(options.env['TOM_SWE_INTERNAL']).toBe('1')
  })

  it('returns tokensUsed null when usage fields are absent', async () => {
    const log = makeSessionLog()
    spawnEmitting(wrapperOutput(JSON.stringify(makeSessionModel())), 0)

    const result = await analyzeSessionWithLlm(log, 'haiku')

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.tokensUsed).toBeNull()
    }
  })

  it('tolerates prose around the JSON object in the result text', async () => {
    const log = makeSessionLog()
    const model = makeSessionModel()
    spawnEmitting(
      wrapperOutput(`Here is the session model:\n${JSON.stringify(model)}\nDone.`),
      0
    )

    const result = await analyzeSessionWithLlm(log, 'haiku')

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.model.intent).toBe(model.intent)
    }
  })

  it('pins sessionId to the session log even if the model returns a different one', async () => {
    const log = makeSessionLog('real-session')
    spawnEmitting(wrapperOutput(JSON.stringify(makeSessionModel('hallucinated-session'))), 0)

    const result = await analyzeSessionWithLlm(log, 'haiku')

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.model.sessionId).toBe('real-session')
    }
  })

  it('fails with spawn-error when the claude binary is missing', async () => {
    const child = new FakeChildProcess()
    mockSpawn.mockReturnValue(child as never)
    setImmediate(() => {
      child.emit('error', new Error('spawn claude ENOENT'))
    })

    const result = await analyzeSessionWithLlm(makeSessionLog(), 'haiku')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('spawn-error')
      expect(result.detail).toContain('ENOENT')
    }
  })

  it('fails with timeout and kills the child when the deadline passes', async () => {
    vi.useFakeTimers()
    const child = new FakeChildProcess()
    mockSpawn.mockReturnValue(child as never)

    const pending = analyzeSessionWithLlm(makeSessionLog(), 'haiku')
    await vi.advanceTimersByTimeAsync(LLM_ANALYSIS_TIMEOUT_MS)
    const result = await pending

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('timeout')
    }
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('respects a custom timeout', async () => {
    vi.useFakeTimers()
    const child = new FakeChildProcess()
    mockSpawn.mockReturnValue(child as never)

    const pending = analyzeSessionWithLlm(makeSessionLog(), 'haiku', { timeoutMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    const result = await pending

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('timeout')
    }
  })

  it('fails with non-zero-exit and captures stderr', async () => {
    spawnEmitting('', 1, 'invalid api key')

    const result = await analyzeSessionWithLlm(makeSessionLog(), 'haiku')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('non-zero-exit')
      expect(result.detail).toContain('exit code 1')
      expect(result.detail).toContain('invalid api key')
    }
  })

  it('fails with no-json-found when output contains no JSON object', async () => {
    spawnEmitting(wrapperOutput('I could not analyze this session.'), 0)

    const result = await analyzeSessionWithLlm(makeSessionLog(), 'haiku')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('no-json-found')
    }
  })

  it('fails with invalid-json when the extracted block is malformed', async () => {
    spawnEmitting(wrapperOutput('Sure: {not valid json}'), 0)

    const result = await analyzeSessionWithLlm(makeSessionLog(), 'haiku')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('invalid-json')
    }
  })

  it('fails with schema-mismatch when JSON does not match SessionModel', async () => {
    spawnEmitting(
      wrapperOutput(JSON.stringify({ sessionId: 's', intent: 'x', extraField: true })),
      0
    )

    const result = await analyzeSessionWithLlm(makeSessionLog(), 'haiku')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('schema-mismatch')
    }
  })

  it('fails with schema-mismatch on an invalid urgency enum value', async () => {
    const bad = { ...makeSessionModel(), satisfactionSignals: {
      frustration: false,
      satisfaction: true,
      urgency: 'extreme',
    } }
    spawnEmitting(wrapperOutput(JSON.stringify(bad)), 0)

    const result = await analyzeSessionWithLlm(makeSessionLog(), 'haiku')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('schema-mismatch')
    }
  })
})

// --- parseAnalysisOutput ---

describe('parseAnalysisOutput', () => {
  it('treats raw non-wrapper stdout as model text with unknown token usage', () => {
    const model = makeSessionModel('raw-session')
    const result = parseAnalysisOutput(JSON.stringify(model), 'raw-session')

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.model).toEqual(model)
      expect(result.tokensUsed).toBeNull()
    }
  })

  it('ignores braces inside string literals when extracting the JSON block', () => {
    const model = { ...makeSessionModel('s1'), intent: 'fix the {weird} bug' }
    const text = `prefix ${JSON.stringify(model)} suffix`
    const result = parseAnalysisOutput(wrapperOutput(text), 's1')

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.model.intent).toBe('fix the {weird} bug')
    }
  })

  it('sums partial usage fields', () => {
    const model = makeSessionModel('s1')
    const stdout = wrapperOutput(JSON.stringify(model), { output_tokens: 42 })
    const result = parseAnalysisOutput(stdout, 's1')

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.tokensUsed).toBe(42)
    }
  })

  it('returns no-json-found for empty output', () => {
    const result = parseAnalysisOutput('', 's1')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('no-json-found')
    }
  })
})
