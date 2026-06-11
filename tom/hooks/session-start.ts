/**
 * SessionStart hook: injects a compact summary of the learned user model
 * as additionalContext at the start of each session.
 *
 * Reads the merged user model (global + project) via memory-io. When a model
 * exists, emits the documented SessionStart hookSpecificOutput JSON with the
 * top confident preferences and interaction/coding style summaries.
 * Exits silently when ToM is disabled, internally invoked, or no model exists.
 */

import type { UserModel } from '../schemas.js'
import { readUserModel } from '../memory-io.js'
import { isTomEnabled } from '../config.js'
import { logUsage } from '../routing.js'
import { readHookInput, getSessionId, isExcludedSession } from './hook-input.js'

// --- Configuration ---

/** Preferences below this confidence are omitted from the summary. */
const MIN_CONFIDENCE = 0.5

/** Cap on preference lines so the summary stays ~10 lines total. */
const MAX_PREFERENCE_LINES = 7

// --- Summary ---

/**
 * Builds a compact, human-readable summary of the user model.
 * Returns null when the model carries no confident preferences and
 * no style summaries (nothing worth injecting).
 *
 * Promoted preferences are excluded: they already ride along via their
 * CLAUDE.md marker block, and double-injection wastes context budget.
 */
export function buildModelSummary(model: UserModel): string | null {
  const confidentPrefs = [...model.preferencesClusters]
    .filter(p => p.confidence >= MIN_CONFIDENCE && p.promoted !== true)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_PREFERENCE_LINES)

  const lines: string[] = []

  if (confidentPrefs.length > 0) {
    lines.push('ToM user preferences (learned across sessions):')
    for (const pref of confidentPrefs) {
      const confidencePercent = Math.round(pref.confidence * 100)
      lines.push(`- ${pref.category}/${pref.key}: ${pref.value} (${confidencePercent}%)`)
    }
  }

  if (model.interactionStyleSummary) {
    lines.push(`Interaction style: ${model.interactionStyleSummary}`)
  }
  if (model.codingStyleSummary) {
    lines.push(`Coding style: ${model.codingStyleSummary}`)
  }

  return lines.length > 0 ? lines.join('\n') : null
}

// --- Hook Output ---

export interface SessionStartHookOutput {
  readonly hookSpecificOutput: {
    readonly hookEventName: 'SessionStart'
    readonly additionalContext: string
  }
}

/**
 * Builds the documented SessionStart JSON stdout shape that injects
 * context for Claude at session start.
 */
export function buildHookOutput(summary: string): SessionStartHookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: summary,
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
  if (!isTomEnabled()) {
    return
  }

  const input = await readHookInput(stream)

  const model = readUserModel('merged')
  if (!model) {
    return
  }

  const summary = buildModelSummary(model)
  if (!summary) {
    return
  }

  process.stdout.write(JSON.stringify(buildHookOutput(summary)))

  // Injected-context volume is a first-class metric (over-injection is a
  // failure mode): record what this injection cost in context budget.
  const summaryLines = summary.split('\n')
  logUsage({
    timestamp: new Date().toISOString(),
    operation: 'session-start-injection',
    model: 'none',
    tokenCount: 0,
    sessionId: getSessionId(input),
    detail: {
      chars: summary.length,
      lines: summaryLines.length,
      preferences: summaryLines.filter(l => l.startsWith('- ')).length,
    },
  })
}

// Run if executed directly
if (require.main === module) {
  void main()
}
