import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import {
  SessionLogSchema,
  SessionModelSchema,
  UserModelSchema,
  type SessionLog,
  type SessionModel,
  type UserModel,
  type PreferenceCluster,
} from './schemas'

// --- Path Helpers ---

function globalTomDir(): string {
  return path.join(os.homedir(), '.claude', 'tom')
}

function projectTomDir(): string {
  return path.join(process.cwd(), '.claude', 'tom')
}

function globalSessionPath(sessionId: string): string {
  return path.join(globalTomDir(), 'sessions', `${sessionId}.json`)
}

function projectSessionPath(sessionId: string): string {
  return path.join(projectTomDir(), 'sessions', `${sessionId}.json`)
}

function globalSessionModelPath(sessionId: string): string {
  return path.join(globalTomDir(), 'session-models', `${sessionId}.json`)
}

function projectSessionModelPath(sessionId: string): string {
  return path.join(projectTomDir(), 'session-models', `${sessionId}.json`)
}

function globalUserModelPath(): string {
  return path.join(globalTomDir(), 'user-model.json')
}

function projectUserModelPath(): string {
  return path.join(projectTomDir(), 'user-model.json')
}

// --- Internal Utilities ---

function ensureDirectoryExists(filePath: string): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function readJsonFile(filePath: string): unknown | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    return JSON.parse(content) as unknown
  } catch {
    return null
  }
}

function writeJsonFile(filePath: string, data: unknown): void {
  ensureDirectoryExists(filePath)
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

// --- Session Log (Tier 1) ---

export function readSessionLog(
  sessionId: string,
  scope: 'global' | 'project' = 'global'
): SessionLog | null {
  const filePath =
    scope === 'global'
      ? globalSessionPath(sessionId)
      : projectSessionPath(sessionId)

  const raw = readJsonFile(filePath)
  if (raw === null) return null

  const result = SessionLogSchema.safeParse(raw)
  return result.success ? result.data : null
}

export function writeSessionLog(
  sessionLog: SessionLog,
  scope: 'global' | 'project' = 'global'
): void {
  const validated = SessionLogSchema.parse(sessionLog)

  const filePath =
    scope === 'global'
      ? globalSessionPath(validated.sessionId)
      : projectSessionPath(validated.sessionId)

  writeJsonFile(filePath, validated)
}

// --- Session Model (Tier 2) ---

export function readSessionModel(
  sessionId: string,
  scope: 'global' | 'project' = 'global'
): SessionModel | null {
  const filePath =
    scope === 'global'
      ? globalSessionModelPath(sessionId)
      : projectSessionModelPath(sessionId)

  const raw = readJsonFile(filePath)
  if (raw === null) return null

  const result = SessionModelSchema.safeParse(raw)
  return result.success ? result.data : null
}

export function writeSessionModel(
  sessionModel: SessionModel,
  scope: 'global' | 'project' = 'global'
): void {
  const validated = SessionModelSchema.parse(sessionModel)

  const filePath =
    scope === 'global'
      ? globalSessionModelPath(validated.sessionId)
      : projectSessionModelPath(validated.sessionId)

  writeJsonFile(filePath, validated)
}

// --- User Model (Tier 3) ---

function mergePreferences(
  globalPrefs: readonly PreferenceCluster[],
  projectPrefs: readonly PreferenceCluster[]
): PreferenceCluster[] {
  const merged = new Map<string, PreferenceCluster>()

  for (const pref of globalPrefs) {
    merged.set(`${pref.category}::${pref.key}`, pref)
  }

  for (const pref of projectPrefs) {
    merged.set(`${pref.category}::${pref.key}`, pref)
  }

  return Array.from(merged.values())
}

export function readUserModel(
  scope: 'global' | 'project' | 'merged' = 'merged'
): UserModel | null {
  if (scope === 'global' || scope === 'merged') {
    const globalRaw = readJsonFile(globalUserModelPath())
    const globalResult =
      globalRaw !== null ? UserModelSchema.safeParse(globalRaw) : null
    const globalModel = globalResult?.success ? globalResult.data : null

    if (scope === 'global') return globalModel

    const projectRaw = readJsonFile(projectUserModelPath())
    const projectResult =
      projectRaw !== null ? UserModelSchema.safeParse(projectRaw) : null
    const projectModel = projectResult?.success ? projectResult.data : null

    if (globalModel === null) return projectModel
    if (projectModel === null) return globalModel

    return {
      preferencesClusters: mergePreferences(
        globalModel.preferencesClusters,
        projectModel.preferencesClusters
      ),
      interactionStyleSummary:
        projectModel.interactionStyleSummary || globalModel.interactionStyleSummary,
      codingStyleSummary:
        projectModel.codingStyleSummary || globalModel.codingStyleSummary,
      projectOverrides: {
        ...globalModel.projectOverrides,
        ...projectModel.projectOverrides,
      },
    }
  }

  const projectRaw = readJsonFile(projectUserModelPath())
  if (projectRaw === null) return null

  const result = UserModelSchema.safeParse(projectRaw)
  return result.success ? result.data : null
}

export function writeUserModel(
  userModel: UserModel,
  scope: 'global' | 'project' = 'global'
): void {
  const validated = UserModelSchema.parse(userModel)

  const filePath =
    scope === 'global' ? globalUserModelPath() : projectUserModelPath()

  writeJsonFile(filePath, validated)
}

// --- Exported Path Helpers (for use by other modules) ---

export {
  globalTomDir,
  projectTomDir,
  globalSessionPath,
  projectSessionPath,
  globalSessionModelPath,
  projectSessionModelPath,
  globalUserModelPath,
  projectUserModelPath,
}
