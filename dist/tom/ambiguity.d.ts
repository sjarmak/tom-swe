/**
 * Lightweight heuristics for detecting ambiguity in user instructions.
 *
 * Pure functions — no I/O, no model calls. Executes in <50ms.
 */
export type AmbiguityThreshold = 'low' | 'medium' | 'high';
export interface AmbiguityResult {
    readonly isAmbiguous: boolean;
    readonly score: number;
    readonly reason: string;
}
export interface DetectAmbiguityInput {
    readonly toolName: string;
    readonly toolParameters: Readonly<Record<string, unknown>>;
    readonly recentUserMessages: readonly string[];
    readonly threshold?: AmbiguityThreshold;
    readonly hasUserModel?: boolean;
}
/**
 * Detects whether user instructions are ambiguous enough to warrant
 * ToM consultation.
 *
 * Heuristics:
 * 1. Short/vague user instruction (<10 words, no file paths)
 * 2. Multiple valid file targets for an edit
 * 3. Preference-sensitive decisions (style, architecture, library choice)
 * 4. First interaction in new project with no user model
 *
 * Returns { isAmbiguous, score (0-1), reason }.
 */
export declare function detectAmbiguity(input: DetectAmbiguityInput): AmbiguityResult;
//# sourceMappingURL=ambiguity.d.ts.map