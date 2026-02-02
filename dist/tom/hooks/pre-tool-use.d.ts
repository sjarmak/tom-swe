/**
 * PreToolUse hook TypeScript helper: Consults the ToM agent when ambiguity is detected.
 *
 * 1. Checks if ToM is enabled
 * 2. Runs ambiguity detection from ambiguity.ts against current tool call
 * 3. If ambiguity exceeds threshold, searches memory for relevant preferences
 * 4. Produces ToMSuggestion and writes to stdout for Claude Code hook injection
 * 5. Logs consultation to tom/usage.log
 */
import type { ToMSuggestion } from '../schemas.js';
import type { AmbiguityThreshold, AmbiguityResult } from '../ambiguity.js';
interface TomSettings {
    readonly enabled: boolean;
    readonly consultThreshold: AmbiguityThreshold;
}
export declare function readTomSettings(): TomSettings;
export declare function isTomEnabled(): boolean;
export declare function getSessionId(): string;
interface UsageLogEntry {
    readonly timestamp: string;
    readonly operation: string;
    readonly model: string;
    readonly tokenCount: number;
    readonly sessionId: string;
}
export declare function logUsage(entry: UsageLogEntry): void;
export interface ConsultationResult {
    readonly consulted: boolean;
    readonly ambiguityResult: AmbiguityResult;
    readonly suggestion: ToMSuggestion | null;
}
/**
 * Runs the full consultation pipeline:
 * 1. Detect ambiguity
 * 2. If ambiguous, search memory or read user model
 * 3. Generate suggestion
 * 4. Log consultation
 */
export declare function consultToM(toolName: string, toolInput: Record<string, unknown>, recentMessages: readonly string[], threshold: AmbiguityThreshold): ConsultationResult;
export declare function main(): void;
export {};
//# sourceMappingURL=pre-tool-use.d.ts.map