/**
 * Stop hook TypeScript helper: Analyzes the completed session and updates memory.
 *
 * 1. Reads current session's Tier 1 log
 * 2. Extracts Tier 2 session model (heuristic analysis)
 * 3. Aggregates new session model into Tier 3 user model
 * 4. Rebuilds BM25 search index
 * 5. Logs completion status to tom/usage.log
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import type { SessionLog, SessionModel, UserModel } from '../schemas.js'
import { SessionLogSchema } from '../schemas.js'
import { readUserModel, writeSessionModel, writeUserModel, globalTomDir } from '../memory-io.js'
import { aggregateSessionIntoModel } from '../aggregation.js'
import { buildMemoryIndex } from '../agent/tools.js'

// --- Configuration ---

const DEFAULT_MODEL = 'haiku'

// --- Helpers ---

export function isTomEnabled(): boolean {
  try {
    const configPath = path.join(os.homedir(), '.claude', 'tom', 'config.json')
    const content = fs.readFileSync(configPath, 'utf-8')
    const config = JSON.parse(content) as Record<string, unknown>
    return config['enabled'] === true
  } catch {
    return false
  }
}

export function getSessionId(): string {
  return process.env['CLAUDE_SESSION_ID'] ?? `pid-${process.pid}`
}

function getSessionFilePath(sessionId: string): string {
  return path.join(globalTomDir(), 'sessions', `${sessionId}.json`)
}

// --- Session Analysis ---

/**
 * Reads a raw Tier 1 session log from disk.
 */
