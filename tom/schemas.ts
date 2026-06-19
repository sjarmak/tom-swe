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

// Deprecated: emotional signals (frustration/satisfaction/urgency) were
// extracted per session but never consumed by any runtime behavior, so they
// are no longer produced (see tom-swe-l35). The schema is retained only so
// legacy session models written with this field still parse on read; nothing
// emits it anymore.
const SatisfactionSignalsSchema = z.strictObject({
  frustration: z.boolean(),
  satisfaction: z.boolean(),
  urgency: z.enum(['low', 'medium', 'high']),
})

/**
 * The preference categories tracked by the ToM system.
 *
 * Allowed keys per category are the single source of truth in ALLOWED_KEYS
 * (tom/llm-analyze.ts); kept in sync here for reference:
 * - interactionStyle: verbosity, question_timing, response_length
 * - codingPreferences: language, libraries, test_runner, testing_approach,
 *   architecture_patterns, naming_conventions, docs_style, commit_format, error_handling
 */
export const PreferenceCategorySchema = z.enum([
  'interactionStyle',
  'codingPreferences',
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

/**
 * A keyed preference entry. Keys are short topic names (snake_case) so the
 * same preference reinforces across sessions; a bare string is the legacy
 * shape, folded under a generic key (which cannot reinforce or promote
 * reliably — see extractObservations).
 */
export const PreferenceEntrySchema = z.strictObject({
  key: z.string(),
  value: z.string(),
})

export const SessionModelSchema = z.strictObject({
  sessionId: z.string(),
  intent: z.string(),
  interactionPatterns: z.array(z.union([z.string(), PreferenceEntrySchema])),
  codingPreferences: z.array(z.union([z.string(), PreferenceEntrySchema])),
  // Deprecated and no longer produced; optional so legacy session models that
  // still carry it parse cleanly under strictObject (see tom-swe-l35).
  satisfactionSignals: SatisfactionSignalsSchema.optional(),
  // Corrections extracted from the session. Optional for backward
  // compatibility with session models written before this field existed;
  // consumers treat absence as an empty array.
  corrections: z.array(CorrectionSchema).optional(),
  // When the session's evidence applies (copied mechanically from the Tier 1
  // log; never produced by the LLM). Grounds decay during Tier 3 rebuilds.
  // Optional for session models written before rebuilds existed.
  endedAt: z.string().datetime().optional(),
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
  // Provenance: a preference born from a user correction is non-obvious by
  // construction (the agent got it wrong first) and gets promotion priority
  // plus negative "avoid X" rendering. Optional; absent means observation.
  learnedVia: z.enum(['correction', 'observation']).optional(),
  // The value the user corrected AWAY from, when known — the "what not to
  // do" half of a correction-derived preference.
  correctedFrom: z.string().optional(),
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
export type PreferenceCategory = z.infer<typeof PreferenceCategorySchema>
export type Correction = z.infer<typeof CorrectionSchema>
export type SessionModel = z.infer<typeof SessionModelSchema>
export type PreferenceCluster = z.infer<typeof PreferenceClusterSchema>
export type UserModel = z.infer<typeof UserModelSchema>
export type ToMSuggestion = z.infer<typeof ToMSuggestionSchema>
