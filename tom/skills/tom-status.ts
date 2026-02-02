/**
 * /tom status skill — displays the current state of the ToM model,
 * session count, preference summary, and configuration.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { readUserModel, globalTomDir, projectTomDir } from '../memory-io.js'
import { readTomConfig } from '../config.js'
import type { UserModel, PreferenceCluster } from '../schemas.js'

// --- Types ---

export interface StorageStats {
  readonly tier1SessionCount: number
  readonly tier2ModelCount: number
  readonly tier3SizeBytes: number
}

export interface StatusOutput {
  readonly hasModel: boolean
  readonly config: {
    readonly enabled: boolean
    readonly consultThreshold: string
    readonly models: {
      readonly memoryUpdate: string
      readonly consultation: string
    }
    readonly preferenceDecayDays: number
    readonly maxSessionsRetained: number
  }
  readonly storage: StorageStats
  readonly topPreferences: readonly PreferenceCluster[]
  readonly interactionStyleSummary: string
  readonly codingStyleSummary: string
}

// --- Helpers ---

function countJsonFiles(dirPath: string): number {
  try {
    const entries = fs.readdirSync(dirPath)
    return entries.filter((e) => e.endsWith('.json')).length
  } catch {
    return 0
  }
}

function getFileSize(filePath: string): number {
  try {
    const stat = fs.statSync(filePath)
    return stat.size
  } catch {
    return 0
  }
}

function getStorageStats(): StorageStats {
  const globalSessions = path.join(globalTomDir(), 'sessions')
  const projectSessions = path.join(projectTomDir(), 'sessions')

  const globalModels = path.join(globalTomDir(), 'session-models')
  const projectModels = path.join(projectTomDir(), 'session-models')

  const globalUserModelFile = path.join(globalTomDir(), 'user-model.json')
  const projectUserModelFile = path.join(projectTomDir(), 'user-model.json')

  return {
    tier1SessionCount:
      countJsonFiles(globalSessions) + countJsonFiles(projectSessions),
    tier2ModelCount:
      countJsonFiles(globalModels) + countJsonFiles(projectModels),
    tier3SizeBytes:
      getFileSize(globalUserModelFile) + getFileSize(projectUserModelFile),
  }
}

function getTopPreferences(
  model: UserModel,
  limit: number = 10
): readonly PreferenceCluster[] {
  const sorted = [...model.preferencesClusters].sort(
    (a, b) => b.confidence - a.confidence
  )
  return sorted.slice(0, limit)
}

// --- Main ---

export function getStatus(): StatusOutput {
  const config = readTomConfig()
  const userModel = readUserModel('merged')
  const storage = getStorageStats()

  if (userModel === null) {
    return {
      hasModel: false,
      config: {
        enabled: config.enabled,
        consultThreshold: config.consultThreshold,
        models: {
          memoryUpdate: config.models.memoryUpdate,
          consultation: config.models.consultation,
        },
        preferenceDecayDays: config.preferenceDecayDays,
        maxSessionsRetained: config.maxSessionsRetained,
      },
      storage,
      topPreferences: [],
      interactionStyleSummary: '',
      codingStyleSummary: '',
    }
  }

  return {
    hasModel: true,
    config: {
      enabled: config.enabled,
      consultThreshold: config.consultThreshold,
      models: {
        memoryUpdate: config.models.memoryUpdate,
        consultation: config.models.consultation,
      },
      preferenceDecayDays: config.preferenceDecayDays,
      maxSessionsRetained: config.maxSessionsRetained,
    },
    storage,
    topPreferences: getTopPreferences(userModel),
    interactionStyleSummary: userModel.interactionStyleSummary,
    codingStyleSummary: userModel.codingStyleSummary,
  }
}

export function formatStatus(status: StatusOutput): string {
  const lines: string[] = []

  lines.push('# ToM Status')
  lines.push('')

  // Configuration
  lines.push('## Configuration')
  lines.push(`- Enabled: ${status.config.enabled ? 'Yes' : 'No'}`)
  lines.push(`- Consult Threshold: ${status.config.consultThreshold}`)
  lines.push(
    `- Models: memoryUpdate=${status.config.models.memoryUpdate}, consultation=${status.config.models.consultation}`
  )
  lines.push(`- Preference Decay: ${status.config.preferenceDecayDays} days`)
  lines.push(`- Max Sessions Retained: ${status.config.maxSessionsRetained}`)
  lines.push('')

  // Storage
  lines.push('## Storage')
  lines.push(`- Tier 1 Sessions: ${status.storage.tier1SessionCount}`)
  lines.push(`- Tier 2 Models: ${status.storage.tier2ModelCount}`)
  lines.push(
    `- Tier 3 User Model: ${formatBytes(status.storage.tier3SizeBytes)}`
  )
  lines.push('')

  // User Model
  if (!status.hasModel) {
    lines.push(
      'No user model found. ToM will begin learning after your first session.'
    )
    return lines.join('\n')
  }

  lines.push('## Sessions Analyzed')
  lines.push(`- Total: ${status.storage.tier1SessionCount}`)
  lines.push('')

  // Top Preferences
  if (status.topPreferences.length > 0) {
    lines.push('## Top Preferences (by confidence)')
    for (const pref of status.topPreferences) {
      const confidence = (pref.confidence * 100).toFixed(0)
      lines.push(
        `- [${pref.category}] ${pref.key}: ${pref.value} (${confidence}% confidence, ${pref.sessionCount} sessions)`
      )
    }
    lines.push('')
  }

  // Summaries
  if (status.interactionStyleSummary) {
    lines.push('## Interaction Style')
    lines.push(status.interactionStyleSummary)
    lines.push('')
  }

  if (status.codingStyleSummary) {
    lines.push('## Coding Style')
    lines.push(status.codingStyleSummary)
    lines.push('')
  }

  return lines.join('\n')
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// --- CLI Entry Point ---

export function main(): void {
  const status = getStatus()
  const output = formatStatus(status)
  process.stdout.write(output)
}

if (require.main === module) {
  main()
}
