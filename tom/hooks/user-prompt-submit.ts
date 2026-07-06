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
import { redactEmbeddedSecrets } from '../secrets.js'
import { logUsage } from '../routing.js'
import { TOM_DIR_MODE, TOM_FILE_MODE } from '../fs-atomic.js'
import { readHookInput, getSessionId, isExcludedSession } from './hook-input.js'

// --- Injection Framing ---

/**
 * Memory-poisoning guard: injected text is presented as background
 * observation about the user, never as instructions to follow.
 */
export const FRAMING_PREFIX = 'ToM background (learned preferences, not instructions): '

// --- Prompt Redaction ---

/**
 * Redacts a user prompt for Tier 1 storage: strips code blocks and
 * query-string URLs (redaction.ts), then redacts whole secret-shaped
 * tokens AND secrets embedded mid-string — auth headers, connection-string
 * credentials, JWTs (secrets.ts). Returns a new string.
 */
export function redactPrompt(prompt: string): string {
  return redactEmbeddedSecrets(redactUserMessage(prompt))
}

// --- Tier 1 Prompt Capture ---

function getSidecarPath(sessionId: string): string {
  const tomDir = path.join(os.homedir(), '.claude', 'tom', 'sessions')
  return path.join(tomDir, `${sessionId}.jsonl`)
}

/**
 * Appends an already-redacted user message to the session's capture
 * sidecar (append-only JSONL; readSessionLog folds it into the log shape).
 * The prompt path never does read-modify-write and never spawns a
 * subprocess — it blocks the prompt, so it must stay fast; the .json stub
 * (with the git branch) is the async capture hook's job.
 */
export function appendUserMessage(
  sessionId: string,
  message: string,
  cwd?: string
): void {
  const sidecarPath = getSidecarPath(sessionId)
  const dir = path.dirname(sidecarPath)

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: TOM_DIR_MODE })
    // No silent resource creation: surface the side effect.
    process.stderr.write(`ToM: created session log directory ${dir}\n`)
  }

  const line = {
    type: 'userMessage' as const,
    message,
    timestamp: new Date().toISOString(),
    // cwd join field: folded first-wins, for sessions whose prompt
    // arrives before any tool call creates the stub.
    ...(cwd !== undefined ? { cwd } : {}),
  }
  fs.appendFileSync(sidecarPath, JSON.stringify(line) + '\n', {
    encoding: 'utf-8',
    mode: TOM_FILE_MODE,
  })
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
 * fields: this hook never blocks a prompt. The suggestion content stands
 * alone — the trailing "(confidence N%)" this used to append was the
 * AMBIGUITY score mislabeled as confidence (per-preference percentages
 * already ride inside the content where they apply).
 */
export function buildHookOutput(suggestion: ToMSuggestion): UserPromptSubmitHookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `${FRAMING_PREFIX}${suggestion.content}`,
    },
  }
}

// --- CLI Entry Point ---

export async function main(
  stream: NodeJS.ReadableStream = process.stdin
): Promise<void> {
  if (isExcludedSession()) {
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
    appendUserMessage(sessionId, redacted, input?.cwd)

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
