import type { UserModel, SessionModel, PreferenceCluster, PreferenceCategory } from './schemas.js'
import type { PreferenceObservation } from './preferences.js'
import {
  reinforcePreference,
  decayPreferences,
  applyCorrections,
  resolveConflicts,
  isLegacyGenericKey,
  canonicalCategoryByKey,
  dropRefiledCorrections,
  DEFAULT_CORRECTION_PENALTY,
} from './preferences.js'

const DEFAULT_DECAY_DAYS = 30

// Minimum confidence a resolved cluster must carry to appear in a style
// summary. Below this the signal is too weak to surface to the model.
const SUMMARY_CONFIDENCE_THRESHOLD = 0.2

// Cap on how many clusters a single summary lists, so the rendered string
// stays bounded regardless of how many preferences accumulate.
const SUMMARY_MAX_ENTRIES = 5

/**
 * Renders a deterministic, human-readable style summary from resolved
 * clusters of one category.
 *
 * Mechanical only (ZFC): filter to the category and confidence threshold,
 * sort confidence descending with key ascending as the tiebreak, take the
 * top N, and join "key: value" pairs. No category clusters above threshold
 * yields an empty string (the schema requires a string, not null).
 */
function summarizeCategory(
  clusters: readonly PreferenceCluster[],
  category: string
): string {
  return clusters
    .filter(
      (c) =>
        c.category === category &&
        // Legacy generic keys carry no real signal — keep them out of the
        // injected style summary (see isLegacyGenericKey).
        !isLegacyGenericKey(c.key) &&
        c.confidence >= SUMMARY_CONFIDENCE_THRESHOLD
    )
    .slice()
    .sort((a, b) =>
      b.confidence !== a.confidence
        ? b.confidence - a.confidence
        : a.key.localeCompare(b.key)
    )
    .slice(0, SUMMARY_MAX_ENTRIES)
    .map((c) => `${c.key}: ${c.value}`)
    .join('; ')
}

/**
 * Derives the pair of narrative style summaries from resolved clusters. Shared
 * by the fold's final step and by any post-fold normalization (e.g. cross-
 * category reconciliation) that changes the cluster set and must re-derive the
 * summaries so they never list a value that was recategorized away.
 */
export function deriveStyleSummaries(
  clusters: readonly PreferenceCluster[]
): { interactionStyleSummary: string; codingStyleSummary: string } {
  return {
    interactionStyleSummary: summarizeCategory(clusters, 'interactionStyle'),
    codingStyleSummary: summarizeCategory(clusters, 'codingPreferences'),
  }
}

/**
 * Extracts preference observations from a SessionModel.
 *
 * - codingPreferences → category 'codingPreferences'; keyed entries carry
 *   their own topic key, legacy bare strings fold under 'preference'
 * - interactionPatterns → category 'interactionStyle'; same, legacy key 'pattern'
 *
 * Keyed entries are what make the flywheel work: reinforcement and conflict
 * resolution match on category+key, so generic keys made distinct
 * preferences overwrite each other and sentence-long values never recur.
 *
 * Observations are deduplicated by category+key within the session (last
 * value wins). A single session is one piece of evidence per preference, so
 * it must contribute at most one reinforcement: without this, a session whose
 * array carries N entries for the same key (the common case for legacy
 * bare-strings folding onto 'preference'/'pattern') would inflate confidence
 * and sessionCount by N instead of 1. Cross-session accumulation is unaffected
 * — each distinct session still reinforces once.
 */
function extractObservations(
  session: SessionModel,
  canonical: ReadonlyMap<string, PreferenceCategory>
): PreferenceObservation[] {
  const byKey = new Map<string, PreferenceObservation>()
  const add = (observation: PreferenceObservation): void => {
    // Re-file the observation under the key's canonical category so the same
    // concept reinforces ONE cluster instead of splitting across categories.
    // Keying the dedup map by the resolved category also collapses a
    // within-session collision (same key seen under both categories) to a
    // single reinforcement, preserving one-reinforcement-per-session.
    const canon = canonical.get(observation.key)
    const resolved: PreferenceObservation =
      canon !== undefined && canon !== observation.category
        ? { ...observation, category: canon }
        : observation
    byKey.set(`${resolved.category}::${resolved.key}`, resolved)
  }

  for (const pref of session.codingPreferences) {
    add(
      typeof pref === 'string'
        ? { category: 'codingPreferences', key: 'preference', value: pref }
        : { category: 'codingPreferences', key: pref.key, value: pref.value }
    )
  }

  for (const pattern of session.interactionPatterns) {
    add(
      typeof pattern === 'string'
        ? { category: 'interactionStyle', key: 'pattern', value: pattern }
        : { category: 'interactionStyle', key: pattern.key, value: pattern.value }
    )
  }

  return [...byKey.values()]
}

/**
 * Aggregates a new SessionModel into an existing UserModel.
 *
 * Steps:
 * 1. Apply decay to all existing preferences
 * 2. Extract observations from the session
 * 3. Reinforce existing or add new preferences for each observation
 * 4. Apply corrections (penalize contradicted preferences; corrected-to
 *    values start accumulating as new observations)
 * 5. Resolve conflicts (same category+key, different values → most recent wins)
 * 6. Return a new UserModel (immutable)
 *
 * @param currentModel - The existing UserModel
 * @param session - The new SessionModel to merge in
 * @param decayDays - Half-life in days for preference decay (default 30)
 * @param correctionPenalty - Confidence multiplier for corrected preferences (default 0.5)
 * @param asOf - The point in time this session's evidence applies (default
 *   now). Replaying historical sessions with their own timestamps grounds
 *   decay in real inter-session gaps, which is what makes a full rebuild
 *   from Tier 2 reproduce the same model as incremental aggregation did.
 * @returns A new UserModel with updated preferences
 */
export function aggregateSessionIntoModel(
  currentModel: UserModel,
  session: SessionModel,
  decayDays: number = DEFAULT_DECAY_DAYS,
  correctionPenalty: number = DEFAULT_CORRECTION_PENALTY,
  asOf: Date = new Date()
): UserModel {
  const now = asOf

  // Step 1: Decay existing preferences
  const decayed = decayPreferences(
    currentModel.preferencesClusters,
    decayDays,
    now
  )

  // Canonical category per key, resolved from the accumulated store. Drives
  // both observation re-filing and correction deduping so the same concept
  // stays under one category and a cross-category re-file never self-corrects.
  const canonical = canonicalCategoryByKey(decayed)

  // Step 2: Extract observations from session (re-filed to canonical category)
  const observations = extractObservations(session, canonical)

  // Step 3: Reinforce or add preferences
  let preferences: readonly PreferenceCluster[] = decayed
  for (const observation of observations) {
    preferences = reinforcePreference(preferences, observation, now)
  }

  // Step 4: Apply corrections (absent field on older session models → none),
  // minus cross-category re-files (the analyzer correcting its own prior
  // category inference, not a user override).
  const corrected = applyCorrections(
    preferences,
    dropRefiledCorrections(session.corrections ?? [], canonical),
    correctionPenalty,
    now
  )

  // Step 5: Resolve conflicts
  const resolved = resolveConflicts(corrected)

  // Step 6: Derive style summaries deterministically from resolved clusters
  // (mechanical, no LLM) and return a new UserModel.
  return {
    preferencesClusters: resolved,
    ...deriveStyleSummaries(resolved),
    projectOverrides: { ...currentModel.projectOverrides },
  }
}
