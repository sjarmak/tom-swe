/**
 * /tom reset skill — clears all ToM memory with a confirmation step.
 *
 * Deletes all files in ~/.claude/tom/ and .claude/tom/ (sessions,
 * session-models, user-model.json, usage.log, BM25 index) but
 * does NOT delete config from settings.json.
 */
export interface DeletedSummary {
    readonly fileCount: number;
    readonly totalBytes: number;
}
export interface ResetResult {
    readonly globalDeleted: DeletedSummary;
    readonly projectDeleted: DeletedSummary;
    readonly totalFileCount: number;
    readonly totalBytes: number;
}
export declare function performReset(): ResetResult;
export declare function formatBytes(bytes: number): string;
export declare function formatResetResult(result: ResetResult): string;
export declare function formatConfirmationPrompt(): string;
export declare function main(): void;
//# sourceMappingURL=tom-reset.d.ts.map