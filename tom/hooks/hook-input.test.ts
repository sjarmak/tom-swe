import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import {
  readHookInput,
  getSessionId,
  isInternalInvocation,
  isExcludedSession,
  toRecord,
} from './hook-input'

function streamOf(content: string): Readable {
  return Readable.from([content])
}

describe('readHookInput', () => {
  it('parses a valid PostToolUse payload', async () => {
    const payload = {
      session_id: 'session-abc',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: '/home/user/project',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_response: 'file1.ts\nfile2.ts',
    }
    const input = await readHookInput(streamOf(JSON.stringify(payload)))

    expect(input).not.toBeNull()
    expect(input?.session_id).toBe('session-abc')
    expect(input?.hook_event_name).toBe('PostToolUse')
    expect(input?.tool_name).toBe('Bash')
    expect(input?.tool_input).toEqual({ command: 'ls' })
    expect(input?.tool_response).toBe('file1.ts\nfile2.ts')
  })

  it('preserves unknown extra fields (permissive schema)', async () => {
    const payload = {
      session_id: 's1',
      hook_event_name: 'PreToolUse',
      permission_mode: 'default',
      some_future_field: { nested: true },
    }
    const input = await readHookInput(streamOf(JSON.stringify(payload)))

    expect(input).not.toBeNull()
    expect(input?.['permission_mode']).toBe('default')
    expect(input?.['some_future_field']).toEqual({ nested: true })
  })

  it('parses stop_hook_active and source fields', async () => {
    const payload = {
      session_id: 's2',
      hook_event_name: 'Stop',
      stop_hook_active: true,
      source: 'startup',
    }
    const input = await readHookInput(streamOf(JSON.stringify(payload)))

    expect(input?.stop_hook_active).toBe(true)
    expect(input?.source).toBe('startup')
  })

  it('parses the UserPromptSubmit prompt field', async () => {
    const payload = {
      session_id: 's3',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'fix the failing tests',
    }
    const input = await readHookInput(streamOf(JSON.stringify(payload)))

    expect(input?.prompt).toBe('fix the failing tests')
  })

  it('returns null on empty stdin', async () => {
    expect(await readHookInput(streamOf(''))).toBeNull()
  })

  it('returns null on whitespace-only stdin', async () => {
    expect(await readHookInput(streamOf('  \n\t '))).toBeNull()
  })

  it('returns null on malformed JSON', async () => {
    expect(await readHookInput(streamOf('{not json'))).toBeNull()
  })

  it('returns null on non-object JSON', async () => {
    expect(await readHookInput(streamOf('[1,2,3]'))).toBeNull()
    expect(await readHookInput(streamOf('"a string"'))).toBeNull()
  })

  it('returns null when a known field has the wrong type', async () => {
    const payload = { session_id: 42 }
    expect(await readHookInput(streamOf(JSON.stringify(payload)))).toBeNull()
  })

  it('returns null when the stream errors', async () => {
    const broken = new Readable({
      read() {
        this.destroy(new Error('boom'))
      },
    })
    expect(await readHookInput(broken)).toBeNull()
  })

  it('assembles payloads split across multiple chunks', async () => {
    const payload = JSON.stringify({ session_id: 'chunked', tool_name: 'Edit' })
    const stream = Readable.from([payload.slice(0, 10), payload.slice(10)])
    const input = await readHookInput(stream)
    expect(input?.session_id).toBe('chunked')
    expect(input?.tool_name).toBe('Edit')
  })
})

describe('getSessionId', () => {
  let originalSessionId: string | undefined

  beforeEach(() => {
    originalSessionId = process.env['CLAUDE_SESSION_ID']
  })

  afterEach(() => {
    if (originalSessionId !== undefined) {
      process.env['CLAUDE_SESSION_ID'] = originalSessionId
    } else {
      delete process.env['CLAUDE_SESSION_ID']
    }
  })

  it('prefers payload session_id over the env var', () => {
    process.env['CLAUDE_SESSION_ID'] = 'env-session'
    expect(getSessionId({ session_id: 'payload-session' })).toBe('payload-session')
  })

  it('falls back to CLAUDE_SESSION_ID when payload has no session_id', () => {
    process.env['CLAUDE_SESSION_ID'] = 'env-session'
    expect(getSessionId({})).toBe('env-session')
    expect(getSessionId(null)).toBe('env-session')
  })

  it('falls back to pid-based ID as last resort', () => {
    delete process.env['CLAUDE_SESSION_ID']
    expect(getSessionId(null)).toBe(`pid-${process.pid}`)
    expect(getSessionId({})).toBe(`pid-${process.pid}`)
  })
})

describe('isInternalInvocation', () => {
  let originalInternal: string | undefined

  beforeEach(() => {
    originalInternal = process.env['TOM_SWE_INTERNAL']
  })

  afterEach(() => {
    if (originalInternal !== undefined) {
      process.env['TOM_SWE_INTERNAL'] = originalInternal
    } else {
      delete process.env['TOM_SWE_INTERNAL']
    }
  })

  it('returns true when TOM_SWE_INTERNAL is "1"', () => {
    process.env['TOM_SWE_INTERNAL'] = '1'
    expect(isInternalInvocation()).toBe(true)
  })

  it('returns false when TOM_SWE_INTERNAL is unset or another value', () => {
    delete process.env['TOM_SWE_INTERNAL']
    expect(isInternalInvocation()).toBe(false)
    process.env['TOM_SWE_INTERNAL'] = '0'
    expect(isInternalInvocation()).toBe(false)
  })
})

describe('isExcludedSession', () => {
  const GUARD_VARS = ['TOM_SWE_INTERNAL', 'TOM_SWE_DISABLE', 'GC_AGENT'] as const
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = {}
    for (const v of GUARD_VARS) {
      saved[v] = process.env[v]
      delete process.env[v]
    }
  })

  afterEach(() => {
    for (const v of GUARD_VARS) {
      const value = saved[v]
      if (value !== undefined) {
        process.env[v] = value
      } else {
        delete process.env[v]
      }
    }
  })

  it('excludes ToM-internal invocations', () => {
    process.env['TOM_SWE_INTERNAL'] = '1'
    expect(isExcludedSession()).toBe(true)
  })

  it('excludes explicit operator opt-out via TOM_SWE_DISABLE', () => {
    process.env['TOM_SWE_DISABLE'] = '1'
    expect(isExcludedSession()).toBe(true)
  })

  it('excludes Gas City agent sessions (GC_AGENT set)', () => {
    process.env['GC_AGENT'] = 'polecat-7'
    expect(isExcludedSession()).toBe(true)
    process.env['GC_AGENT'] = 'mayor'
    expect(isExcludedSession()).toBe(true)
  })

  it('does not exclude normal interactive sessions', () => {
    expect(isExcludedSession()).toBe(false)
    // Empty GC_AGENT is not an agent session.
    process.env['GC_AGENT'] = ''
    expect(isExcludedSession()).toBe(false)
    process.env['TOM_SWE_DISABLE'] = '0'
    expect(isExcludedSession()).toBe(false)
  })
})

describe('toRecord', () => {
  it('passes through plain objects', () => {
    expect(toRecord({ a: 1 })).toEqual({ a: 1 })
  })

  it('returns empty record for non-objects, arrays, and null', () => {
    expect(toRecord('string')).toEqual({})
    expect(toRecord(42)).toEqual({})
    expect(toRecord(null)).toEqual({})
    expect(toRecord(undefined)).toEqual({})
    expect(toRecord([1, 2])).toEqual({})
  })
})
