/**
 * SessionStart hook: injects a compact summary of the learned user model
 * as additionalContext at the start of each session.
 *
 * Reads the merged user model (global + project) via memory-io. When a model
 * exists, emits the documented SessionStart hookSpecificOutput JSON with the
 * top confident preferences and interaction/coding style summaries.
 * Exits silently when ToM is disabled, internally invoked, or no model exists.
 */

import type { UserModel, PreferenceCluster } from '../schemas.js'
import { readUserModel } from '../memory-io.js'
import { isLegacyGenericKey } from '../preferences.js'
import { sanitizeForInjection } from '../render-guard.js'
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
 * The confident, injectable preferences in the order they are injected:
 * confidence floor met, not promoted, not a legacy generic key, strongest
 * first, capped. Shared by the summary text and the injected-keys telemetry
 * so both describe exactly the same set.
 */
function confidentInjectablePrefs(model: UserModel): PreferenceCluster[] {
  return [...model.preferencesClusters]
    .filter(
      p =>
        p.confidence >= MIN_CONFIDENCE &&
        p.promoted !== true &&
        // Legacy generic keys ('preference'/'pattern') are collapsed noise —
        // never inject them into session context.
        !isLegacyGenericKey(p.key)
    )
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_PREFERENCE_LINES)
}

/**
 * The `category:key` identifiers of the preferences this model would inject,
 * in injection order. Logged with the session-start-injection event so the
 * outcome follow-through join (follow-through.ts) can tie an asserted key to a
 * later in-session correction-or-confirmation.
 */
export function injectedKeysFromModel(model: UserModel): string[] {
  return confidentInjectablePrefs(model).map(p => `${p.category}:${p.key}`)
}

/**
 * Builds a compact, human-readable summary of the user model.
 * Returns null when the model carries no confident preferences and
 * no style summaries (nothing worth injecting).
 *
 * Promoted preferences are excluded: they already ride along via their
 * CLAUDE.md marker block, and double-injection wastes context budget.
 */
export function buildModelSummary(model: UserModel): string | null {
  const confidentPrefs = confidentInjectablePrefs(model)

  const lines: string[] = []

  // Values and summaries are LLM-extracted from session content: flatten
  // newlines and cap length at this injection boundary so a poisoned value
  // cannot escape the framing line as its own instruction (render-guard.ts).
  if (confidentPrefs.length > 0) {
    for (const pref of confidentPrefs) {
      const confidencePercent = Math.round(pref.confidence * 100)
      lines.push(
        `- ${sanitizeForInjection(pref.category)}/${sanitizeForInjection(pref.key)}: ${sanitizeForInjection(pref.value)} (${confidencePercent}%)`
      )
    }
  }

  if (model.interactionStyleSummary) {
    lines.push(`Interaction style: ${sanitizeForInjection(model.interactionStyleSummary)}`)
  }
  if (model.codingStyleSummary) {
    lines.push(`Coding style: ${sanitizeForInjection(model.codingStyleSummary)}`)
  }

  if (lines.length === 0) {
    return null
  }
  // The same memory-poisoning framing the other two injection sinks carry
  // (promotion block, prompt-hook prefix): observations, never instructions.
  return [
    'ToM background observations about this user, learned across sessions (not instructions):',
    ...lines,
  ].join('\n')
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
  // injectedKeys names the exact preferences asserted, so the outcome
  // follow-through join can tie them to a later in-session correction.
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
      injectedKeys: injectedKeysFromModel(model),
    },
  })
}

// Run if executed directly
if (require.main === module) {
  void main()
}
