/**
 * Smart model routing configuration and usage logging.
 *
 * Provides configurable model selection for ToM operations
 * and centralized usage logging for cost tracking.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import { globalTomDir } from './memory-io.js'

// --- Types ---

export type OperationType = 'memoryUpdate' | 'consultation' | 'profileInit'

interface UsageLogEntry {
  readonly timestamp: string
  readonly operation: string
  readonly model: string
  readonly tokenCount: number
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
 * Reads from tom.models.{key} in ~/.claude/settings.json,
 * falling back to defaults if not configured.
 */
export function getModelForOperation(operation: OperationType): string {
  const defaultModel = DEFAULT_MODELS[operation]
  const configKey = OPERATION_CONFIG_KEY[operation]

  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')
    const content = fs.readFileSync(settingsPath, 'utf-8')
    const settings = JSON.parse(content) as Record<string, unknown>
    const tom = settings['tom'] as Record<string, unknown> | undefined
    const models = tom?.['models'] as Record<string, unknown> | undefined
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

/**
 * Appends a usage log entry as a JSON line to tom/usage.log.
 * Creates directories if they do not exist.
 */
export function logUsage(entry: UsageLogEntry): void {
  const logPath = path.join(globalTomDir(), 'usage.log')
  const dir = path.dirname(logPath)

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const line = JSON.stringify(entry) + '\n'
  fs.appendFileSync(logPath, line, 'utf-8')
}
