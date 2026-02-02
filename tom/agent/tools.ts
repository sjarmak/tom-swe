/**
 * ToM sub-agent tool implementations.
 *
 * These 5 tools are invoked by the ToM agent to interact with the memory system:
 * - search_memory: BM25 search across all memory tiers
 * - read_memory_file: Read a specific tier file
 * - analyze_session: Extract Tier 2 model from Tier 1 log
 * - initialize_user_profile: Bootstrap Tier 3 from available sessions
 * - give_suggestions: Output structured ToMSuggestion array
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import type { SessionLog, SessionModel, UserModel, ToMSuggestion } from '../schemas.js'
import { ToMSuggestionSchema } from '../schemas.js'
import { buildIndex, search } from '../bm25.js'
import type { BM25Document, BM25SearchResult, BM25Index } from '../bm25.js'
import {
  readSessionLog,
  readSessionModel,
  readUserModel,
  writeSessionModel,
  writeUserModel,
  globalTomDir,
  projectTomDir,
} from '../memory-io.js'
import { aggregateSessionIntoModel } from '../aggregation.js'
import { MEMORY_OPERATION_TOOLS, isMemoryOperationAllowed } from './config.js'

// --- Types ---

export interface SearchMemoryParams {
  readonly query: string
  readonly k?: number
}

export interface SearchMemoryResult {
  readonly results: readonly BM25SearchResult[]
  readonly operationCount: number
}

export interface ReadMemoryFileParams {
  readonly tier: 1 | 2 | 3
  readonly id: string
  readonly scope?: 'global' | 'project' | 'merged'
}

export interface ReadMemoryFileResult {
  readonly data: SessionLog | SessionModel | UserModel | null
  readonly operationCount: number
}

export interface AnalyzeSessionParams {
  readonly sessionId: string
  readonly scope?: 'global' | 'project'
}

export interface AnalyzeSessionResult {
  readonly sessionModel: SessionModel | null
  readonly operationCount: number
}

export interface InitializeUserProfileParams {
  readonly scope?: 'global' | 'project'
}

export interface InitializeUserProfileResult {
  readonly created: boolean
  readonly sessionCount: number
}

export interface GiveSuggestionsParams {
  readonly suggestions: readonly ToMSuggestion[]
}

export interface GiveSuggestionsResult {
  readonly accepted: number
  readonly suggestions: readonly ToMSuggestion[]
}

/**
 * Tracks the state of a single ToM agent invocation.
 * Enforces the memory operation limit.
 */
export interface AgentInvocationState {
  readonly operationCount: number
  readonly maxOperations: number
}

export function createInvocationState(maxOperations: number = 3): AgentInvocationState {
  return { operationCount: 0, maxOperations }
}

function incrementOperationCount(state: AgentInvocationState): AgentInvocationState {
  return { ...state, operationCount: state.operationCount + 1 }
}

// --- BM25 Index Building ---

function listJsonFiles(dirPath: string): readonly string[] {
  try {
    const files = fs.readdirSync(dirPath)
    return files.filter(f => f.endsWith('.json'))
  } catch {
    return []
  }
}

/**
 * Builds a BM25 index from all available memory files across tiers.
 */
export function buildMemoryIndex(scope: 'global' | 'project' = 'global'): BM25Index {
  const tomDir = scope === 'global' ? globalTomDir() : projectTomDir()
  const documents: BM25Document[] = []

  // Tier 1: Session logs
  const sessionsDir = path.join(tomDir, 'sessions')
  const sessionFiles = listJsonFiles(sessionsDir)
  for (const file of sessionFiles) {
    const sessionId = file.replace('.json', '')
    const session = readSessionLog(sessionId, scope)
    if (session) {
      const content = session.interactions
        .map(i => `${i.toolName} ${Object.keys(i.parameterShape).join(' ')} ${i.outcomeSummary}`)
        .join(' ')
      documents.push({ id: `session:${sessionId}`, content, tier: 1 })
    }
  }

  // Tier 2: Session models
  const modelsDir = path.join(tomDir, 'session-models')
  const modelFiles = listJsonFiles(modelsDir)
  for (const file of modelFiles) {
    const sessionId = file.replace('.json', '')
    const model = readSessionModel(sessionId, scope)
    if (model) {
      const content = [
        model.intent,
        ...model.interactionPatterns,
        ...model.codingPreferences,
      ].join(' ')
      documents.push({ id: `model:${sessionId}`, content, tier: 2 })
    }
  }

  // Tier 3: User model
  const userModel = readUserModel(scope === 'global' ? 'global' : 'project')
  if (userModel) {
    const content = [
      userModel.interactionStyleSummary,
      userModel.codingStyleSummary,
      ...userModel.preferencesClusters.map(p => `${p.category} ${p.key} ${p.value}`),
    ].join(' ')
    documents.push({ id: 'user-model', content, tier: 3 })
  }

  return buildIndex(documents)
}

