import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { execFileSync } from 'node:child_process'

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

function getSessionFilePath(sessionId: string): string {
  const tomDir = path.join(os.homedir(), '.claude', 'tom', 'sessions')
  return path.join(tomDir, `${sessionId}.json`)
}

function ensureDirectoryExists(filePath: string): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
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

export function captureInteraction(
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolOutput: string,
  cwd?: string
): void {
  const filePath = getSessionFilePath(sessionId)
  const entry = buildInteractionEntry(toolName, toolInput, toolOutput)

  ensureDirectoryExists(filePath)

  // Read existing session log or create new one
  let sessionData: {
    sessionId: string
    startedAt: string
    endedAt: string
    interactions: InteractionEntry[]
    cwd?: string
    gitBranch?: string
  }

  try {
    const existing = fs.readFileSync(filePath, 'utf-8')
    sessionData = JSON.parse(existing) as typeof sessionData
  } catch {
    sessionData = {
      sessionId,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      interactions: [],
    }
  }

  // Join fields, set once per session: cwd from the payload, branch from
  // one lazy git call (skipped on every subsequent capture).
  const joinCwd = sessionData.cwd ?? cwd
  const joinBranch =
    sessionData.gitBranch ?? (joinCwd ? resolveGitBranch(joinCwd) : undefined)

  // Append interaction (async-safe: write full file with new entry)
  const updated = {
    ...sessionData,
    endedAt: new Date().toISOString(),
    interactions: [...sessionData.interactions, entry],
    ...(joinCwd !== undefined ? { cwd: joinCwd } : {}),
    ...(joinBranch !== undefined ? { gitBranch: joinBranch } : {}),
  }

  // Async write for speed — not awaited, but failures must surface (stderr,
  // matching the other hooks' error pattern), never be silently discarded.
  fs.writeFile(filePath, JSON.stringify(updated, null, 2), 'utf-8', (err) => {
    if (err) {
      process.stderr.write(`ToM capture-interaction write error: ${err.message}\n`)
    }
  })
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
