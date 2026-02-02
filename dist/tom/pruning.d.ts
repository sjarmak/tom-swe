/**
 * Session pruning for Tier 1.
 *
 * Prunes old sessions when maxSessionsRetained is exceeded
 * to prevent unbounded storage growth. Also removes corresponding
 * Tier 2 session models and rebuilds the BM25 index.
 */
export interface PruneResult {
    readonly prunedSessionIds: readonly string[];
    readonly sessionsBeforePrune: number;
    readonly sessionsAfterPrune: number;
    readonly indexRebuilt: boolean;
}
/**
 * Prunes old Tier 1 sessions when count exceeds maxSessionsRetained.
 * Also deletes corresponding Tier 2 session models.
 * Rebuilds BM25 index after pruning.
 *
 * Returns list of pruned session IDs.
 */
export declare function pruneOldSessions(maxSessionsRetained: number, scope?: 'global' | 'project'): PruneResult;
//# sourceMappingURL=pruning.d.ts.map