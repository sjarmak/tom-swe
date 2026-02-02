/**
 * Lightweight heuristics for detecting ambiguity in user instructions.
 *
 * Pure functions — no I/O, no model calls. Executes in <50ms.
 */

export type AmbiguityThreshold = 'low' | 'medium' | 'high'

export interface AmbiguityResult {
  readonly isAmbiguous: boolean
  readonly score: number
  readonly reason: string
}

export interface DetectAmbiguityInput {
  readonly toolName: string
  readonly toolParameters: Readonly<Record<string, unknown>>
  readonly recentUserMessages: readonly string[]
  readonly threshold?: AmbiguityThreshold
  readonly hasUserModel?: boolean
}

const THRESHOLD_VALUES: Readonly<Record<AmbiguityThreshold, number>> = {
  low: 0.3,
  medium: 0.5,
  high: 0.7,
}

const FILE_PATH_PATTERN = /(?:\/[\w.-]+)+(?:\.\w+)?/
const SHORT_MESSAGE_WORD_LIMIT = 10

/** Tools where style/preference choices are common */
const STYLE_SENSITIVE_TOOLS = new Set([
  'Write',
  'Edit',
  'NotebookEdit',
])

/** Keywords that indicate preference-sensitive decisions */
const PREFERENCE_KEYWORDS = [
  'style',
  'pattern',
  'architecture',
  'library',
  'framework',
  'convention',
  'approach',
  'design',
  'structure',
  'organize',
  'refactor',
  'naming',
  'format',
]

/** Keywords indicating vague instructions */
const VAGUE_KEYWORDS = [
  'fix',
  'improve',
  'update',
  'change',
  'make',
  'do',
  'handle',
  'better',
  'clean',
  'nice',
]

/**
 * Detects whether user instructions are ambiguous enough to warrant
 * ToM consultation.
 *
 * Heuristics:
 * 1. Short/vague user instruction (<10 words, no file paths)
 * 2. Multiple valid file targets for an edit
 * 3. Preference-sensitive decisions (style, architecture, library choice)
 * 4. First interaction in new project with no user model
 *
 * Returns { isAmbiguous, score (0-1), reason }.
 */
export function detectAmbiguity(input: DetectAmbiguityInput): AmbiguityResult {
  const threshold = input.threshold ?? 'medium'
  const thresholdValue = THRESHOLD_VALUES[threshold]
  const reasons: string[] = []
  let totalScore = 0

  const lastMessage = input.recentUserMessages.length > 0
    ? input.recentUserMessages[input.recentUserMessages.length - 1] ?? ''
    : ''

  // Heuristic 1: Short/vague user instruction
  const shortVagueScore = scoreShortVagueInstruction(lastMessage)
  if (shortVagueScore > 0) {
    totalScore += shortVagueScore
    reasons.push('Short or vague user instruction without specific file paths')
  }

  // Heuristic 2: Multiple valid file targets
  const multiTargetScore = scoreMultipleFileTargets(input.toolName, input.toolParameters)
  if (multiTargetScore > 0) {
    totalScore += multiTargetScore
    reasons.push('Edit tool used without a clear single file target')
  }

  // Heuristic 3: Preference-sensitive decisions
  const preferenceScore = scorePreferenceSensitive(input.toolName, input.recentUserMessages)
  if (preferenceScore > 0) {
    totalScore += preferenceScore
    reasons.push('Decision involves style, architecture, or library preferences')
  }

  // Heuristic 4: No user model (first interaction in new project)
  const noModelScore = scoreNoUserModel(input.hasUserModel ?? true)
  if (noModelScore > 0) {
    totalScore += noModelScore
    reasons.push('No user model exists for this project')
  }

  const clampedScore = Math.min(totalScore, 1.0)
  const reason = reasons.length > 0
    ? reasons.join('; ')
    : 'No ambiguity detected'

  return {
    isAmbiguous: clampedScore > thresholdValue,
    score: Math.round(clampedScore * 100) / 100,
    reason,
  }
}

/**
 * Scores short/vague instructions: <10 words without specific file paths.
 * Returns 0-0.35 contribution to ambiguity score.
 */
function scoreShortVagueInstruction(message: string): number {
  if (message.length === 0) return 0.2

  const words = message.trim().split(/\s+/)
  const wordCount = words.length
  const hasFilePath = FILE_PATH_PATTERN.test(message)

  if (wordCount >= SHORT_MESSAGE_WORD_LIMIT) return 0

  let score = 0

  // Short message without file path
  if (!hasFilePath) {
    score += 0.15
  }

  // Check for vague keywords
  const lowerMessage = message.toLowerCase()
  const vagueCount = VAGUE_KEYWORDS.filter((kw) => lowerMessage.includes(kw)).length
  if (vagueCount > 0) {
    score += Math.min(vagueCount * 0.1, 0.2)
  }

  return score
}

/**
 * Scores whether an edit targets multiple files or has ambiguous targeting.
 * Returns 0-0.3 contribution to ambiguity score.
 */
function scoreMultipleFileTargets(
  toolName: string,
  toolParameters: Readonly<Record<string, unknown>>
): number {
  if (!STYLE_SENSITIVE_TOOLS.has(toolName)) return 0

  const filePath = toolParameters['file_path'] as string | undefined
  const oldString = toolParameters['old_string'] as string | undefined

  // Edit without a specific file path
  if (!filePath || filePath.length === 0) return 0.3

  // Edit with a file path but no old_string (full file write — more ambiguous)
  if (toolName === 'Edit' && (!oldString || oldString.length === 0)) return 0.15

  return 0
}

/**
 * Scores preference-sensitive decisions based on keywords in messages
 * and the tool being used.
 * Returns 0-0.35 contribution to ambiguity score.
 */
function scorePreferenceSensitive(
  toolName: string,
  allMessages: readonly string[]
): number {
  let score = 0

  // Style-sensitive tool usage
  if (STYLE_SENSITIVE_TOOLS.has(toolName)) {
    score += 0.1
  }

  // Check all recent messages for preference keywords
  const combinedMessages = allMessages.join(' ').toLowerCase()
  const matchCount = PREFERENCE_KEYWORDS.filter((kw) => combinedMessages.includes(kw)).length

  if (matchCount > 0) {
    score += Math.min(matchCount * 0.08, 0.25)
  }

  return score
}

/**
 * Scores the absence of a user model.
 * Returns 0 or 0.25 contribution to ambiguity score.
 */
function scoreNoUserModel(hasUserModel: boolean): number {
  return hasUserModel ? 0 : 0.25
}
