/**
 * Host-session token usage, parsed from the Claude Code transcript JSONL
 * that the Stop hook receives via transcript_path.
 *
 * This is the denominator for ToM's cost-overhead metric: the session's own
 * token consumption, against which the session-analysis tokens are compared.
 *
 * The transcript format is internal to Claude Code (the same format the
 * community usage tools parse): one JSON object per line; assistant entries
 * carry message.usage with input/output/cache token buckets. A single
 * assistant message is written once per content block, each repeating the
 * same message.id and usage — summing naively overcounts severely (2.7x on
 * a real transcript), so usage is deduplicated by message.id with the last
 * occurrence winning. Sidechain (subagent) entries are counted: they are
 * part of the session's real cost.
 *
 * All four buckets are reported raw. Cache reads are far cheaper than
 * uncached input, so collapsing them into one number is a pricing judgment
 * that belongs to consumers (/tom-status, the mem eval harness), not here.
 */

import * as fs from 'node:fs'

// --- Types ---

export interface SessionUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheCreationTokens: number
  readonly cacheReadTokens: number
  readonly assistantMessages: number
}

interface UsageBuckets {
  readonly input: number
  readonly output: number
  readonly cacheCreation: number
  readonly cacheRead: number
}

// --- Parsing ---

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function extractBuckets(line: string): { id: string | null; buckets: UsageBuckets } | null {
  let obj: unknown
  try {
    obj = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof obj !== 'object' || obj === null) {
    return null
  }

  const record = obj as Record<string, unknown>
  const message = record['message']
  if (typeof message !== 'object' || message === null) {
    return null
  }

  const messageRecord = message as Record<string, unknown>
  const usage = messageRecord['usage']
  if (typeof usage !== 'object' || usage === null) {
    return null
  }

  const usageRecord = usage as Record<string, unknown>
  const id = messageRecord['id']
  return {
    id: typeof id === 'string' ? id : null,
    buckets: {
      input: asNumber(usageRecord['input_tokens']),
      output: asNumber(usageRecord['output_tokens']),
      cacheCreation: asNumber(usageRecord['cache_creation_input_tokens']),
      cacheRead: asNumber(usageRecord['cache_read_input_tokens']),
    },
  }
}

/**
 * Sums token usage across a transcript's assistant messages, deduplicated
 * by message.id (last occurrence wins; entries without an id each count).
 * Pure — no I/O. Unparseable lines are skipped: the transcript interleaves
 * many entry types and only usage-bearing ones matter here.
 */
export function parseTranscriptUsage(content: string): SessionUsage {
  const byId = new Map<string, UsageBuckets>()
  const anonymous: UsageBuckets[] = []

  for (const line of content.split('\n')) {
    if (line.trim() === '') {
      continue
    }
    const extracted = extractBuckets(line)
    if (!extracted) {
      continue
    }
    if (extracted.id !== null) {
      byId.set(extracted.id, extracted.buckets)
    } else {
      anonymous.push(extracted.buckets)
    }
  }

  const all = [...byId.values(), ...anonymous]
  return {
    inputTokens: all.reduce((sum, b) => sum + b.input, 0),
    outputTokens: all.reduce((sum, b) => sum + b.output, 0),
    cacheCreationTokens: all.reduce((sum, b) => sum + b.cacheCreation, 0),
    cacheReadTokens: all.reduce((sum, b) => sum + b.cacheRead, 0),
    assistantMessages: all.length,
  }
}

/**
 * Reads and parses the transcript at the given path.
 * Returns null when the file is missing or unreadable — the caller decides
 * how loudly to report that (the Stop hook logs a typed error entry).
 */
export function readTranscriptUsage(transcriptPath: string): SessionUsage | null {
  let content: string
  try {
    content = fs.readFileSync(transcriptPath, 'utf-8')
  } catch {
    return null
  }
  return parseTranscriptUsage(content)
}
