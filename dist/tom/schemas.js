"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToMSuggestionSchema = exports.UserModelSchema = exports.SessionModelSchema = exports.SessionLogSchema = void 0;
const zod_1 = require("zod");
// --- Tier 1: Session Log ---
const InteractionSchema = zod_1.z.strictObject({
    toolName: zod_1.z.string(),
    parameterShape: zod_1.z.record(zod_1.z.string(), zod_1.z.string()),
    outcomeSummary: zod_1.z.string(),
    timestamp: zod_1.z.string().datetime(),
});
exports.SessionLogSchema = zod_1.z.strictObject({
    sessionId: zod_1.z.string(),
    startedAt: zod_1.z.string().datetime(),
    endedAt: zod_1.z.string().datetime(),
    interactions: zod_1.z.array(InteractionSchema),
});
// --- Tier 2: Session Model ---
const SatisfactionSignalsSchema = zod_1.z.strictObject({
    frustration: zod_1.z.boolean(),
    satisfaction: zod_1.z.boolean(),
    urgency: zod_1.z.enum(['low', 'medium', 'high']),
});
exports.SessionModelSchema = zod_1.z.strictObject({
    sessionId: zod_1.z.string(),
    intent: zod_1.z.string(),
    interactionPatterns: zod_1.z.array(zod_1.z.string()),
    codingPreferences: zod_1.z.array(zod_1.z.string()),
    satisfactionSignals: SatisfactionSignalsSchema,
});
// --- Tier 3: User Model ---
const PreferenceClusterSchema = zod_1.z.strictObject({
    category: zod_1.z.string(),
    key: zod_1.z.string(),
    value: zod_1.z.string(),
    confidence: zod_1.z.number().min(0).max(1),
    lastUpdated: zod_1.z.string().datetime(),
    sessionCount: zod_1.z.number().int().min(0),
});
exports.UserModelSchema = zod_1.z.strictObject({
    preferencesClusters: zod_1.z.array(PreferenceClusterSchema),
    interactionStyleSummary: zod_1.z.string(),
    codingStyleSummary: zod_1.z.string(),
    projectOverrides: zod_1.z.record(zod_1.z.string(), zod_1.z.array(PreferenceClusterSchema)),
});
// --- ToM Suggestion ---
exports.ToMSuggestionSchema = zod_1.z.strictObject({
    type: zod_1.z.enum(['preference', 'disambiguation', 'style']),
    content: zod_1.z.string(),
    confidence: zod_1.z.number().min(0).max(1),
    sourceSessions: zod_1.z.array(zod_1.z.string()),
});
//# sourceMappingURL=schemas.js.map