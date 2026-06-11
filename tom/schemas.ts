import { z } from 'zod'

// --- Tier 1: Session Log ---

const InteractionSchema = z.strictObject({
  toolName: z.string(),
  parameterShape: z.record(z.string(), z.string()),
  outcomeSummary: z.string(),
  timestamp: z.string().datetime(),
})

export const SessionLogSchema = z.strictObject({
  sessionId: z.string(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  interactions: z.array(InteractionSchema),
  // Redacted user prompt text captured by the UserPromptSubmit hook.
  // Optional for backward compatibility with logs written before capture.
  userMessages: z.array(z.string()).optional(),
  // Join fields for the external work-audit graph: session working
  // directory and git branch, set once per session by the capture hooks.
  // A bead/work-item id is mechanically resolvable from these.
  cwd: z.string().optional(),
  gitBranch: z.string().optional(),
})

// --- Tier 2: Session Model ---

const SatisfactionSignalsSchema = z.strictObject({
  frustration: z.boolean(),
  satisfaction: z.boolean(),
  urgency: z.enum(['low', 'medium', 'high']),
})

/**
 * The three preference categories tracked by the ToM system.
 *
 * - interactionStyle: verbosity, questionTiming, responseLength
 * - codingPreferences: language, libraries, testingApproach, architecturePatterns, namingConventions
 * - emotionalSignals: frustration, satisfaction, urgency, mode
 */
export const PreferenceCategorySchema = z.enum([
  'interactionStyle',
  'codingPreferences',
  'emotionalSignals',
])

/**
 * A post-action correction (PAHF-style negative feedback): a moment where the
 * user contradicted, overrode, or re-edited away a previously suggested or
 * observed preference. Corrections cut confidence faster than repetition
 * builds it (see applyCorrections in preferences.ts).
 */
export const CorrectionSchema = z.strictObject({
  category: PreferenceCategorySchema,
  key: z.string(),
  // The value the user corrected TO, when one was expressed. Optional: a
  // correction can be a pure rejection without a replacement value.
  correctedValue: z.string().optional(),
  // Short evidence string (quote or paraphrase of the correcting moment).
  evidence: z.string(),
})

export const SessionModelSchema = z.strictObject({
  sessionId: z.string(),
  intent: z.string(),
  interactionPatterns: z.array(z.string()),
  codingPreferences: z.array(z.string()),
  satisfactionSignals: SatisfactionSignalsSchema,
  // Corrections extracted from the session. Optional for backward
  // compatibility with session models written before this field existed;
  // consumers treat absence as an empty array.
  corrections: z.array(CorrectionSchema).optional(),
})

// --- Tier 3: User Model ---

const PreferenceClusterSchema = z.strictObject({
  category: z.string(),
  key: z.string(),
  value: z.string(),
  confidence: z.number().min(0).max(1),
  lastUpdated: z.string().datetime(),
  sessionCount: z.number().int().min(0),
  // True when the preference has been promoted into a durable CLAUDE.md
  // marker block and retired from per-session injection. Optional for
  // backward compatibility with user models written before promotion existed.
  promoted: z.boolean().optional(),
})

export const UserModelSchema = z.strictObject({
  preferencesClusters: z.array(PreferenceClusterSchema),
  interactionStyleSummary: z.string(),
  codingStyleSummary: z.string(),
  projectOverrides: z.record(z.string(), z.array(PreferenceClusterSchema)),
})

// --- ToM Suggestion ---

export const ToMSuggestionSchema = z.strictObject({
  type: z.enum(['preference', 'disambiguation', 'style']),
  content: z.string(),
  confidence: z.number().min(0).max(1),
  sourceSessions: z.array(z.string()),
})

// --- Inferred Types ---

export type Interaction = z.infer<typeof InteractionSchema>
export type SessionLog = z.infer<typeof SessionLogSchema>
export type SatisfactionSignals = z.infer<typeof SatisfactionSignalsSchema>
export type PreferenceCategory = z.infer<typeof PreferenceCategorySchema>
export type Correction = z.infer<typeof CorrectionSchema>
export type SessionModel = z.infer<typeof SessionModelSchema>
export type PreferenceCluster = z.infer<typeof PreferenceClusterSchema>
export type UserModel = z.infer<typeof UserModelSchema>
export type ToMSuggestion = z.infer<typeof ToMSuggestionSchema>
