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
})

// --- Tier 2: Session Model ---

const SatisfactionSignalsSchema = z.strictObject({
  frustration: z.boolean(),
  satisfaction: z.boolean(),
  urgency: z.enum(['low', 'medium', 'high']),
})

export const SessionModelSchema = z.strictObject({
  sessionId: z.string(),
  intent: z.string(),
  interactionPatterns: z.array(z.string()),
  codingPreferences: z.array(z.string()),
  satisfactionSignals: SatisfactionSignalsSchema,
})

// --- Tier 3: User Model ---

const PreferenceClusterSchema = z.strictObject({
  category: z.string(),
  key: z.string(),
  value: z.string(),
  confidence: z.number().min(0).max(1),
  lastUpdated: z.string().datetime(),
  sessionCount: z.number().int().min(0),
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
export type SessionModel = z.infer<typeof SessionModelSchema>
export type PreferenceCluster = z.infer<typeof PreferenceClusterSchema>
export type UserModel = z.infer<typeof UserModelSchema>
export type ToMSuggestion = z.infer<typeof ToMSuggestionSchema>
