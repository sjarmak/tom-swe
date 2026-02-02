/**
 * /tom inspect skill — displays exactly what data the ToM system
 * has stored about the user, including all sessions and the full
 * Tier 3 user model in human-readable format.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  readUserModel,
  readSessionModel,
  globalTomDir,
  projectTomDir,
} from '../memory-io.js'
import { readTomConfig } from '../config.js'
import type { UserModel, SessionModel, PreferenceCluster } from '../schemas.js'

// --- Types ---

export interface SessionEntry {
  readonly sessionId: string
  readonly date: string
  readonly intent: string
  readonly scope: 'global' | 'project'
  readonly willBePruned: boolean
}

export interface InspectOutput {
  readonly sessions: readonly SessionEntry[]
  readonly userModel: UserModel | null
  readonly maxSessionsRetained: number
  readonly totalSessionCount: number
  readonly pruneCount: number
}

// --- Helpers ---

interface RawSessionFile {
  readonly sessionId: string
  readonly startedAt: string
  readonly filename: string
  readonly scope: 'global' | 'project'
}

function listSessionFiles(
  dirPath: string,
  scope: 'global' | 'project'
): readonly RawSessionFile[] {
  const results: RawSessionFile[] = []

  try {
    const entries = fs.readdirSync(dirPath)
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue

      const filePath = path.join(dirPath, entry)
      try {
        const content = fs.readFileSync(filePath, 'utf-8')
        const parsed = JSON.parse(content) as Record<string, unknown>
        const sessionId =
          typeof parsed['sessionId'] === 'string' ? parsed['sessionId'] : ''
        const startedAt =
          typeof parsed['startedAt'] === 'string' ? parsed['startedAt'] : ''

        if (sessionId && startedAt) {
          results.push({ sessionId, startedAt, filename: entry, scope })
        }
      } catch {
        // Skip invalid files
      }
    }
  } catch {
    // Directory doesn't exist
  }

  return results
}

function getSessionIntent(
  sessionId: string,
  scope: 'global' | 'project'
): string {
  const model: SessionModel | null = readSessionModel(sessionId, scope)
  return model !== null ? model.intent : ''
}

function formatDate(isoString: string): string {
  try {
    const date = new Date(isoString)
    return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
  } catch {
    return isoString
  }
}

// --- Main ---

export function getInspectData(): InspectOutput {
  const config = readTomConfig()
  const maxRetained = config.maxSessionsRetained

  const globalSessions = listSessionFiles(
    path.join(globalTomDir(), 'sessions'),
    'global'
  )
  const projectSessions = listSessionFiles(
    path.join(projectTomDir(), 'sessions'),
    'project'
  )

  // Deduplicate sessions (same sessionId from global and project)
  const seenIds = new Set<string>()
  const allSessions: RawSessionFile[] = []

  for (const s of globalSessions) {
    if (!seenIds.has(s.sessionId)) {
      seenIds.add(s.sessionId)
      allSessions.push(s)
    }
  }
  for (const s of projectSessions) {
    if (!seenIds.has(s.sessionId)) {
      seenIds.add(s.sessionId)
      allSessions.push(s)
    }
  }

  // Sort by startedAt ascending (oldest first)
  allSessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt))

  const totalCount = allSessions.length
  // Sessions that will be pruned on next session addition
  // If adding one more session would exceed maxRetained, the oldest get pruned
  const pruneCount =
    totalCount >= maxRetained ? totalCount - maxRetained + 1 : 0

  const sessions: SessionEntry[] = allSessions.map((s, index) => ({
    sessionId: s.sessionId,
    date: s.startedAt,
    intent: getSessionIntent(s.sessionId, s.scope),
    scope: s.scope,
    willBePruned: index < pruneCount,
  }))

  const userModel = readUserModel('merged')

  return {
    sessions,
    userModel,
    maxSessionsRetained: maxRetained,
    totalSessionCount: totalCount,
    pruneCount,
  }
}

// --- Formatting ---

function formatPreferenceCluster(pref: PreferenceCluster): string {
  const confidence = (pref.confidence * 100).toFixed(0)
  const date = formatDate(pref.lastUpdated)
  return `  - ${pref.key}: ${pref.value} (${confidence}% confidence, ${pref.sessionCount} sessions, last updated ${date})`
}

function formatUserModelSection(model: UserModel): string {
  const lines: string[] = []

  lines.push('## User Model (Tier 3)')
  lines.push('')

  // Group preferences by category
  const categories = new Map<string, PreferenceCluster[]>()
  for (const pref of model.preferencesClusters) {
    const existing = categories.get(pref.category) ?? []
    categories.set(pref.category, [...existing, pref])
  }

  if (categories.size > 0) {
    lines.push('### Preferences')
    lines.push('')

    for (const [category, prefs] of categories) {
      const sorted = [...prefs].sort((a, b) => b.confidence - a.confidence)
      lines.push(`**${category}**`)
      for (const pref of sorted) {
        lines.push(formatPreferenceCluster(pref))
      }
      lines.push('')
    }
  }

  if (model.interactionStyleSummary) {
    lines.push('### Interaction Style')
    lines.push(model.interactionStyleSummary)
    lines.push('')
  }

  if (model.codingStyleSummary) {
    lines.push('### Coding Style')
    lines.push(model.codingStyleSummary)
    lines.push('')
  }

  const overrideKeys = Object.keys(model.projectOverrides)
  if (overrideKeys.length > 0) {
    lines.push('### Project Overrides')
    for (const projectPath of overrideKeys) {
      const overrides = model.projectOverrides[projectPath]
      if (overrides && overrides.length > 0) {
        lines.push(`**${projectPath}**`)
        for (const pref of overrides) {
          lines.push(formatPreferenceCluster(pref))
        }
        lines.push('')
      }
    }
  }

  return lines.join('\n')
}

export function formatInspect(data: InspectOutput): string {
  const lines: string[] = []

  lines.push('# ToM Inspect')
  lines.push('')

  // Sessions section
  lines.push('## Stored Sessions')
  lines.push('')

  if (data.sessions.length === 0) {
    lines.push('No sessions stored.')
    lines.push('')
  } else {
    lines.push(
      `${data.totalSessionCount} session(s) stored (max: ${data.maxSessionsRetained})`
    )
    lines.push('')

    if (data.pruneCount > 0) {
      lines.push(
        `**Warning:** ${data.pruneCount} session(s) will be pruned on next session analysis.`
      )
      lines.push('')
    }

    for (const session of data.sessions) {
      const pruneMarker = session.willBePruned ? ' [WILL BE PRUNED]' : ''
      const intentPart =
        session.intent !== '' ? ` — ${session.intent}` : ' — (no analysis)'
      lines.push(
        `- **${session.sessionId}** (${formatDate(session.date)}, ${session.scope})${intentPart}${pruneMarker}`
      )
    }
    lines.push('')
  }

  // User Model section
  if (data.userModel === null) {
    lines.push('## User Model (Tier 3)')
    lines.push('')
    lines.push('No user model found. ToM will begin learning after your first session.')
    lines.push('')
  } else {
    lines.push(formatUserModelSection(data.userModel))
  }

  return lines.join('\n')
}

// --- CLI Entry Point ---

export function main(): void {
  const data = getInspectData()
  const output = formatInspect(data)
  process.stdout.write(output)
}

if (require.main === module) {
  main()
}
