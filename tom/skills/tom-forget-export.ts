/**
 * /tom forget [session-id] — removes a specific session and rebuilds Tier 3.
 * /tom export — exports all ToM data to a single JSON file.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  readSessionLog,
  readSessionModel,
  readUserModel,
  writeUserModel,
  globalTomDir,
  projectTomDir,
} from '../memory-io.js'
import { readTomConfig } from '../config.js'
import { aggregateSessionIntoModel } from '../aggregation.js'
import { buildMemoryIndex } from '../agent/tools.js'
import type {
  SessionLog,
  SessionModel,
  UserModel,
} from '../schemas.js'
import type { TomConfig } from '../config.js'

// --- Types ---

export interface ForgetResult {
  readonly sessionId: string
  readonly tier1Deleted: boolean
  readonly tier2Deleted: boolean
  readonly tier3Rebuilt: boolean
}

export interface ExportData {
  readonly exportedAt: string
  readonly version: '1.0'
  readonly config: TomConfig
  readonly tier1Sessions: readonly SessionLog[]
  readonly tier2Models: readonly SessionModel[]
  readonly tier3UserModel: UserModel | null
  readonly usageLog: readonly string[]
}

// --- Forget ---

function deleteFile(filePath: string): boolean {
  try {
    fs.unlinkSync(filePath)
    return true
  } catch {
    return false
  }
}

function listJsonFiles(dirPath: string): readonly string[] {
  try {
    return fs.readdirSync(dirPath).filter(f => f.endsWith('.json'))
  } catch {
    return []
  }
}

function sessionFileExists(sessionId: string, scope: 'global' | 'project'): string | null {
  const tomDir = scope === 'global' ? globalTomDir() : projectTomDir()
  const filePath = path.join(tomDir, 'sessions', `${sessionId}.json`)
  return fs.existsSync(filePath) ? filePath : null
}

function sessionModelFileExists(sessionId: string, scope: 'global' | 'project'): string | null {
  const tomDir = scope === 'global' ? globalTomDir() : projectTomDir()
  const filePath = path.join(tomDir, 'session-models', `${sessionId}.json`)
  return fs.existsSync(filePath) ? filePath : null
}

/**
 * Rebuilds Tier 3 user model from scratch using all remaining
 * Tier 2 session models (after a session has been removed).
 */
function rebuildUserModel(scope: 'global' | 'project'): void {
  const tomDir = scope === 'global' ? globalTomDir() : projectTomDir()
  const modelsDir = path.join(tomDir, 'session-models')
  const files = listJsonFiles(modelsDir)
  const config = readTomConfig()

  const emptyModel: UserModel = {
    preferencesClusters: [],
    interactionStyleSummary: '',
    codingStyleSummary: '',
    projectOverrides: {},
  }

  let model = emptyModel

  // Sort by sessionId for deterministic ordering
  const sortedFiles = [...files].sort()

  for (const file of sortedFiles) {
    const sessionId = file.replace('.json', '')
    const sessionModel = readSessionModel(sessionId, scope)
    if (sessionModel) {
      model = aggregateSessionIntoModel(model, sessionModel, config.preferenceDecayDays)
    }
  }

  writeUserModel(model, scope)
}

/**
 * Forgets a specific session: deletes Tier 1 and Tier 2 files,
 * rebuilds Tier 3 user model without the deleted session's data.
 */
