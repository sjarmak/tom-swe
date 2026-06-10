/**
 * LLM-based Tier 2 session analysis.
 *
 * Spawns the claude CLI headlessly (`claude -p --model <model> --output-format json`)
 * to extract a SessionModel from a Tier 1 SessionLog. The session log was already
 * sanitized/redacted at capture time, so it is safe to embed in the prompt.
 *
 * Recursion guard: the spawned claude instance inherits TOM_SWE_INTERNAL=1,
 * which makes every tom-swe hook entry point exit silently. There is no
 * documented CLI flag or env var that disables hooks in headless mode, so
 * this env guard is the only recursion-prevention mechanism.
 */

import { spawn } from 'node:child_process'

import type { SessionLog, SessionModel } from './schemas.js'
import { SessionModelSchema } from './schemas.js'

// --- Types ---

export const LLM_ANALYSIS_TIMEOUT_MS = 45_000

export type LlmAnalysisFailureReason =
  | 'spawn-error'
  | 'timeout'
  | 'non-zero-exit'
  | 'no-json-found'
  | 'invalid-json'
  | 'schema-mismatch'

export interface LlmAnalysisSuccess {
  readonly ok: true
  readonly model: SessionModel
  readonly tokensUsed: number | null
  readonly path: 'llm'
}

export interface LlmAnalysisFailure {
  readonly ok: false
  readonly reason: LlmAnalysisFailureReason
  readonly detail: string
}

export type LlmAnalysisResult = LlmAnalysisSuccess | LlmAnalysisFailure

// --- Prompt ---

export function buildAnalysisPrompt(sessionLog: SessionLog): string {
  return [
    'You are analyzing a Claude Code session log to extract the user\'s session model.',
    'Return ONLY a single JSON object — no prose, no markdown fences — matching exactly this shape:',
    '{',
    `  "sessionId": "${sessionLog.sessionId}",`,
    '  "intent": "<string: concise description of what the user was trying to accomplish>",',
    '  "interactionPatterns": ["<string: recurring interaction or workflow patterns observed>"],',
    '  "codingPreferences": ["<string: coding preferences inferable from the session>"],',
    '  "satisfactionSignals": {',
    '    "frustration": <boolean: did the user hit repeated errors or friction?>,',
    '    "satisfaction": <boolean: did the session conclude successfully?>,',
    '    "urgency": "<one of exactly: low | medium | high>"',
    '  }',
    '}',
    'No additional fields are allowed. "urgency" must be exactly "low", "medium", or "high".',
    '',
    'Session log (JSON):',
    JSON.stringify(sessionLog),
  ].join('\n')
}

// --- Output Parsing ---

const DETAIL_MAX_LENGTH = 500

function truncateDetail(text: string): string {
  return text.length > DETAIL_MAX_LENGTH ? `${text.slice(0, DETAIL_MAX_LENGTH)}…` : text
}

/**
 * Extracts the first balanced {...} block from text, tolerating surrounding
 * prose. Tracks string literals so braces inside strings are ignored.
 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start === -1) {
    return null
  }

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (inString) {
      if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) {
        return text.slice(start, i + 1)
      }
    }
  }

  return null
}

function extractTokensUsed(usage: unknown): number | null {
  if (typeof usage !== 'object' || usage === null) {
    return null
  }
  const record = usage as Record<string, unknown>
  const input = record['input_tokens']
  const output = record['output_tokens']
  const inputTokens = typeof input === 'number' ? input : null
  const outputTokens = typeof output === 'number' ? output : null
  if (inputTokens === null && outputTokens === null) {
    return null
  }
  return (inputTokens ?? 0) + (outputTokens ?? 0)
}

/**
 * Parses claude CLI stdout. With --output-format json, stdout is a wrapper
 * object whose `result` field carries the model's text and whose `usage`
 * field carries token counts. If the wrapper shape is absent, the raw stdout
 * is treated as the model text and token usage is reported as unavailable.
 */
export function parseAnalysisOutput(
  stdout: string,
  expectedSessionId: string
): LlmAnalysisResult {
  let modelText = stdout
  let tokensUsed: number | null = null

  try {
    const wrapper = JSON.parse(stdout) as unknown
    if (typeof wrapper === 'object' && wrapper !== null) {
      const record = wrapper as Record<string, unknown>
      if (typeof record['result'] === 'string') {
        modelText = record['result']
      }
      tokensUsed = extractTokensUsed(record['usage'])
    }
  } catch {
    // stdout is not the documented wrapper; treat it as raw model text.
  }

  const jsonBlock = extractFirstJsonObject(modelText)
  if (jsonBlock === null) {
    return {
      ok: false,
      reason: 'no-json-found',
      detail: truncateDetail(`no JSON object in output: ${modelText}`),
    }
  }

  let candidate: unknown
  try {
    candidate = JSON.parse(jsonBlock)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      reason: 'invalid-json',
      detail: truncateDetail(message),
    }
  }

  const parsed = SessionModelSchema.safeParse(candidate)
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'schema-mismatch',
      detail: truncateDetail(parsed.error.message),
    }
  }

  // Pin the session id mechanically: downstream storage keys on it, and the
  // log being analyzed is the single source of truth for identity.
  return {
    ok: true,
    model: { ...parsed.data, sessionId: expectedSessionId },
    tokensUsed,
    path: 'llm',
  }
}

// --- Headless Invocation ---

/**
 * Analyzes a session log by spawning the claude CLI headlessly with the
 * configured memoryUpdate model. Enforces a hard timeout; any failure
 * (missing binary, timeout, non-zero exit, unparseable or schema-invalid
 * output) is returned as a typed failure so callers can fall back loudly.
 */
export async function analyzeSessionWithLlm(
  sessionLog: SessionLog,
  model: string,
  options: { readonly timeoutMs?: number } = {}
): Promise<LlmAnalysisResult> {
  const timeoutMs = options.timeoutMs ?? LLM_ANALYSIS_TIMEOUT_MS
  const prompt = buildAnalysisPrompt(sessionLog)

  return new Promise<LlmAnalysisResult>((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | null = null

    const settle = (result: LlmAnalysisResult): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer !== null) {
        clearTimeout(timer)
      }
      resolve(result)
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(
        'claude',
        ['-p', prompt, '--model', model, '--output-format', 'json'],
        {
          env: { ...process.env, TOM_SWE_INTERNAL: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      settle({ ok: false, reason: 'spawn-error', detail: truncateDetail(message) })
      return
    }

    timer = setTimeout(() => {
      child.kill('SIGTERM')
      settle({
        ok: false,
        reason: 'timeout',
        detail: `claude did not respond within ${timeoutMs}ms`,
      })
    }, timeoutMs)

    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk)
    })

    child.on('error', (error: Error) => {
      settle({ ok: false, reason: 'spawn-error', detail: truncateDetail(error.message) })
    })

    child.on('close', (code: number | null) => {
      if (code !== 0) {
        settle({
          ok: false,
          reason: 'non-zero-exit',
          detail: truncateDetail(`exit code ${code ?? 'null'}: ${stderr}`),
        })
        return
      }
      settle(parseAnalysisOutput(stdout, sessionLog.sessionId))
    })
  })
}
