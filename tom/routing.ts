/**
 * Smart model routing configuration and usage logging.
 *
 * Provides configurable model selection for ToM operations
 * and centralized usage logging for cost tracking.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { z } from 'zod'

import { globalTomDir } from './memory-io.js'

// --- Types ---

export type OperationType = 'memoryUpdate' | 'consultation' | 'profileInit'

/**
 * Telemetry schema version, stamped on every usage.log entry so external
 * consumers (the mem eval harness, future analysis agents) can parse old
 * logs after the format evolves.
 */
export const TELEMETRY_SCHEMA_VERSION = 1

export interface UsageLogEntry {
  /** Schema version; stamped by logUsage when absent. */
  readonly v?: number
  readonly timestamp: string
  readonly operation: string
  readonly model: string
  readonly tokenCount: number
  readonly sessionId?: string
  /** Wall-clock duration of the operation, when measured. */
  readonly durationMs?: number
  /** Short human-readable explanation (error text, fallback cause). */
  readonly reason?: string
  /** Structured machine-readable fields for eval consumers. */
  readonly detail?: Readonly<Record<string, unknown>>
}

/**
 * Validates one usage.log line. Loose by design: unknown fields pass
 * through so newer entries remain readable by older consumers.
 */
export const UsageLogEntrySchema = z
  .looseObject({
    v: z.number().optional(),
    timestamp: z.string(),
    operation: z.string(),
    model: z.string(),
    tokenCount: z.number(),
    sessionId: z.string().optional(),
    durationMs: z.number().optional(),
    reason: z.string().optional(),
    detail: z.record(z.string(), z.unknown()).optional(),
  })

export interface UsageLogReadResult {
  readonly entries: readonly UsageLogEntry[]
  readonly invalidLines: number
}

// --- Defaults ---

const DEFAULT_MODELS: Record<OperationType, string> = {
  memoryUpdate: 'haiku',
  consultation: 'sonnet',
  profileInit: 'sonnet',
}

// Maps operation types to settings.json config keys
const OPERATION_CONFIG_KEY: Record<OperationType, string> = {
  memoryUpdate: 'memoryUpdate',
  consultation: 'consultation',
  profileInit: 'consultation',
}

// --- Model Routing ---

/**
 * Returns the model name for the given operation type.
 * Reads from models.{key} in ~/.claude/tom/config.json,
 * falling back to defaults if not configured.
 */
export function getModelForOperation(operation: OperationType): string {
  const defaultModel = DEFAULT_MODELS[operation]
  const configKey = OPERATION_CONFIG_KEY[operation]

  try {
    const configPath = path.join(os.homedir(), '.claude', 'tom', 'config.json')
    const content = fs.readFileSync(configPath, 'utf-8')
    const config = JSON.parse(content) as Record<string, unknown>
    const models = config['models'] as Record<string, unknown> | undefined
    const configuredModel = models?.[configKey]

    if (typeof configuredModel === 'string' && configuredModel.length > 0) {
      return configuredModel
    }

    return defaultModel
  } catch {
    return defaultModel
  }
}

// --- Usage Logging ---

/** Store permissions: match fs-atomic's 0700 dirs / 0600 files. */
const LOG_DIR_MODE = 0o700
const LOG_FILE_MODE = 0o600

/**
 * Appends a usage log entry as a JSON line to tom/usage.log, stamping the
 * telemetry schema version. Creates directories if they do not exist.
 */
export function logUsage(entry: UsageLogEntry): void {
  const logPath = path.join(globalTomDir(), 'usage.log')
  const dir = path.dirname(logPath)

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: LOG_DIR_MODE })
  }

  const stamped: UsageLogEntry = { v: TELEMETRY_SCHEMA_VERSION, ...entry }
  const line = JSON.stringify(stamped) + '\n'
  fs.appendFileSync(logPath, line, { encoding: 'utf-8', mode: LOG_FILE_MODE })
}

// --- Rotation ---

/**
 * Rotation threshold. The log grew ~3.7MB in 24 days on the dogfooding rig
 * (~250MB/yr unrotated); pruning.ts prevents unbounded growth for every
 * other store file, and this closes the usage.log gap.
 */
export const USAGE_LOG_ROTATE_BYTES = 5 * 1024 * 1024

/**
 * Archives usage.log to usage-YYYY-MM-DD[-n].log once it exceeds the size
 * threshold. Archives are preserved, never deleted — external eval
 * consumers read the raw log history. Called from the Stop hook's prune
 * step; concurrent callers race benignly (rename is atomic, the loser's
 * rename fails and is swallowed as already-rotated).
 */
export function rotateUsageLogIfNeeded(
  maxBytes: number = USAGE_LOG_ROTATE_BYTES
): boolean {
  const logPath = path.join(globalTomDir(), 'usage.log')
  try {
    if (fs.statSync(logPath).size <= maxBytes) {
      return false
    }
  } catch {
    return false // No log yet.
  }

  const day = new Date().toISOString().slice(0, 10)
  let archivePath = path.join(globalTomDir(), `usage-${day}.log`)
  for (let n = 1; fs.existsSync(archivePath); n++) {
    archivePath = path.join(globalTomDir(), `usage-${day}-${n}.log`)
  }
  try {
    fs.renameSync(logPath, archivePath)
  } catch {
    return false // A concurrent rotation won — the log is already fresh.
  }
  logUsage({
    timestamp: new Date().toISOString(),
    operation: 'usage-log-rotated',
    model: 'none',
    tokenCount: 0,
    detail: { archive: path.basename(archivePath) },
  })
  return true
}

/**
 * Reads and validates the usage log. Lines that fail to parse or validate
 * are counted, not silently dropped, so consumers can surface corruption.
 * Returns empty results when the log does not exist yet.
 */
export function readUsageLog(): UsageLogReadResult {
  const logPath = path.join(globalTomDir(), 'usage.log')

  let content: string
  try {
    content = fs.readFileSync(logPath, 'utf-8')
  } catch {
    return { entries: [], invalidLines: 0 }
  }

  const entries: UsageLogEntry[] = []
  let invalidLines = 0

  for (const line of content.split('\n')) {
    if (line.trim() === '') {
      continue
    }
    try {
      const parsed = UsageLogEntrySchema.safeParse(JSON.parse(line))
      if (parsed.success) {
        entries.push(parsed.data as UsageLogEntry)
      } else {
        invalidLines += 1
      }
    } catch {
      invalidLines += 1
    }
  }

  return { entries, invalidLines }
}
