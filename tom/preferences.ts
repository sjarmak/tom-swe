import type { Correction, PreferenceCategory, PreferenceCluster } from './schemas.js'
import { PreferenceCategorySchema } from './schemas.js'

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
 * Maps each preference key to its single canonical category.
 *
 * Preference identity is category+key, but the analyzer occasionally files the
 * same semantic concept under different top-level categories across sessions
 * (e.g. `execution_backend_for_iteration` as codingPreferences one session and
 * interactionStyle the next). That splits one concept into two clusters and
 * lets the analyzer emit a "correction" against its own prior-category
 * inference. This resolver picks the canonical category deterministically: a
 * key that has only ever been seen under ONE category in the store maps to it.
 * A key already split across categories has no unambiguous answer and is
 * omitted — callers leave such keys untouched rather than guessing (reconciling
 * an existing split is a separate, judgment-laden concern; see the follow-up
 * bead, since collapsing to a winner risks merging genuinely-distinct concepts
 * that happen to share a key string).
 *
 * Purely mechanical (ZFC-safe): it reads the categories already present in the
 * store; it performs no semantic classification of what a key "should" be.
 */
export function canonicalCategoryByKey(
  preferences: readonly PreferenceCluster[]
): Map<string, PreferenceCategory> {
  const categoriesByKey = new Map<string, Set<string>>()
  for (const p of preferences) {
    const set = categoriesByKey.get(p.key) ?? new Set<string>()
    set.add(p.category)
    categoriesByKey.set(p.key, set)
  }

  const canonical = new Map<string, PreferenceCategory>()
  for (const [key, categories] of categoriesByKey) {
    if (categories.size !== 1) {
      continue
    }
    const [only] = categories
    if (only === undefined) {
      continue
    }
    // Only accept a known preference category; a legacy/garbage category value
    // never becomes a canonical target.
    const parsed = PreferenceCategorySchema.safeParse(only)
    if (parsed.success) {
      canonical.set(key, parsed.data)
    }
  }
  return canonical
}

/**
 * Drops corrections that are merely the same key re-filed under a different
 * top-level category. A genuine user correction targets an existing preference,
 * so its category matches that key's established canonical category. A
 * correction whose category differs from the key's canonical category is the
 * analyzer contradicting its own prior inference after re-classifying the
 * concept — not a user override — so it must neither penalize confidence nor be
 * recorded as a correction event.
 *
 * A key with no established canonical category (never seen, or already split)
 * is left alone: its corrections pass through unchanged.
 */
export function dropRefiledCorrections(
  corrections: readonly Correction[],
  canonical: ReadonlyMap<string, PreferenceCategory>
): Correction[] {
  return corrections.filter((c) => {
    const canon = canonical.get(c.key)
    return canon === undefined || canon === c.category
  })
}

/** One loser cluster moved off its category during a cross-category collapse. */
export interface CrossCategoryRefile {
  readonly fromCategory: string
  readonly value: string
  readonly confidence: number
  /** True when the moved cluster carried a user correction (surfaced so a
   * correction is never discarded without a telemetry trace). */
  readonly learnedViaCorrection: boolean
}

/** A single key's collapse from a cross-category split to one canonical category. */
export interface CrossCategoryCollapse {
  readonly key: string
  readonly winner: PreferenceCategory
  readonly refiled: readonly CrossCategoryRefile[]
}

/**
 * Picks the winning category for a key spread across several categories.
 *
 * Only a valid PreferenceCategory can win — a legacy/garbage category value is
 * never a canonical target. The candidate with the highest total confidence
 * wins; ties break on category name ascending so the choice is deterministic.
 * Returns undefined when the key has no valid category at all (nothing to
 * collapse to).
 *
 * After resolveConflicts there is exactly one cluster per (category, key), so
 * the per-category sum is just that cluster's confidence; summing keeps the
 * function correct if ever handed an unresolved array.
 */
