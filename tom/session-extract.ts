/**
 * Heuristic extraction of a Tier 2 SessionModel from a Tier 1 SessionLog.
 *
 * Shared by the Stop hook (fallback path when LLM analysis fails) and the
 * ToM agent's analyze_session tool:
 * - Intent derived from the most common tool patterns
 * - Coding preferences from tool parameter shapes
 * - Interaction patterns from tool usage sequences
 * - Satisfaction signals from outcome summaries
 */

import type { SessionLog, SessionModel } from './schemas.js'

export function extractSessionModel(sessionLog: SessionLog): SessionModel {
  const toolCounts: Record<string, number> = {}
  const codingPrefs: string[] = []
  const patterns: string[] = []
  let frustrationCount = 0
  let satisfactionCount = 0

  for (const interaction of sessionLog.interactions) {
    toolCounts[interaction.toolName] = (toolCounts[interaction.toolName] ?? 0) + 1

    // Extract coding preferences from parameter shapes
    const paramKeys = Object.keys(interaction.parameterShape)
    if (paramKeys.includes('language') || paramKeys.includes('file_path')) {
      const fileExt = interaction.parameterShape['file_path'] ?? ''
      if (fileExt && !codingPrefs.includes(fileExt)) {
        codingPrefs.push(fileExt)
      }
    }

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

  // Derive interaction patterns from tool sequence
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
    // Heuristics cannot reliably detect corrections — contradiction requires
    // semantic understanding of the user's messages. Only the LLM analysis
    // path extracts corrections; the fallback never guesses.
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
