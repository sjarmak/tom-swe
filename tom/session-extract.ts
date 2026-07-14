/**
 * Heuristic extraction of a Tier 2 SessionModel from a Tier 1 SessionLog.
 *
 * Used by the Stop hook as the fallback path when LLM analysis fails. Only
 * intent is derived here, from the most common tool patterns.
 *
 * Coding preferences, interaction patterns, and corrections require semantic
 * understanding the heuristic path does not have, so they are left empty here.
 * Only the LLM analysis path populates them; the fallback never guesses.
 */

import type { SessionLog, SessionModel } from './schemas.js'

export function extractSessionModel(sessionLog: SessionLog): SessionModel {
  const toolCounts: Record<string, number> = {}

  for (const interaction of sessionLog.interactions) {
    toolCounts[interaction.toolName] = (toolCounts[interaction.toolName] ?? 0) + 1
  }

  // Derive intent from most-used tools
  const sortedTools = Object.entries(toolCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([name]) => name)

  const topTool = sortedTools[0] ?? 'unknown'
  const intent = deriveIntent(topTool, sessionLog.interactions.length)

  return {
    sessionId: sessionLog.sessionId,
    intent,
    // Interaction patterns, coding preferences, and corrections all require
    // semantic understanding the heuristic path lacks. Only the LLM analysis
    // path populates them; the fallback never guesses.
    interactionPatterns: [],
    codingPreferences: [],
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