// --- Tool: search_memory ---

export function searchMemory(
  params: SearchMemoryParams,
  state: AgentInvocationState,
  index: BM25Index
): { readonly result: SearchMemoryResult; readonly state: AgentInvocationState } {
  if (!isMemoryOperationAllowed(state.operationCount, state.maxOperations)) {
    return {
      result: { results: [], operationCount: state.operationCount },
      state,
    }
  }

  const nextState = incrementOperationCount(state)
  const results = search(index, params.query, params.k ?? 3)

  return {
    result: { results, operationCount: nextState.operationCount },
    state: nextState,
  }
}

// --- Tool: read_memory_file ---

export function readMemoryFile(
  params: ReadMemoryFileParams,
  state: AgentInvocationState
): { readonly result: ReadMemoryFileResult; readonly state: AgentInvocationState } {
  if (!isMemoryOperationAllowed(state.operationCount, state.maxOperations)) {
    return {
      result: { data: null, operationCount: state.operationCount },
      state,
    }
  }

  const nextState = incrementOperationCount(state)
  let data: SessionLog | SessionModel | UserModel | null = null

  if (params.tier === 1) {
    data = readSessionLog(params.id, params.scope === 'project' ? 'project' : 'global')
  } else if (params.tier === 2) {
    data = readSessionModel(params.id, params.scope === 'project' ? 'project' : 'global')
  } else if (params.tier === 3) {
    const modelScope = params.scope ?? 'merged'
    data = readUserModel(modelScope)
  }

  return {
    result: { data, operationCount: nextState.operationCount },
    state: nextState,
  }
}

// --- Tool: analyze_session ---

/**
 * Extracts a Tier 2 SessionModel from a Tier 1 SessionLog.
 *
 * This performs a lightweight heuristic extraction:
 * - Intent derived from the most common tool patterns
 * - Coding preferences from tool parameter shapes
 * - Interaction patterns from tool usage sequences
 * - Satisfaction signals from outcome summaries
 */
export function analyzeSession(
  params: AnalyzeSessionParams,
  state: AgentInvocationState
): { readonly result: AnalyzeSessionResult; readonly state: AgentInvocationState } {
  if (!isMemoryOperationAllowed(state.operationCount, state.maxOperations)) {
    return {
      result: { sessionModel: null, operationCount: state.operationCount },
      state,
    }
  }

  const nextState = incrementOperationCount(state)
  const sessionLog = readSessionLog(params.sessionId, params.scope ?? 'global')

  if (!sessionLog) {
    return {
      result: { sessionModel: null, operationCount: nextState.operationCount },
      state: nextState,
    }
  }

  const sessionModel = extractSessionModel(sessionLog)
  writeSessionModel(sessionModel, params.scope ?? 'global')

  return {
    result: { sessionModel, operationCount: nextState.operationCount },
    state: nextState,
  }
}

/**
 * Heuristic extraction of SessionModel from SessionLog.
 */
function extractSessionModel(sessionLog: SessionLog): SessionModel {
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

// --- Tool: initialize_user_profile ---

export function initializeUserProfile(
  params: InitializeUserProfileParams
): InitializeUserProfileResult {
  const scope = params.scope ?? 'global'
  const existing = readUserModel(scope)

  if (existing) {
    return { created: false, sessionCount: 0 }
  }

  const emptyModel: UserModel = {
    preferencesClusters: [],
    interactionStyleSummary: '',
    codingStyleSummary: '',
    projectOverrides: {},
  }

  // Bootstrap from available session models
  const tomDir = scope === 'global' ? globalTomDir() : projectTomDir()
  const modelsDir = path.join(tomDir, 'session-models')
  const modelFiles = listJsonFiles(modelsDir)

  let model = emptyModel
  let sessionCount = 0

  for (const file of modelFiles) {
    const sessionId = file.replace('.json', '')
    const sessionModel = readSessionModel(sessionId, scope)
    if (sessionModel) {
      model = aggregateSessionIntoModel(model, sessionModel)
      sessionCount++
    }
  }

  writeUserModel(model, scope)

  return { created: true, sessionCount }
}

// --- Tool: give_suggestions ---

export function giveSuggestions(
  params: GiveSuggestionsParams
): GiveSuggestionsResult {
  const validated: ToMSuggestion[] = []

  for (const suggestion of params.suggestions) {
    const parseResult = ToMSuggestionSchema.safeParse(suggestion)
    if (parseResult.success) {
      validated.push(parseResult.data)
    }
  }

  return {
    accepted: validated.length,
    suggestions: validated,
  }
}

// --- Exports for external use ---

export { MEMORY_OPERATION_TOOLS, isMemoryOperationAllowed }
