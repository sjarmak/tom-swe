/**
 * Lightweight heuristics for detecting ambiguity in user prompt text.
 *
 * Pure functions — no I/O, no model calls. Executes in <50ms.
 * Operates on the actual prompt the user submitted (UserPromptSubmit
 * payload), not on tool parameters.
 */

export type AmbiguityThreshold = 'low' | 'medium' | 'high'

export type AmbiguityTrigger =
  | 'short-vague'
  | 'preference-sensitive'
  | 'no-user-model'

export interface AmbiguityResult {
  readonly isAmbiguous: boolean
  readonly score: number
  readonly reason: string
  readonly triggers: readonly AmbiguityTrigger[]
}

export interface DetectAmbiguityInput {
  readonly prompt: string
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
 * Detects whether a user prompt is ambiguous enough to warrant
 * ToM consultation.
 *
 * Heuristics:
 * 1. Short/vague prompt (<10 words, vague keywords, no explicit file paths)
 * 2. Preference-sensitive vocabulary (style, architecture, library choice)
 * 3. No user model exists yet (first interactions)
 *
 * Returns { isAmbiguous, score (0-1), reason }.
 */
export function detectAmbiguity(input: DetectAmbiguityInput): AmbiguityResult {
  const threshold = input.threshold ?? 'medium'
  const thresholdValue = THRESHOLD_VALUES[threshold]
  const reasons: string[] = []
  const triggers: AmbiguityTrigger[] = []
  let totalScore = 0

  // Heuristic 1: Short/vague prompt
  const shortVagueScore = scoreShortVagueInstruction(input.prompt)
  if (shortVagueScore > 0) {
    totalScore += shortVagueScore
    reasons.push('Short or vague user instruction without specific file paths')
    triggers.push('short-vague')
  }

  // Heuristic 2: Preference-sensitive vocabulary
  const preferenceScore = scorePreferenceSensitive(input.prompt)
  if (preferenceScore > 0) {
    totalScore += preferenceScore
    reasons.push('Decision involves style, architecture, or library preferences')
    triggers.push('preference-sensitive')
  }

  // Heuristic 3: No user model (first interactions)
  const noModelScore = scoreNoUserModel(input.hasUserModel ?? true)
  if (noModelScore > 0) {
    totalScore += noModelScore
    reasons.push('No user model exists for this project')
    triggers.push('no-user-model')
  }

  const clampedScore = Math.min(totalScore, 1.0)
  const reason = reasons.length > 0
    ? reasons.join('; ')
    : 'No ambiguity detected'

  return {
    isAmbiguous: clampedScore > thresholdValue,
    score: Math.round(clampedScore * 100) / 100,
    reason,
    triggers,
  }
}

/**
 * Scores short/vague prompts: <10 words without explicit file paths,
 * plus vague keywords ("fix", "improve", ...).
 * Returns 0-0.35 contribution to ambiguity score.
 */
function scoreShortVagueInstruction(prompt: string): number {
  if (prompt.length === 0) return 0.2

  const words = prompt.trim().split(/\s+/)
  const wordCount = words.length
  const hasFilePath = FILE_PATH_PATTERN.test(prompt)

  if (wordCount >= SHORT_MESSAGE_WORD_LIMIT) return 0

  let score = 0

  // Short prompt without an explicit file path
  if (!hasFilePath) {
    score += 0.15
  }

  // Check for vague keywords
  const lowerPrompt = prompt.toLowerCase()
  const vagueCount = VAGUE_KEYWORDS.filter((kw) => lowerPrompt.includes(kw)).length
  if (vagueCount > 0) {
    score += Math.min(vagueCount * 0.1, 0.2)
  }

  return score
}

/**
 * Scores preference-sensitive vocabulary in the prompt
 * (style, architecture, library, framework, ...).
 * Returns 0-0.25 contribution to ambiguity score.
 */
function scorePreferenceSensitive(prompt: string): number {
  const lowerPrompt = prompt.toLowerCase()
  const matchCount = PREFERENCE_KEYWORDS.filter((kw) => lowerPrompt.includes(kw)).length

  if (matchCount === 0) return 0

  return Math.min(matchCount * 0.08, 0.25)
}

/**
 * Scores the absence of a user model.
 * Returns 0 or 0.25 contribution to ambiguity score.
 */
function scoreNoUserModel(hasUserModel: boolean): number {
  return hasUserModel ? 0 : 0.25
}
