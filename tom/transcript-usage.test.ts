import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import { parseTranscriptUsage, readTranscriptUsage } from './transcript-usage'

function assistantLine(
  id: string | null,
  usage: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): string {
  const message: Record<string, unknown> = { usage }
  if (id !== null) {
    message['id'] = id
  }
  return JSON.stringify({ type: 'assistant', message, ...extra })
}

const USAGE_A = {
  input_tokens: 100,
  output_tokens: 50,
  cache_creation_input_tokens: 200,
  cache_read_input_tokens: 1000,
}

describe('parseTranscriptUsage', () => {
  it('sums usage across distinct assistant messages', () => {
    const content = [
      assistantLine('msg_1', USAGE_A),
      assistantLine('msg_2', {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ].join('\n')

    const usage = parseTranscriptUsage(content)
    expect(usage.inputTokens).toBe(110)
    expect(usage.outputTokens).toBe(55)
    expect(usage.cacheCreationTokens).toBe(200)
    expect(usage.cacheReadTokens).toBe(1000)
    expect(usage.assistantMessages).toBe(2)
  })

  it('deduplicates repeated message ids (one line per content block)', () => {
    // Real transcripts write one line per content block, each repeating the
    // same message.id and usage — naive summing overcounts ~2.7x.
    const content = [
      assistantLine('msg_1', USAGE_A),
      assistantLine('msg_1', USAGE_A),
      assistantLine('msg_1', USAGE_A),
    ].join('\n')

    const usage = parseTranscriptUsage(content)
    expect(usage.inputTokens).toBe(100)
    expect(usage.outputTokens).toBe(50)
    expect(usage.assistantMessages).toBe(1)
  })

  it('last occurrence wins for a repeated id', () => {
    const content = [
      assistantLine('msg_1', { ...USAGE_A, output_tokens: 1 }),
      assistantLine('msg_1', { ...USAGE_A, output_tokens: 999 }),
    ].join('\n')

    expect(parseTranscriptUsage(content).outputTokens).toBe(999)
  })

  it('counts entries without a message id individually', () => {
    const content = [
      assistantLine(null, USAGE_A),
      assistantLine(null, USAGE_A),
    ].join('\n')

    const usage = parseTranscriptUsage(content)
    expect(usage.inputTokens).toBe(200)
    expect(usage.assistantMessages).toBe(2)
  })

  it('includes sidechain (subagent) entries — they are part of session cost', () => {
    const content = [
      assistantLine('msg_main', USAGE_A, { isSidechain: false }),
      assistantLine('msg_side', USAGE_A, { isSidechain: true }),
    ].join('\n')

    expect(parseTranscriptUsage(content).inputTokens).toBe(200)
  })

  it('skips non-assistant entries, malformed lines, and missing usage fields', () => {
    const content = [
      JSON.stringify({ type: 'user', message: { role: 'user' } }),
      'not json at all',
      JSON.stringify({ type: 'file-history-snapshot' }),
      assistantLine('msg_1', { input_tokens: 7, output_tokens: 3 }),
      '',
    ].join('\n')

    const usage = parseTranscriptUsage(content)
    expect(usage.inputTokens).toBe(7)
    expect(usage.outputTokens).toBe(3)
    expect(usage.cacheCreationTokens).toBe(0)
    expect(usage.assistantMessages).toBe(1)
  })

  it('returns zeros for an empty transcript', () => {
    const usage = parseTranscriptUsage('')
    expect(usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      assistantMessages: 0,
    })
  })
})

describe('readTranscriptUsage', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tom-transcript-test-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('reads and parses a transcript file', () => {
    const transcriptPath = path.join(tempDir, 'session.jsonl')
    fs.writeFileSync(transcriptPath, assistantLine('msg_1', USAGE_A), 'utf-8')

    const usage = readTranscriptUsage(transcriptPath)
    expect(usage?.inputTokens).toBe(100)
  })

  it('returns null for a missing file', () => {
    expect(readTranscriptUsage(path.join(tempDir, 'nope.jsonl'))).toBeNull()
  })
})
