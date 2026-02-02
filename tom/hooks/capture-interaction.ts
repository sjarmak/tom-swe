import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

// --- Secret Patterns ---

const SECRET_PATTERNS: readonly RegExp[] = [
  /^sk-[a-zA-Z0-9_-]+$/,          // OpenAI-style keys
  /^ghp_[a-zA-Z0-9]+$/,           // GitHub personal tokens
  /^gho_[a-zA-Z0-9]+$/,           // GitHub OAuth tokens
  /^ghs_[a-zA-Z0-9]+$/,           // GitHub server tokens
  /^github_pat_[a-zA-Z0-9_]+$/,   // GitHub fine-grained PATs
  /^Bearer\s+.+/i,                // Bearer tokens
  /^Basic\s+.+/i,                 // Basic auth
  /^token\s+.+/i,                 // Generic token prefix
  /^xox[bposa]-[a-zA-Z0-9-]+$/,   // Slack tokens
  /^AKIA[A-Z0-9]{16}$/,           // AWS access keys
  /^eyJ[a-zA-Z0-9_-]+\.eyJ/,     // JWT tokens
  /password[=:].+/i,              // password= or password:
  /^[a-f0-9]{40}$/,               // 40-char hex (git hashes, some tokens)
  /^npm_[a-zA-Z0-9]+$/,           // npm tokens
  /^pypi-[a-zA-Z0-9]+$/,          // PyPI tokens
]

const REDACTED = '[REDACTED]'
const MAX_VALUE_LENGTH = 200

// --- Sanitization ---

function looksLikeSecret(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value.trim()))
}

function sanitizeValue(value: string): string {
  if (looksLikeSecret(value)) {
    return REDACTED
  }
  if (value.length > MAX_VALUE_LENGTH) {
    return REDACTED
  }
  return value
}

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
  toolInput: string,
  toolOutput: string
): InteractionEntry {
  let parsedInput: Record<string, unknown> = {}
  try {
    parsedInput = JSON.parse(toolInput) as Record<string, unknown>
  } catch {
    parsedInput = {}
  }

  const outcomeSummary =
    toolOutput.length > MAX_VALUE_LENGTH
      ? toolOutput.slice(0, MAX_VALUE_LENGTH) + '...'
      : toolOutput

  return {
    toolName,
    parameterShape: extractParameterShape(parsedInput),
    outcomeSummary: sanitizeValue(outcomeSummary),
    timestamp: new Date().toISOString(),
  }
}

// --- Session File Management ---

function getSessionId(): string {
  return process.env['CLAUDE_SESSION_ID'] ?? `pid-${process.pid}`
}

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

export function captureInteraction(
  toolName: string,
  toolInput: string,
  toolOutput: string
): void {
  const sessionId = getSessionId()
  const filePath = getSessionFilePath(sessionId)
  const entry = buildInteractionEntry(toolName, toolInput, toolOutput)

  ensureDirectoryExists(filePath)

  // Read existing session log or create new one
  let sessionData: {
    sessionId: string
    startedAt: string
    endedAt: string
    interactions: InteractionEntry[]
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

  // Append interaction (async-safe: write full file with new entry)
  const updated = {
    ...sessionData,
    endedAt: new Date().toISOString(),
    interactions: [...sessionData.interactions, entry],
  }

  // Use async write for speed — fire and forget
  fs.writeFile(filePath, JSON.stringify(updated, null, 2), 'utf-8', () => {
    // no-op callback — fire and forget
  })
}

// --- CLI Entry Point ---

function isTomEnabled(): boolean {
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')
    const content = fs.readFileSync(settingsPath, 'utf-8')
    const settings = JSON.parse(content) as Record<string, unknown>
    const tom = settings['tom'] as Record<string, unknown> | undefined
    return tom?.['enabled'] === true
  } catch {
    return false
  }
}

export function main(): void {
  if (!isTomEnabled()) {
    return
  }

  const toolName = process.env['TOOL_NAME'] ?? ''
  const toolInput = process.env['TOOL_INPUT'] ?? '{}'
  const toolOutput = process.env['TOOL_OUTPUT'] ?? ''

  if (!toolName) {
    return
  }

  captureInteraction(toolName, toolInput, toolOutput)
}

// Run if executed directly
if (require.main === module) {
  main()
}
