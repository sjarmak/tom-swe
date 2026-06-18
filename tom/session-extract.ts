/**
 * Heuristic extraction of a Tier 2 SessionModel from a Tier 1 SessionLog.
 *
 * Shared by the Stop hook (fallback path when LLM analysis fails) and the
 * ToM agent's analyze_session tool:
 * - Intent derived from the most common tool patterns
 * - Satisfaction signals from outcome summaries
 *
 * Coding preferences, interaction patterns, and corrections require semantic
 * understanding the heuristic path does not have, so they are left empty here.
 * Only the LLM analysis path populates them; the fallback never guesses.
 */

import type { SessionLog, SessionModel } from './schemas.js'

export function extractSessionModel(sessionLog: SessionLog): SessionModel {
  const toolCounts: Record<string, number> = {}
  let frustrationCount = 0
  let satisfactionCount = 0

  for (const interaction of sessionLog.interactions) {
    toolCounts[interaction.toolName] = (toolCounts[interaction.toolName] ?? 0) + 1

    // Detect satisfaction from outcomes
    const outcome = interaction.outcomeSummary.toLowerCase()
    if (outcome.includes('error') || outcome.includes('fail') || outcome.includes('retry')) {
      frustrationCount++
    }
    if (outcome.includes('success') || outcome.includes('complete') || outcome.includes('pass')) {
      satisfactionCount++
    }
  }

  // Derive intent from most-used tools
  const sortedTools = Object.entries(toolCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([name]) => name)

  const topTool = sortedTools[0] ?? 'unknown'
  const intent = deriveIntent(topTool, sessionLog.interactions.length)

  const totalInteractions = sessionLog.interactions.length
  const frustration = totalInteractions > 0 && frustrationCount / totalInteractions > 0.3
  const satisfaction = totalInteractions > 0 && satisfactionCount / totalInteractions > 0.5

  const urgency = totalInteractions > 20 ? 'high' as const
    : totalInteractions > 10 ? 'medium' as const
    : 'low' as const

  return {
    sessionId: sessionLog.sessionId,
    intent,
    // Interaction patterns, coding preferences, and corrections all require
    // semantic understanding the heuristic path lacks. Only the LLM analysis
    // path populates them; the fallback never guesses.
    interactionPatterns: [],
    codingPreferences: [],
    satisfactionSignals: {
      frustration,
      satisfaction,
      urgency,
    },
    corrections: [],
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
