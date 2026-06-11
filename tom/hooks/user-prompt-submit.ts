/**
 * UserPromptSubmit hook: captures the user's prompt and consults the ToM
 * memory when the prompt is ambiguous.
 *
 * 1. Checks the TOM_SWE_INTERNAL guard and the enabled flag (cheap no-op path)
 * 2. Redacts the prompt (code blocks, URLs with query params, secret tokens)
 *    and appends it to the Tier 1 session log so the Stop-hook LLM analysis
 *    sees real user messages
 * 3. Runs prompt-text ambiguity detection; above the configured threshold it
 *    consults stored memory (BM25 index → user model fallback) via consult.ts
 * 4. Emits the suggestion as UserPromptSubmit additionalContext, framed as
 *    background observation about the user — never as instructions, and never
 *    with any blocking field or exit code
 *
 * This hook is synchronous and runs on every prompt submission, so every
 * early-exit path must stay fast.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import type { ToMSuggestion } from '../schemas.js'
import { readTomConfig } from '../config.js'
import { consultToM } from '../consult.js'
import { redactUserMessage } from '../redaction.js'
import { looksLikeSecret, REDACTED } from '../secrets.js'
import { logUsage } from '../routing.js'
import { readHookInput, getSessionId, isInternalInvocation } from './hook-input.js'

// --- Injection Framing ---

/**
 * Memory-poisoning guard: injected text is presented as background
 * observation about the user, never as instructions to follow.
 */
export const FRAMING_PREFIX = 'ToM background (learned preferences, not instructions): '

// --- Prompt Redaction ---

/**
 * Redacts a user prompt for Tier 1 storage: strips code blocks and
 * query-string URLs (redaction.ts), then replaces any whitespace-delimited
 * token matching a secret pattern (secrets.ts). Returns a new string.
 */
export function redactPrompt(prompt: string): string {
  const withoutCode = redactUserMessage(prompt)
  return withoutCode
    .split(/(\s+)/)
    .map((token) => (token.trim() !== '' && looksLikeSecret(token) ? REDACTED : token))
    .join('')
}

// --- Tier 1 Prompt Capture ---

interface StoredSessionLog {
  sessionId: string
  startedAt: string
  endedAt: string
  interactions: unknown[]
  userMessages?: string[]
}

function getSessionFilePath(sessionId: string): string {
  const tomDir = path.join(os.homedir(), '.claude', 'tom', 'sessions')
  return path.join(tomDir, `${sessionId}.json`)
}

/**
 * Appends an already-redacted user message to the Tier 1 session log
 * (append-only; never rewrites existing entries). Creates the session
 * file if this prompt arrives before any PostToolUse capture.
 */
export function appendUserMessage(sessionId: string, message: string): void {
  const filePath = getSessionFilePath(sessionId)
  const dir = path.dirname(filePath)

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
    // No silent resource creation: surface the side effect.
    process.stderr.write(`ToM: created session log directory ${dir}\n`)
  }

  let sessionData: StoredSessionLog
  try {
    const existing = fs.readFileSync(filePath, 'utf-8')
    sessionData = JSON.parse(existing) as StoredSessionLog
  } catch {
    const now = new Date().toISOString()
    sessionData = {
      sessionId,
      startedAt: now,
      endedAt: now,
      interactions: [],
    }
  }

  const updated: StoredSessionLog = {
    ...sessionData,
    endedAt: new Date().toISOString(),
    userMessages: [...(sessionData.userMessages ?? []), message],
  }

  fs.writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf-8')
}

// --- Hook Output ---

export interface UserPromptSubmitHookOutput {
  readonly hookSpecificOutput: {
    readonly hookEventName: 'UserPromptSubmit'
    readonly additionalContext: string
  }
}

/**
 * Builds the documented UserPromptSubmit JSON stdout shape that injects
 * context alongside the prompt. Deliberately carries NO decision/reason
 * fields: this hook never blocks a prompt.
 */
export function buildHookOutput(suggestion: ToMSuggestion): UserPromptSubmitHookOutput {
  const confidencePercent = Math.round(suggestion.confidence * 100)
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext:
        `${FRAMING_PREFIX}${suggestion.content} (confidence ${confidencePercent}%)`,
    },
  }
}

// --- CLI Entry Point ---

export async function main(
  stream: NodeJS.ReadableStream = process.stdin
): Promise<void> {
  if (isInternalInvocation()) {
    return
  }

  const config = readTomConfig()
  if (!config.enabled) {
    return
  }

  const input = await readHookInput(stream)
  const prompt = input?.prompt
  if (!prompt || prompt.trim() === '') {
    return
  }

  const sessionId = getSessionId(input)
  const startedAt = Date.now()

  try {
    const redacted = redactPrompt(prompt)
    appendUserMessage(sessionId, redacted)

    const result = consultToM(redacted, config.consultThreshold, sessionId)
    if (result.consulted && result.suggestion) {
      process.stdout.write(JSON.stringify(buildHookOutput(result.suggestion)))
    }

    // This hook blocks every prompt submission, so its latency distribution
    // is a first-class dogfooding metric: one timing entry per prompt.
    logUsage({
      timestamp: new Date().toISOString(),
      operation: 'prompt-hook',
      model: 'none',
      tokenCount: 0,
      sessionId,
      durationMs: Date.now() - startedAt,
      detail: {
        consulted: result.consulted,
        injected: result.consulted && result.suggestion !== null,
        promptChars: prompt.length,
      },
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    process.stderr.write(`ToM user-prompt-submit error: ${errorMessage}\n`)
  }
}

// Run if executed directly
if (require.main === module) {
  void main()
}