export function readRawSessionLog(sessionId: string): SessionLog | null {
  try {
    const filePath = getSessionFilePath(sessionId)
    const content = fs.readFileSync(filePath, 'utf-8')
    const raw = JSON.parse(content) as unknown
    const result = SessionLogSchema.safeParse(raw)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

/**
 * Heuristic extraction of SessionModel from SessionLog.
 * Mirrors the logic in agent/tools.ts extractSessionModel.
 */
export function extractSessionModel(sessionLog: SessionLog): SessionModel {
  const toolCounts: Record<string, number> = {}
  const codingPrefs: string[] = []
  const patterns: string[] = []
  let frustrationCount = 0
  let satisfactionCount = 0

  for (const interaction of sessionLog.interactions) {
    toolCounts[interaction.toolName] = (toolCounts[interaction.toolName] ?? 0) + 1

    const paramKeys = Object.keys(interaction.parameterShape)
    if (paramKeys.includes('language') || paramKeys.includes('file_path')) {
      const fileExt = interaction.parameterShape['file_path'] ?? ''
      if (fileExt && !codingPrefs.includes(fileExt)) {
        codingPrefs.push(fileExt)
      }
    }

    const outcome = interaction.outcomeSummary.toLowerCase()
    if (outcome.includes('error') || outcome.includes('fail') || outcome.includes('retry')) {
      frustrationCount++
    }
    if (outcome.includes('success') || outcome.includes('complete') || outcome.includes('pass')) {
      satisfactionCount++
    }
  }

  const sortedTools = Object.entries(toolCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([name]) => name)

  const topTool = sortedTools[0] ?? 'unknown'
  const intent = deriveIntent(topTool, sessionLog.interactions.length)

  for (const toolName of sortedTools.slice(0, 5)) {
    patterns.push(`uses-${toolName}`)
  }

  const totalInteractions = sessionLog.interactions.length
  const frustration = totalInteractions > 0 && frustrationCount / totalInteractions > 0.3
  const satisfaction = totalInteractions > 0 && satisfactionCount / totalInteractions > 0.5

  const urgency = totalInteractions > 20 ? 'high' as const
    : totalInteractions > 10 ? 'medium' as const
    : 'low' as const

  return {
    sessionId: sessionLog.sessionId,
    intent,
    interactionPatterns: patterns,
    codingPreferences: codingPrefs,
    satisfactionSignals: {
      frustration,
      satisfaction,
      urgency,
    },
  }
}

function deriveIntent(topTool: string, interactionCount: number): string {
  const toolIntentMap: Record<string, string> = {
    Edit: 'code modification',
    Write: 'file creation',
    Read: 'code exploration',
    Bash: 'command execution',
    Grep: 'code search',
    Glob: 'file search',
    Task: 'complex task delegation',
  }

  const baseIntent = toolIntentMap[topTool] ?? `${topTool} usage`
  const scope = interactionCount > 20 ? 'extensive' : interactionCount > 10 ? 'moderate' : 'brief'

  return `${scope} ${baseIntent}`
}

// --- Usage Logging ---

interface UsageLogEntry {
  readonly timestamp: string
  readonly operation: string
  readonly model: string
  readonly tokenCount: number
  readonly sessionId: string
}

function getUsageLogPath(): string {
  return path.join(globalTomDir(), 'usage.log')
}

export function logUsage(entry: UsageLogEntry): void {
  const logPath = getUsageLogPath()
  const dir = path.dirname(logPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  const line = JSON.stringify(entry) + '\n'
  fs.appendFileSync(logPath, line, 'utf-8')
}

// --- Main Analysis Pipeline ---

export interface AnalysisResult {
  readonly success: boolean
  readonly sessionId: string
  readonly sessionModel: SessionModel | null
  readonly userModelUpdated: boolean
  readonly indexRebuilt: boolean
  readonly error?: string
}

/**
 * Runs the full session analysis pipeline:
 * 1. Read Tier 1 session log
 * 2. Extract Tier 2 session model
 * 3. Aggregate into Tier 3 user model
 * 4. Rebuild BM25 index
 * 5. Log completion
 */
export function analyzeCompletedSession(sessionId: string): AnalysisResult {
  // Step 1: Read Tier 1 session log
  const sessionLog = readRawSessionLog(sessionId)
  if (!sessionLog) {
    return {
      success: false,
      sessionId,
      sessionModel: null,
      userModelUpdated: false,
      indexRebuilt: false,
      error: `Session log not found for ${sessionId}`,
    }
  }

  // Step 2: Extract Tier 2 session model
  const sessionModel = extractSessionModel(sessionLog)
  writeSessionModel(sessionModel, 'global')

  // Step 3: Aggregate into Tier 3 user model
  const currentUserModel = readUserModel('global')
  const emptyModel: UserModel = {
    preferencesClusters: [],
    interactionStyleSummary: '',
    codingStyleSummary: '',
    projectOverrides: {},
  }

  const updatedUserModel = aggregateSessionIntoModel(
    currentUserModel ?? emptyModel,
    sessionModel
  )
  writeUserModel(updatedUserModel, 'global')

  // Step 4: Rebuild BM25 index
  const index = buildMemoryIndex('global')
  const indexPath = path.join(globalTomDir(), 'bm25-index.json')
  const indexDir = path.dirname(indexPath)
  if (!fs.existsSync(indexDir)) {
    fs.mkdirSync(indexDir, { recursive: true })
  }
  fs.writeFileSync(indexPath, JSON.stringify(index), 'utf-8')

  // Step 5: Log completion
  logUsage({
    timestamp: new Date().toISOString(),
    operation: 'session-analysis',
    model: DEFAULT_MODEL,
    tokenCount: 0,
    sessionId,
  })

  return {
    success: true,
    sessionId,
    sessionModel,
    userModelUpdated: true,
    indexRebuilt: true,
  }
}

// --- CLI Entry Point ---

export function main(): void {
  if (!isTomEnabled()) {
    return
  }

  const sessionId = getSessionId()
  if (!sessionId) {
    return
  }

  try {
    analyzeCompletedSession(sessionId)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logUsage({
      timestamp: new Date().toISOString(),
      operation: 'session-analysis-error',
      model: DEFAULT_MODEL,
      tokenCount: 0,
      sessionId,
    })
    // Write error to stderr but don't throw — this runs in background
    process.stderr.write(`ToM stop-analyze error: ${errorMessage}\n`)
  }
}

// Run if executed directly
if (require.main === module) {
  main()
}
