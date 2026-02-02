/**
 * ToM configuration schema and opt-in system.
 *
 * Provides a Zod-validated configuration schema for the ToM system,
 * read from ~/.claude/settings.json under the "tom" key.
 * All hooks use isTomEnabled() as a guard before executing.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { z } from 'zod'

// --- Configuration Schema ---

export const TomConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  consultThreshold: z.enum(['low', 'medium', 'high']).default('medium'),
  models: z.strictObject({
    memoryUpdate: z.string().default('haiku'),
    consultation: z.string().default('sonnet'),
  }).default({ memoryUpdate: 'haiku', consultation: 'sonnet' }),
  preferenceDecayDays: z.number().default(30),
  maxSessionsRetained: z.number().default(100),
})

export type TomConfig = z.infer<typeof TomConfigSchema>

// --- Reading Configuration ---

/**
 * Reads the "tom" key from ~/.claude/settings.json,
 * validates it against the Zod schema, and returns
 * a fully-defaulted TomConfig.
 *
 * Returns all defaults if the file is missing, unreadable,
 * or the tom key is absent/invalid.
 */
export function readTomConfig(): TomConfig {
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')
    const content = fs.readFileSync(settingsPath, 'utf-8')
    const settings = JSON.parse(content) as Record<string, unknown>
    const tomRaw = settings['tom']

    if (tomRaw === undefined || tomRaw === null) {
      return TomConfigSchema.parse({})
    }

    const result = TomConfigSchema.safeParse(tomRaw)
    if (result.success) {
      return result.data
    }

    // If validation fails, return defaults
    return TomConfigSchema.parse({})
  } catch {
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
