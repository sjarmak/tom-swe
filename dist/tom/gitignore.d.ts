interface EnsureGitignoreResult {
    readonly action: 'added' | 'already_present' | 'no_gitignore';
    readonly gitignorePath: string;
}
export declare function ensureGitignoreEntry(projectRoot: string): EnsureGitignoreResult;
export declare function formatResult(result: EnsureGitignoreResult): string;
export {};
//# sourceMappingURL=gitignore.d.ts.map