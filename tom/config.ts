/**
 * ToM configuration schema and opt-in system.
 *
 * Provides a Zod-validated configuration schema for the ToM system,
 * read from ~/.claude/tom/config.json.
 * All hooks use isTomEnabled() as a guard before executing.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { z } from 'zod'

import { logUsage } from './routing.js'

// --- Configuration Schema ---

export const TomConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  consultThreshold: z.enum(['low', 'medium', 'high']).default('medium'),
  models: z.strictObject({
    memoryUpdate: z.string().default('haiku'),
    consultation: z.string().default('sonnet'),
  }).default({ memoryUpdate: 'haiku', consultation: 'sonnet' }),
  // Floored at 1 day: a sub-2h window would let Tier 1 time-expiry unlink a
  // still-active session's log (defeating the prune active guard), and a
  // near-zero decay window collapses Tier 2 retention and the decay half-life.
  preferenceDecayDays: z.number().min(1).default(30),
  maxSessionsRetained: z.number().default(100),
  // Confidence multiplier applied to a stored preference when a session
  // correction contradicts it (post-action feedback). Corrections cut
  // confidence faster than repetition builds it.
  correctionPenalty: z.number().min(0).max(1).default(0.5),
})

export type TomConfig = z.infer<typeof TomConfigSchema>

// --- Reading Configuration ---

/**
 * Logs an existing-but-invalid config file. Defaults have enabled=false,
 * so an unnoticed typo silently turns the whole plugin off — this entry is
 * the only signal. One entry per hook invocation while the file stays
 * broken is deliberate volume: silence was the bug (fail-closed strictObject
 * semantics themselves are documented intent and unchanged).
 */
/**
 * Drops config keys retired by past versions before validation, so an upgraded
 * install that still carries a hand-customized value does not fail the
 * strictObject schema and silently disable the plugin (defaults are
 * enabled=false). Currently strips `promotion` — the retired CLAUDE.md
 * promotion feature (tom-swe-x1m.2).
 */
function stripRetiredConfigKeys(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return raw
  }
  const { promotion: _promotion, ...rest } = raw as Record<string, unknown>
  return rest
}

function logInvalidConfig(reason: string): void {
  try {
    logUsage({
      timestamp: new Date().toISOString(),
      operation: 'config-invalid',
      model: 'none',
      tokenCount: 0,
      reason: reason.slice(0, 500),
    })
  } catch {
    // Telemetry must never break config reading.
  }
}

/**
 * Reads ~/.claude/tom/config.json, validates it against the Zod schema,
 * and returns a fully-defaulted TomConfig.
 *
 * Returns all defaults when the file is missing (normal before /tom-setup,
 * silent) — and ALSO when it exists but is malformed or fails validation,
 * which is logged as a typed 'config-invalid' entry because the default
 * enabled=false disables the plugin.
 */
export function readTomConfig(): TomConfig {
  const configPath = path.join(os.homedir(), '.claude', 'tom', 'config.json')

  let content: string
  try {
    content = fs.readFileSync(configPath, 'utf-8')
  } catch {
    return TomConfigSchema.parse({})
  }

  try {
    const raw = JSON.parse(content) as unknown
    const result = TomConfigSchema.safeParse(stripRetiredConfigKeys(raw))
    if (result.success) {
      return result.data
    }
    logInvalidConfig(result.error.message)
    return TomConfigSchema.parse({})
  } catch (error) {
    logInvalidConfig(error instanceof Error ? error.message : String(error))
    return TomConfigSchema.parse({})
  }
}

// --- Guard ---

/**
 * Returns true if ToM is enabled in settings.
 * Used as a guard in all hooks to skip execution when disabled.
 */
export function isTomEnabled(): boolean {
  return readTomConfig().enabled
}
