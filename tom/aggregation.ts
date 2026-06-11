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
 * - codingPreferences → category 'codingPreferences', key 'preference'
 * - interactionPatterns → category 'interactionStyle', key 'pattern'
 * - satisfactionSignals → category 'emotionalSignals', individual keys
 */
function extractObservations(session: SessionModel): PreferenceObservation[] {
  const observations: PreferenceObservation[] = []

  for (const pref of session.codingPreferences) {
    observations.push({
      category: 'codingPreferences',
      key: 'preference',
      value: pref,
    })
  }

  for (const pattern of session.interactionPatterns) {
    observations.push({
      category: 'interactionStyle',
      key: 'pattern',
      value: pattern,
    })
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
 * @returns A new UserModel with updated preferences
 */
export function aggregateSessionIntoModel(
  currentModel: UserModel,
  session: SessionModel,
  decayDays: number = DEFAULT_DECAY_DAYS,
  correctionPenalty: number = DEFAULT_CORRECTION_PENALTY
): UserModel {
  const now = new Date()

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
    preferences = reinforcePreference(preferences, observation)
  }

  // Step 4: Apply corrections (absent field on older session models → none)
  const corrected = applyCorrections(
    preferences,
    session.corrections ?? [],
    correctionPenalty
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
