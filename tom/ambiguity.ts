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
/** Inline code or an extension-suffixed token anchors a prompt as much as a path. */
const INLINE_CODE_PATTERN = /`[^`]+`/
const FILE_TOKEN_PATTERN = /\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|py|go|rs|java|kt|rb|c|h|cpp|cs|php|swift|md|json|yaml|yml|toml|sh|sql)\b/
const SHORT_MESSAGE_WORD_LIMIT = 10
const VERY_SHORT_WORD_LIMIT = 5

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

  // Round BEFORE comparing: weight sums accumulate float error
  // (0.4 + 0.15 + 0.15 = 0.7000000000000001), and the threshold decision
  // must agree with the score the telemetry reports.
  const clampedScore = Math.round(Math.min(totalScore, 1.0) * 100) / 100
  const reason = reasons.length > 0
    ? reasons.join('; ')
    : 'No ambiguity detected'

  return {
    isAmbiguous: clampedScore > thresholdValue,
    score: clampedScore,
    reason,
    triggers,
  }
}

/**
 * Whole-word keyword matching. The previous substring form matched 'do'
 * inside 'download' and 'style' inside 'stylesheet', inflating noise while
 * the score weights were too small to ever cross a threshold anyway.
 */
function countKeywordMatches(prompt: string, keywords: readonly string[]): number {
  const words = new Set(prompt.toLowerCase().split(/[^a-z0-9_]+/))
  return keywords.filter((kw) => words.has(kw)).length
}

function hasCodeAnchor(prompt: string): boolean {
  return (
    FILE_PATH_PATTERN.test(prompt) ||
    INLINE_CODE_PATTERN.test(prompt) ||
    FILE_TOKEN_PATTERN.test(prompt)
  )
}

/**
 * Scores short prompts without a concrete anchor (file path, inline code,
 * or a file-looking token).
 *
 * Calibration: the previous weights (0.15 pathless + 0.1/vague keyword,
 * capped 0.35) summed with every other signal to at most 0.6 with a user
 * model present, and required a prompt shape that never occurred — 5,128
 * logged prompts produced zero consultations at the 0.5 medium threshold.
 * These weights make a genuinely short, unanchored prompt (base 0.4, +0.15
 * when under 5 words, +0.15 with a vague verb) cross medium on its own.
 * Returns 0-0.7.
 */
function scoreShortVagueInstruction(prompt: string): number {
  if (prompt.trim().length === 0) return 0.2

  const wordCount = prompt.trim().split(/\s+/).length
  if (wordCount >= SHORT_MESSAGE_WORD_LIMIT) return 0
  if (hasCodeAnchor(prompt)) return 0

  let score = 0.4
  if (wordCount < VERY_SHORT_WORD_LIMIT) {
    score += 0.15
  }
  if (countKeywordMatches(prompt, VAGUE_KEYWORDS) > 0) {
    score += 0.15
  }
  return score
}

/**
 * Scores preference-sensitive vocabulary in the prompt
 * (style, architecture, library, framework, ...), whole-word matched.
 * Returns 0 or 0.2-0.3.
 */
function scorePreferenceSensitive(prompt: string): number {
  const matchCount = countKeywordMatches(prompt, PREFERENCE_KEYWORDS)
  if (matchCount === 0) return 0
  return Math.min(0.1 + matchCount * 0.1, 0.3)
}

/**
 * Scores the absence of a user model.
 * Returns 0 or 0.25 contribution to ambiguity score.
 */
function scoreNoUserModel(hasUserModel: boolean): number {
  return hasUserModel ? 0 : 0.25
}
