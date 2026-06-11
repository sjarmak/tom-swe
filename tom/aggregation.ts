import type { UserModel, SessionModel, PreferenceCluster } from './schemas.js'
import type { PreferenceObservation } from './preferences.js'
import {
  reinforcePreference,
  decayPreferences,
  applyCorrections,
  resolveConflicts,
  DEFAULT_CORRECTION_PENALTY,
} from './preferences.js'

const DEFAULT_DECAY_DAYS = 30

/**
 * Extracts preference observations from a SessionModel.
 *
 * - codingPreferences → category 'codingPreferences'; keyed entries carry
 *   their own topic key, legacy bare strings fold under 'preference'
 * - interactionPatterns → category 'interactionStyle'; same, legacy key 'pattern'
 * - satisfactionSignals → category 'emotionalSignals', individual keys
 *
 * Keyed entries are what make the flywheel work: reinforcement and conflict
 * resolution match on category+key, so generic keys made distinct
 * preferences overwrite each other and sentence-long values never recur.
 */
function extractObservations(session: SessionModel): PreferenceObservation[] {
  const observations: PreferenceObservation[] = []

  for (const pref of session.codingPreferences) {
    observations.push(
      typeof pref === 'string'
        ? { category: 'codingPreferences', key: 'preference', value: pref }
        : { category: 'codingPreferences', key: pref.key, value: pref.value }
    )
  }

  for (const pattern of session.interactionPatterns) {
    observations.push(
      typeof pattern === 'string'
        ? { category: 'interactionStyle', key: 'pattern', value: pattern }
        : { category: 'interactionStyle', key: pattern.key, value: pattern.value }
    )
  }

  const { frustration, satisfaction, urgency } = session.satisfactionSignals
  observations.push({
    category: 'emotionalSignals',
    key: 'frustration',
    value: String(frustration),
  })
  observations.push({
    category: 'emotionalSignals',
    key: 'satisfaction',
    value: String(satisfaction),
  })
  observations.push({
    category: 'emotionalSignals',
    key: 'urgency',
    value: urgency,
  })

  return observations
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

  // Step 2: Extract observations from session
  const observations = extractObservations(session)

  // Step 3: Reinforce or add preferences
  let preferences: readonly PreferenceCluster[] = decayed
  for (const observation of observations) {
    preferences = reinforcePreference(preferences, observation, now)
  }

  // Step 4: Apply corrections (absent field on older session models → none)
  const corrected = applyCorrections(
    preferences,
    session.corrections ?? [],
    correctionPenalty,
    now
  )

  // Step 5: Resolve conflicts
  const resolved = resolveConflicts(corrected)

  // Step 6: Return new UserModel
  return {
    preferencesClusters: resolved,
    interactionStyleSummary: currentModel.interactionStyleSummary,
    codingStyleSummary: currentModel.codingStyleSummary,
    projectOverrides: { ...currentModel.projectOverrides },
  }
}
