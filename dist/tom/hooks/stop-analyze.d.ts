/**
 * Stop hook TypeScript helper: Analyzes the completed session and updates memory.
 *
 * 1. Reads current session's Tier 1 log
 * 2. Extracts Tier 2 session model (heuristic analysis)
 * 3. Aggregates new session model into Tier 3 user model
 * 4. Rebuilds BM25 search index
 * 5. Logs completion status to tom/usage.log
 */
import type { SessionLog, SessionModel } from '../schemas.js';
export declare function isTomEnabled(): boolean;
export declare function getSessionId(): string;
/**
 * Reads a raw Tier 1 session log from disk.
 */
export declare function readRawSessionLog(sessionId: string): SessionLog | null;
/**
 * Heuristic extraction of SessionModel from SessionLog.
 * Mirrors the logic in agent/tools.ts extractSessionModel.
 */
export declare function extractSessionModel(sessionLog: SessionLog): SessionModel;
interface UsageLogEntry {
    readonly timestamp: string;
    readonly operation: string;
    readonly model: string;
    readonly tokenCount: number;
    readonly sessionId: string;
}
export declare function logUsage(entry: UsageLogEntry): void;
export interface AnalysisResult {
    readonly success: boolean;
    readonly sessionId: string;
    readonly sessionModel: SessionModel | null;
    readonly userModelUpdated: boolean;
    readonly indexRebuilt: boolean;
    readonly error?: string;
}
/**
 * Runs the full session analysis pipeline:
 * 1. Read Tier 1 session log
 * 2. Extract Tier 2 session model
 * 3. Aggregate into Tier 3 user model
 * 4. Rebuild BM25 index
 * 5. Log completion
 */
export declare function analyzeCompletedSession(sessionId: string): AnalysisResult;
export declare function main(): void;
export {};
//# sourceMappingURL=stop-analyze.d.ts.map