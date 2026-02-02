import type { UserModel, SessionModel, PreferenceCluster } from './schemas.js'
import type { PreferenceObservation } from './preferences.js'
import {
  reinforcePreference,
  decayPreferences,
  resolveConflicts,
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
 * 4. Resolve conflicts (same category+key, different values → most recent wins)
 * 5. Return a new UserModel (immutable)
 *
 * @param currentModel - The existing UserModel
 * @param session - The new SessionModel to merge in
 * @param decayDays - Half-life in days for preference decay (default 30)
 * @returns A new UserModel with updated preferences
 */
export function aggregateSessionIntoModel(
  currentModel: UserModel,
  session: SessionModel,
  decayDays: number = DEFAULT_DECAY_DAYS
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

  // Step 4: Resolve conflicts
  const resolved = resolveConflicts(preferences)

  // Step 5: Return new UserModel
  return {
    preferencesClusters: resolved,
    interactionStyleSummary: currentModel.interactionStyleSummary,
    codingStyleSummary: currentModel.codingStyleSummary,
    projectOverrides: { ...currentModel.projectOverrides },
  }
}