export function forgetSession(sessionId: string): ForgetResult {
  let tier1Deleted = false
  let tier2Deleted = false
  let tier3Rebuilt = false

  // Try both scopes
  for (const scope of ['global', 'project'] as const) {
    const sessionPath = sessionFileExists(sessionId, scope)
    if (sessionPath) {
      tier1Deleted = deleteFile(sessionPath) || tier1Deleted
    }

    const modelPath = sessionModelFileExists(sessionId, scope)
    if (modelPath) {
      tier2Deleted = deleteFile(modelPath) || tier2Deleted
    }

    if (tier1Deleted || tier2Deleted) {
      rebuildUserModel(scope)
      tier3Rebuilt = true

      // Rebuild BM25 index
      const index = buildMemoryIndex(scope)
      const tomDir = scope === 'global' ? globalTomDir() : projectTomDir()
      const indexPath = path.join(tomDir, 'bm25-index.json')
      const dir = path.dirname(indexPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      fs.writeFileSync(indexPath, JSON.stringify(index), 'utf-8')
    }
  }

  return { sessionId, tier1Deleted, tier2Deleted, tier3Rebuilt }
}

export function formatForgetResult(result: ForgetResult): string {
  const lines: string[] = []

  lines.push('# ToM Forget')
  lines.push('')

  if (!result.tier1Deleted && !result.tier2Deleted) {
    lines.push(`Session "${result.sessionId}" not found in any scope.`)
    return lines.join('\n')
  }

  lines.push(`Session "${result.sessionId}" has been removed:`)
  lines.push(`- Tier 1 session log: ${result.tier1Deleted ? 'deleted' : 'not found'}`)
  lines.push(`- Tier 2 session model: ${result.tier2Deleted ? 'deleted' : 'not found'}`)
  lines.push(`- Tier 3 user model: ${result.tier3Rebuilt ? 'rebuilt without this session' : 'unchanged'}`)

  return lines.join('\n')
}

// --- Export ---

function readUsageLog(): readonly string[] {
  const logPath = path.join(globalTomDir(), 'usage.log')
  try {
    const content = fs.readFileSync(logPath, 'utf-8')
    return content.split('\n').filter(line => line.trim().length > 0)
  } catch {
    return []
  }
}

function readAllSessions(scope: 'global' | 'project'): readonly SessionLog[] {
  const tomDir = scope === 'global' ? globalTomDir() : projectTomDir()
  const sessionsDir = path.join(tomDir, 'sessions')
  const files = listJsonFiles(sessionsDir)
  const sessions: SessionLog[] = []

  for (const file of files) {
    const sessionId = file.replace('.json', '')
    const session = readSessionLog(sessionId, scope)
    if (session) {
      sessions.push(session)
    }
  }

  return sessions
}

function readAllSessionModels(scope: 'global' | 'project'): readonly SessionModel[] {
  const tomDir = scope === 'global' ? globalTomDir() : projectTomDir()
  const modelsDir = path.join(tomDir, 'session-models')
  const files = listJsonFiles(modelsDir)
  const models: SessionModel[] = []

  for (const file of files) {
    const sessionId = file.replace('.json', '')
    const model = readSessionModel(sessionId, scope)
    if (model) {
      models.push(model)
    }
  }

  return models
}

function deduplicateById<T extends { readonly sessionId: string }>(
  global: readonly T[],
  project: readonly T[]
): readonly T[] {
  const seen = new Set<string>()
  const result: T[] = []

  for (const item of global) {
    if (!seen.has(item.sessionId)) {
      seen.add(item.sessionId)
      result.push(item)
    }
  }
  for (const item of project) {
    if (!seen.has(item.sessionId)) {
      seen.add(item.sessionId)
      result.push(item)
    }
  }

  return result
}

/**
 * Collects all ToM data (Tier 1, 2, 3, config, usage log) for export.
 */
export function collectExportData(): ExportData {
  const config = readTomConfig()
  const userModel = readUserModel('merged')
  const usageLog = readUsageLog()

  const globalSessions = readAllSessions('global')
  const projectSessions = readAllSessions('project')
  const allSessions = deduplicateById(globalSessions, projectSessions)

  const globalModels = readAllSessionModels('global')
  const projectModels = readAllSessionModels('project')
  const allModels = deduplicateById(globalModels, projectModels)

  return {
    exportedAt: new Date().toISOString(),
    version: '1.0',
    config,
    tier1Sessions: allSessions,
    tier2Models: allModels,
    tier3UserModel: userModel,
    usageLog,
  }
}

/**
 * Exports all ToM data to a JSON file in the current directory.
 * Returns the path of the exported file.
 */
export function exportToFile(): string {
  const data = collectExportData()
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filename = `tom-export-${timestamp}.json`
  const filePath = path.join(process.cwd(), filename)

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')

  return filePath
}

export function formatExportResult(filePath: string, data: ExportData): string {
  const lines: string[] = []

  lines.push('# ToM Export')
  lines.push('')
  lines.push(`Exported to: ${filePath}`)
  lines.push('')
  lines.push('## Contents')
  lines.push(`- Tier 1 sessions: ${data.tier1Sessions.length}`)
  lines.push(`- Tier 2 session models: ${data.tier2Models.length}`)
  lines.push(`- Tier 3 user model: ${data.tier3UserModel !== null ? 'present' : 'none'}`)
  lines.push(`- Usage log entries: ${data.usageLog.length}`)
  lines.push('')
  lines.push('The export file is self-contained and could be imported in a future version.')

  return lines.join('\n')
}

// --- CLI Entry Point ---

export function main(): void {
  const args = process.argv.slice(2)
  const command = args[0] ?? ''

  if (command === 'forget') {
    const sessionId = args[1] ?? ''
    if (sessionId === '') {
      process.stdout.write('Usage: tom-forget-export forget <session-id>\n')
      return
    }
    const result = forgetSession(sessionId)
    process.stdout.write(formatForgetResult(result))
    return
  }

  if (command === 'export') {
    const data = collectExportData()
    const filePath = exportToFile()
    process.stdout.write(formatExportResult(filePath, data))
    return
  }

  process.stdout.write('Usage: tom-forget-export <forget|export> [args]\n')
}

if (require.main === module) {
  main()
}