function pickWinnerCategory(
  clusters: readonly PreferenceCluster[]
): PreferenceCategory | undefined {
  const confidenceByCategory = new Map<PreferenceCategory, number>()
  for (const c of clusters) {
    const parsed = PreferenceCategorySchema.safeParse(c.category)
    if (!parsed.success) continue
    confidenceByCategory.set(
      parsed.data,
      (confidenceByCategory.get(parsed.data) ?? 0) + c.confidence
    )
  }
  if (confidenceByCategory.size === 0) return undefined

  return [...confidenceByCategory.entries()].sort((a, b) =>
    b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])
  )[0]?.[0]
}

/**
 * Reconciles keys that are split across more than one category — a one-time
 * cleanup for splits already in the store when the canonicalCategoryByKey fix
 * shipped (it prevents NEW splits but is a no-op for pre-existing ones because
 * canonicalCategoryByKey omits any key with categories.size !== 1).
 *
 * For each such key (legacy generic keys excluded), the highest-confidence
 * valid category wins and every non-winner cluster — including garbage
 * categories — is RE-FILED into the winner, then resolveConflicts collapses the
 * now-duplicate values by recency. Re-file (not drop) is deliberate: a loser
 * cluster can carry a genuine user correction that dropRefiledCorrections
 * preserves for split keys, so deleting it would silently discard a real
 * correction. Re-filing keeps the value in the model (recategorized); recency
 * then decides which value survives, exactly as any same-category conflict.
 *
 * Purely mechanical (ZFC-safe): it reads categories and confidences already in
 * the store; it performs no semantic classification of what a key "should" be.
 * Two genuinely-distinct concepts that happen to share a key string are merged
 * here — the returned collapses record every moved cluster so the merge is
 * auditable rather than silent.
 *
 * Returns a new array (immutable) and the list of collapses for telemetry.
 */
export function reconcileCrossCategorySplits(
  preferences: readonly PreferenceCluster[]
): { preferences: PreferenceCluster[]; collapses: CrossCategoryCollapse[] } {
  const clustersByKey = new Map<string, PreferenceCluster[]>()
  for (const p of preferences) {
    const list = clustersByKey.get(p.key) ?? []
    list.push(p)
    clustersByKey.set(p.key, list)
  }

  const collapses: CrossCategoryCollapse[] = []
  const winnerByKey = new Map<string, PreferenceCategory>()

  for (const [key, clusters] of clustersByKey) {
    if (isLegacyGenericKey(key)) continue
    const categories = new Set(clusters.map((c) => c.category))
    if (categories.size <= 1) continue

    const winner = pickWinnerCategory(clusters)
    if (winner === undefined) continue

    winnerByKey.set(key, winner)
    collapses.push({
      key,
      winner,
      refiled: clusters
        .filter((c) => c.category !== winner)
        .map((c) => ({
          fromCategory: c.category,
          value: c.value,
          confidence: c.confidence,
          learnedViaCorrection: c.learnedVia === 'correction',
        })),
    })
  }

  if (collapses.length === 0) {
    return { preferences: [...preferences], collapses }
  }

  const refiled = preferences.map((p) => {
    const winner = winnerByKey.get(p.key)
    return winner !== undefined && p.category !== winner
      ? { ...p, category: winner }
      : p
  })

  return { preferences: resolveConflicts(refiled), collapses }
}

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
      // Clamp at 1: decay must never amplify. A lastUpdated later than `now`
      // (e.g. an undated legacy Tier 2 model folded ahead of dated ones)
      // yields a negative gap; without the clamp that compounds confidence
      // past the cap and fails write validation downstream.
      const decayFactor = Math.min(1, Math.pow(2, -daysSinceUpdate / halfLifeDays))
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
 * preferences. The multiplicative penalty removes confidence/2 at the
 * default 0.5 factor — only at the 1.0 cap does that equal the 0.5 five
 * +0.1 reinforcements add; at the low confidences typical in practice the
 * absolute cut is one reinforcement's worth. What actually silences a
 * corrected-away value is the combination of the penalty, the corrected-to
 * entry seeded below, and resolveConflicts' recency-weighted collapse.
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
