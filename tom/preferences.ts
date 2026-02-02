import type { PreferenceCluster } from './schemas.js'

/**
 * The three preference categories tracked by the ToM system.
 *
 * - interactionStyle: verbosity, questionTiming, responseLength
 * - codingPreferences: language, libraries, testingApproach, architecturePatterns, namingConventions
 * - emotionalSignals: frustration, satisfaction, urgency, mode
 */
export type PreferenceCategory =
  | 'interactionStyle'
  | 'codingPreferences'
  | 'emotionalSignals'

export interface PreferenceObservation {
  readonly category: PreferenceCategory
  readonly key: string
  readonly value: string
}

const CONFIDENCE_INCREMENT = 0.1
const CONFIDENCE_MAX = 1.0
const CONFIDENCE_MIN_THRESHOLD = 0.01
const INITIAL_CONFIDENCE = 0.1

/**
 * Reinforces an existing preference or adds a new observation.
 *
 * - If a preference with the same category+key+value exists, its confidence
 *   is increased by 0.1 (capped at 1.0), sessionCount incremented, and
 *   lastUpdated set to now.
 * - If a preference with the same category+key but different value exists,
 *   both are kept (conflict resolution handled separately).
 * - If no matching category+key exists, a new preference is added with
 *   confidence 0.1 and sessionCount 1.
 *
 * Returns a new array (immutable).
 */
export function reinforcePreference(
  preferences: readonly PreferenceCluster[],
  observation: PreferenceObservation
): PreferenceCluster[] {
  const now = new Date().toISOString()
  const matchIndex = preferences.findIndex(
    (p) =>
      p.category === observation.category &&
      p.key === observation.key &&
      p.value === observation.value
  )

  if (matchIndex >= 0) {
    return preferences.map((p, i) => {
      if (i !== matchIndex) return p
      return {
        ...p,
        confidence: Math.min(p.confidence + CONFIDENCE_INCREMENT, CONFIDENCE_MAX),
        lastUpdated: now,
        sessionCount: p.sessionCount + 1,
      }
    })
  }

  const newPreference: PreferenceCluster = {
    category: observation.category,
    key: observation.key,
    value: observation.value,
    confidence: INITIAL_CONFIDENCE,
    lastUpdated: now,
    sessionCount: 1,
  }

  return [...preferences, newPreference]
}

/**
 * Applies exponential decay to all preference confidence scores.
 *
 * Uses the formula: confidence * 2^(-daysSinceUpdate / halfLifeDays)
 *
 * Preferences that decay below CONFIDENCE_MIN_THRESHOLD (0.01) are removed.
 *
 * Returns a new array (immutable).
 */
export function decayPreferences(
  preferences: readonly PreferenceCluster[],
  halfLifeDays: number,
  now: Date = new Date()
): PreferenceCluster[] {
  const nowMs = now.getTime()

  return preferences
    .map((p) => {
      const lastUpdatedMs = new Date(p.lastUpdated).getTime()
      const daysSinceUpdate = (nowMs - lastUpdatedMs) / (1000 * 60 * 60 * 24)
      const decayFactor = Math.pow(2, -daysSinceUpdate / halfLifeDays)
      const decayedConfidence = p.confidence * decayFactor

      return {
        ...p,
        confidence: decayedConfidence,
      }
    })
    .filter((p) => p.confidence >= CONFIDENCE_MIN_THRESHOLD)
}

/**
 * Resolves conflicting preferences (same category+key, different values)
 * by recency-weighted voting: the most recently updated value wins.
 *
 * Returns a new array with at most one preference per category+key (immutable).
 */
export function resolveConflicts(
  preferences: readonly PreferenceCluster[]
): PreferenceCluster[] {
  const winners = new Map<string, PreferenceCluster>()

  for (const pref of preferences) {
    const groupKey = `${pref.category}::${pref.key}`
    const existing = winners.get(groupKey)

    if (!existing || pref.lastUpdated > existing.lastUpdated) {
      winners.set(groupKey, pref)
    }
  }

  return Array.from(winners.values())
}
