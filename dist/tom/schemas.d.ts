import { z } from 'zod';
declare const InteractionSchema: z.ZodObject<{
    toolName: z.ZodString;
    parameterShape: z.ZodRecord<z.ZodString, z.ZodString>;
    outcomeSummary: z.ZodString;
    timestamp: z.ZodString;
}, z.core.$strict>;
export declare const SessionLogSchema: z.ZodObject<{
    sessionId: z.ZodString;
    startedAt: z.ZodString;
    endedAt: z.ZodString;
    interactions: z.ZodArray<z.ZodObject<{
        toolName: z.ZodString;
        parameterShape: z.ZodRecord<z.ZodString, z.ZodString>;
        outcomeSummary: z.ZodString;
        timestamp: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
declare const SatisfactionSignalsSchema: z.ZodObject<{
    frustration: z.ZodBoolean;
    satisfaction: z.ZodBoolean;
    urgency: z.ZodEnum<{
        low: "low";
        medium: "medium";
        high: "high";
    }>;
}, z.core.$strict>;
export declare const SessionModelSchema: z.ZodObject<{
    sessionId: z.ZodString;
    intent: z.ZodString;
    interactionPatterns: z.ZodArray<z.ZodString>;
    codingPreferences: z.ZodArray<z.ZodString>;
    satisfactionSignals: z.ZodObject<{
        frustration: z.ZodBoolean;
        satisfaction: z.ZodBoolean;
        urgency: z.ZodEnum<{
            low: "low";
            medium: "medium";
            high: "high";
        }>;
    }, z.core.$strict>;
}, z.core.$strict>;
declare const PreferenceClusterSchema: z.ZodObject<{
    category: z.ZodString;
    key: z.ZodString;
    value: z.ZodString;
    confidence: z.ZodNumber;
    lastUpdated: z.ZodString;
    sessionCount: z.ZodNumber;
}, z.core.$strict>;
export declare const UserModelSchema: z.ZodObject<{
    preferencesClusters: z.ZodArray<z.ZodObject<{
        category: z.ZodString;
        key: z.ZodString;
        value: z.ZodString;
        confidence: z.ZodNumber;
        lastUpdated: z.ZodString;
        sessionCount: z.ZodNumber;
    }, z.core.$strict>>;
    interactionStyleSummary: z.ZodString;
    codingStyleSummary: z.ZodString;
    projectOverrides: z.ZodRecord<z.ZodString, z.ZodArray<z.ZodObject<{
        category: z.ZodString;
        key: z.ZodString;
        value: z.ZodString;
        confidence: z.ZodNumber;
        lastUpdated: z.ZodString;
        sessionCount: z.ZodNumber;
    }, z.core.$strict>>>;
}, z.core.$strict>;
export declare const ToMSuggestionSchema: z.ZodObject<{
    type: z.ZodEnum<{
        preference: "preference";
        disambiguation: "disambiguation";
        style: "style";
    }>;
    content: z.ZodString;
    confidence: z.ZodNumber;
    sourceSessions: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
export type Interaction = z.infer<typeof InteractionSchema>;
export type SessionLog = z.infer<typeof SessionLogSchema>;
export type SatisfactionSignals = z.infer<typeof SatisfactionSignalsSchema>;
export type SessionModel = z.infer<typeof SessionModelSchema>;
export type PreferenceCluster = z.infer<typeof PreferenceClusterSchema>;
export type UserModel = z.infer<typeof UserModelSchema>;
export type ToMSuggestion = z.infer<typeof ToMSuggestionSchema>;
export {};
//# sourceMappingURL=schemas.d.ts.map