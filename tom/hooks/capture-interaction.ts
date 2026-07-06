import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { execFileSync } from 'node:child_process'

import { TOM_DIR_MODE, TOM_FILE_MODE } from '../fs-atomic.js'
import { readHookInput, getSessionId, isExcludedSession, toRecord } from './hook-input.js'
import { sanitizeValue, MAX_VALUE_LENGTH } from '../secrets.js'
import { isTomEnabled } from '../config.js'

// --- Sanitization ---

export function extractParameterShape(
  toolInput: Record<string, unknown>
): Record<string, string> {
  const shape: Record<string, string> = {}
  for (const key of Object.keys(toolInput)) {
    const value = toolInput[key]
    if (typeof value === 'string') {
      shape[key] = sanitizeValue(value)
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      shape[key] = String(value)
    } else if (value === null || value === undefined) {
      shape[key] = 'null'
    } else {
      shape[key] = typeof value
    }
  }
  return shape
}

// --- Interaction Entry ---

interface InteractionEntry {
  readonly toolName: string
  readonly parameterShape: Record<string, string>
  readonly outcomeSummary: string
  readonly timestamp: string
}

function buildInteractionEntry(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolOutput: string
): InteractionEntry {
  const outcomeSummary =
    toolOutput.length > MAX_VALUE_LENGTH
      ? toolOutput.slice(0, MAX_VALUE_LENGTH) + '...'
      : toolOutput

  return {
    toolName,
    parameterShape: extractParameterShape(toolInput),
    outcomeSummary: sanitizeValue(outcomeSummary),
    timestamp: new Date().toISOString(),
  }
}

/**
 * Flattens the PostToolUse tool response (object or string) into the
 * outcome summary string that buildInteractionEntry truncates/sanitizes.
 */
export function summarizeToolResponse(toolResponse: unknown): string {
  if (toolResponse === null || toolResponse === undefined) {
    return ''
  }
  if (typeof toolResponse === 'string') {
    return toolResponse
  }
  return JSON.stringify(toolResponse)
}

// --- Session File Management ---

function getSessionsDir(): string {
  return path.join(os.homedir(), '.claude', 'tom', 'sessions')
}

function getSessionFilePath(sessionId: string): string {
  return path.join(getSessionsDir(), `${sessionId}.json`)
}

function getSidecarPath(sessionId: string): string {
  return path.join(getSessionsDir(), `${sessionId}.jsonl`)
}

// --- Main Capture Function ---

/**
 * Resolves the current git branch for the join fields. Runs in the async
 * (backgrounded) capture path only, and only when the session log doesn't
 * already carry a branch — one subprocess per session, not per tool call.
 */
function resolveGitBranch(cwd: string): string | undefined {
  try {
    // --show-current (not rev-parse HEAD): works on unborn branches too.
    const branch = execFileSync('git', ['branch', '--show-current'], {
      cwd,
      encoding: 'utf-8',
      timeout: 2000,
    }).trim()
    return branch !== '' ? branch : undefined
  } catch {
    return undefined
  }
}

/**
 * Creates the session's create-once stub (identity + join fields) if it
 * does not exist yet. O_EXCL arbitrates concurrent first-captures — the
 * loser's stub is equivalent, so EEXIST is silently accepted. The one
 * git subprocess per session runs only on the creation path.
 *
 * Read-modify-write is deliberately absent from this hook: PostToolUse
 * fires concurrently, and RMW on the shared JSON lost appends (10
 * simultaneous captures kept 4-5). All per-event data goes to the
 * append-only sidecar; readSessionLog folds the two at read time.
 */
function ensureSessionStub(sessionId: string, cwd?: string): void {
  const stubPath = getSessionFilePath(sessionId)
  if (fs.existsSync(stubPath)) {
    return
  }
  const gitBranch = cwd !== undefined ? resolveGitBranch(cwd) : undefined
  const now = new Date().toISOString()
  const stub = {
    sessionId,
    startedAt: now,
    endedAt: now,
    interactions: [],
    ...(cwd !== undefined ? { cwd } : {}),
    ...(gitBranch !== undefined ? { gitBranch } : {}),
  }
  try {
    fs.writeFileSync(stubPath, JSON.stringify(stub, null, 2), {
      encoding: 'utf-8',
      flag: 'wx',
      mode: TOM_FILE_MODE,
    })
  } catch {
    // EEXIST: a concurrent first-capture won the race — theirs is equivalent.
  }
}

export function captureInteraction(
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolOutput: string,
  cwd?: string
): void {
  const entry = buildInteractionEntry(toolName, toolInput, toolOutput)

  try {
    fs.mkdirSync(getSessionsDir(), { recursive: true, mode: TOM_DIR_MODE })
    ensureSessionStub(sessionId, cwd)
    // O_APPEND: concurrent captures interleave whole lines instead of
    // losing each other's writes.
    fs.appendFileSync(
      getSidecarPath(sessionId),
      JSON.stringify({ type: 'interaction', ...entry }) + '\n',
      { encoding: 'utf-8', mode: TOM_FILE_MODE }
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`ToM capture-interaction write error: ${message}\n`)
  }
}

// --- CLI Entry Point ---

export async function main(
  stream: NodeJS.ReadableStream = process.stdin
): Promise<void> {
  if (isExcludedSession()) {
    return
  }
  if (!isTomEnabled()) {
    return
  }

  const input = await readHookInput(stream)
  if (!input?.tool_name) {
    return
  }

  const toolInput = toRecord(input.tool_input)
  const toolOutput = summarizeToolResponse(input.tool_response)

  captureInteraction(
    getSessionId(input),
    input.tool_name,
    toolInput,
    toolOutput,
    input.cwd
  )
}

// Run if executed directly
if (require.main === module) {
  void main()
}
