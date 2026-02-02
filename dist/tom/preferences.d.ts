import type { PreferenceCluster } from './schemas.js';
/**
 * The three preference categories tracked by the ToM system.
 *
 * - interactionStyle: verbosity, questionTiming, responseLength
 * - codingPreferences: language, libraries, testingApproach, architecturePatterns, namingConventions
 * - emotionalSignals: frustration, satisfaction, urgency, mode
 */
export type PreferenceCategory = 'interactionStyle' | 'codingPreferences' | 'emotionalSignals';
export interface PreferenceObservation {
    readonly category: PreferenceCategory;
    readonly key: string;
    readonly value: string;
}
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
export declare function reinforcePreference(preferences: readonly PreferenceCluster[], observation: PreferenceObservation): PreferenceCluster[];
/**
 * Applies exponential decay to all preference confidence scores.
 *
 * Uses the formula: confidence * 2^(-daysSinceUpdate / halfLifeDays)
 *
 * Preferences that decay below CONFIDENCE_MIN_THRESHOLD (0.01) are removed.
 *
 * Returns a new array (immutable).
 */
export declare function decayPreferences(preferences: readonly PreferenceCluster[], halfLifeDays: number, now?: Date): PreferenceCluster[];
/**
 * Resolves conflicting preferences (same category+key, different values)
 * by recency-weighted voting: the most recently updated value wins.
 *
 * Returns a new array with at most one preference per category+key (immutable).
 */
export declare function resolveConflicts(preferences: readonly PreferenceCluster[]): PreferenceCluster[];
//# sourceMappingURL=preferences.d.ts.map