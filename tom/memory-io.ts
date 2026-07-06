import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import { atomicWriteFileSync } from './fs-atomic'
import {
  SessionLogSchema,
  SessionModelSchema,
  SidecarLineSchema,
  UserModelSchema,
  type SessionLog,
  type SessionModel,
  type SidecarLine,
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

function readJsonFile(filePath: string): unknown | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    return JSON.parse(content) as unknown
  } catch {
    return null
  }
}

function writeJsonFile(filePath: string, data: unknown): void {
  atomicWriteFileSync(filePath, JSON.stringify(data, null, 2))
}

// --- Session Log (Tier 1) ---

function sessionSidecarPath(
  sessionId: string,
  scope: 'global' | 'project'
): string {
  const dir = scope === 'global' ? globalTomDir() : projectTomDir()
  return path.join(dir, 'sessions', `${sessionId}.jsonl`)
}

/**
 * Reads and validates the capture sidecar's lines. Corrupt lines are
 * skipped with a stderr note (routing.ts imports this module, so logUsage
 * would be an import cycle); corruption here means a torn concurrent
 * append, which O_APPEND makes rare at these line sizes.
 */
function readSidecarLines(
  sessionId: string,
  scope: 'global' | 'project'
): SidecarLine[] {
  let text: string
  try {
    text = fs.readFileSync(sessionSidecarPath(sessionId, scope), 'utf-8')
  } catch {
    return []
  }

  const lines: SidecarLine[] = []
  let corrupt = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed = SidecarLineSchema.safeParse(JSON.parse(line))
      if (parsed.success) {
        lines.push(parsed.data)
      } else {
        corrupt++
      }
    } catch {
      corrupt++
    }
  }
  if (corrupt > 0) {
    process.stderr.write(
      `ToM: skipped ${corrupt} corrupt sidecar line(s) for session ${sessionId}\n`
    )
  }
  return lines
}

/**
 * Folds sidecar lines into the (possibly absent) base log. The base is
 * either a capture stub (identity + join fields) or a complete pre-sidecar
 * log; line timestamps extend the session's time span in both cases.
 */
function foldSessionLog(
  sessionId: string,
  base: SessionLog | null,
  lines: readonly SidecarLine[]
): SessionLog {
  const interactions = [...(base?.interactions ?? [])]
  const userMessages = [...(base?.userMessages ?? [])]
  let cwd = base?.cwd
  let startedAt = base?.startedAt
  let endedAt = base?.endedAt

  for (const line of lines) {
    if (line.type === 'interaction') {
      const { type: _type, ...interaction } = line
      interactions.push(interaction)
    } else {
      userMessages.push(line.message)
      cwd = cwd ?? line.cwd
    }
    if (startedAt === undefined || line.timestamp < startedAt) {
      startedAt = line.timestamp
    }
    if (endedAt === undefined || line.timestamp > endedAt) {
      endedAt = line.timestamp
    }
  }

  return {
    sessionId: base?.sessionId ?? sessionId,
    // Non-null: callers guarantee base !== null or lines is non-empty.
    startedAt: startedAt ?? new Date(0).toISOString(),
    endedAt: endedAt ?? new Date(0).toISOString(),
    interactions,
    ...(userMessages.length > 0 || base?.userMessages !== undefined
      ? { userMessages }
      : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(base?.gitBranch !== undefined ? { gitBranch: base.gitBranch } : {}),
  }
}

export function readSessionLog(
  sessionId: string,
  scope: 'global' | 'project' = 'global'
): SessionLog | null {
  const filePath =
    scope === 'global'
      ? globalSessionPath(sessionId)
      : projectSessionPath(sessionId)

  const raw = readJsonFile(filePath)
  const result = raw !== null ? SessionLogSchema.safeParse(raw) : null
  const base = result?.success === true ? result.data : null

  const lines = readSidecarLines(sessionId, scope)
  if (base === null && lines.length === 0) return null

  return foldSessionLog(sessionId, base, lines)
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

/**
 * Drops legacy 'emotionalSignals' clusters from a parsed user model.
 *
 * Emotional signals are no longer produced (see tom-swe-l35), but user models
 * written before their removal still carry these clusters in storage. Stripping
 * them at the read boundary keeps the deprecated category out of every consumer
 * without per-consumer filters, and storage self-heals on the next write.
 */
const DEPRECATED_CATEGORIES: ReadonlySet<string> = new Set(['emotionalSignals'])

function withoutDeprecatedClusters(model: UserModel): UserModel {
  const keep = (c: PreferenceCluster): boolean => !DEPRECATED_CATEGORIES.has(c.category)
  return {
    ...model,
    preferencesClusters: model.preferencesClusters.filter(keep),
    projectOverrides: Object.fromEntries(
      Object.entries(model.projectOverrides).map(([k, clusters]) => [
        k,
        clusters.filter(keep),
      ])
    ),
  }
}

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
    const globalModel = globalResult?.success
      ? withoutDeprecatedClusters(globalResult.data)
      : null

    if (scope === 'global') return globalModel

    const projectRaw = readJsonFile(projectUserModelPath())
    const projectResult =
      projectRaw !== null ? UserModelSchema.safeParse(projectRaw) : null
    const projectModel = projectResult?.success
      ? withoutDeprecatedClusters(projectResult.data)
      : null

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
  return result.success ? withoutDeprecatedClusters(result.data) : null
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
