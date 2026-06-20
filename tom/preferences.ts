import type { Correction, PreferenceCategory, PreferenceCluster } from './schemas.js'

// The three preference categories tracked by the ToM system — defined as a
// Zod enum in schemas.ts (PreferenceCategorySchema) and re-exported here for
// callers of the preference math.
export type { PreferenceCategory } from './schemas.js'

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
 * Generic keys produced by the legacy bare-string extraction path (before the
 * keyed-vocabulary work). Every bare coding-pref folds onto 'preference' and
 * every bare interaction-pattern onto 'pattern', so these clusters collapse
 * unrelated observations: the value is whatever was seen last and carries no
 * real signal. They are excluded from vocabulary anchoring, promotion, and
 * injection — but kept in the store so a real keyed observation can still
 * supersede them and so they decay naturally rather than being hand-deleted.
 */
export const LEGACY_GENERIC_KEYS: ReadonlySet<string> = new Set([
  'preference',
  'pattern',
])

export function isLegacyGenericKey(key: string): boolean {
  return LEGACY_GENERIC_KEYS.has(key)
}

export const DEFAULT_CORRECTION_PENALTY = 0.5

/**
 * Reinforces an existing preference or adds a new observation.
 *
 * Preference identity is category+key — the value is the current wording of
 * that preference, not part of its identity. Rewording the same observation
 * across sessions accumulates confidence on one cluster instead of spawning a
 * fresh low-confidence cluster each time.
 *
 * - If a preference with the same category+key exists, its confidence is
 *   increased by 0.1 (capped at 1.0), sessionCount incremented, value updated
 *   to the latest wording, and lastUpdated set to now.
 * - If no matching category+key exists, a new preference is added with
 *   confidence 0.1 and sessionCount 1.
 *
 * Returns a new array (immutable).
 */
export function reinforcePreference(
  preferences: readonly PreferenceCluster[],
  observation: PreferenceObservation,
  asOf: Date = new Date()
): PreferenceCluster[] {
  const now = asOf.toISOString()
  const matchIndex = preferences.findIndex(
    (p) => p.category === observation.category && p.key === observation.key
  )

  if (matchIndex >= 0) {
    return preferences.map((p, i) => {
      if (i !== matchIndex) return p
      return {
        ...p,
        value: observation.value,
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
 * Applies post-action corrections (PAHF-style negative feedback) to
 * preferences. Corrections must cut confidence faster than repetition
 * builds it: one 0.5-penalty correction removes more confidence than five
 * +0.1 reinforcements can add.
 *
 * For each correction:
 * - Every preference matching category+key has its confidence multiplied by
 *   penaltyFactor and its lastUpdated set to now. (The existing floor-prune
 *   in decayPreferences removes entries that fall below 0.01 — decay, don't
 *   silently delete.)
 * - If the correction carries a correctedValue, that value is exempt from the
 *   penalty and is added/reinforced as a new observation, so the corrected-to
 *   value starts accumulating confidence.
 *
 * Returns a new array (immutable).
 */
export function applyCorrections(
  preferences: readonly PreferenceCluster[],
  corrections: readonly Correction[],
  penaltyFactor: number = DEFAULT_CORRECTION_PENALTY,
  asOf: Date = new Date()
): PreferenceCluster[] {
  const now = asOf.toISOString()
  let result: readonly PreferenceCluster[] = preferences

  for (const correction of corrections) {
    // The value corrected away from — the most recently updated penalized
    // entry — becomes provenance on the corrected-to preference (the
    // "avoid X" half used by promotion's negative rendering).
    const penalized = result
      .filter(
        (p) =>
          p.category === correction.category &&
          p.key === correction.key &&
          !(
            correction.correctedValue !== undefined &&
            p.value === correction.correctedValue
          )
      )
      .sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated))
    const correctedFrom = penalized[0]?.value

    result = result.map((p) => {
      const matchesTarget =
        p.category === correction.category && p.key === correction.key
      const isCorrectedToValue =
        correction.correctedValue !== undefined &&
        p.value === correction.correctedValue
      if (!matchesTarget || isCorrectedToValue) {
        return p
      }
      return {
        ...p,
        confidence: p.confidence * penaltyFactor,
        lastUpdated: now,
      }
    })

    if (correction.correctedValue !== undefined) {
      // A correction overrides accumulated confidence: the corrected-to value
      // starts fresh, not by reinforcing the penalized cluster. Identity is
      // category+key, so an existing corrected-to cluster is reinforced in
      // place; otherwise a fresh INITIAL_CONFIDENCE cluster is appended. The
      // penalized old-value cluster is left for resolveConflicts to collapse.
      const existingIndex = result.findIndex(
        (p) =>
          p.category === correction.category &&
          p.key === correction.key &&
          p.value === correction.correctedValue
      )
      const provenance = {
        learnedVia: 'correction' as const,
        ...(correctedFrom !== undefined ? { correctedFrom } : {}),
      }

      if (existingIndex >= 0) {
        result = result.map((p, i) =>
          i !== existingIndex
            ? p
            : {
                ...p,
                confidence: Math.min(
                  p.confidence + CONFIDENCE_INCREMENT,
                  CONFIDENCE_MAX
                ),
                lastUpdated: now,
                sessionCount: p.sessionCount + 1,
                ...provenance,
              }
        )
      } else {
        const correctedToPreference: PreferenceCluster = {
          category: correction.category,
          key: correction.key,
          value: correction.correctedValue,
          confidence: INITIAL_CONFIDENCE,
          lastUpdated: now,
          sessionCount: 1,
          ...provenance,
        }
        result = [...result, correctedToPreference]
      }
    }
  }

  return [...result]
}

/**
 * Resolves conflicting preferences (same category+key, different values)
 * by recency-weighted voting: the most recently updated value wins.
 * Timestamp ties go to the later entry in the array — newer observations
 * (e.g. a corrected-to value appended by applyCorrections in the same pass)
 * are appended after the entries they supersede.
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

    if (!existing || pref.lastUpdated >= existing.lastUpdated) {
      winners.set(groupKey, pref)
    }
  }

  return Array.from(winners.values())
}
