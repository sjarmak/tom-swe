/**
 * ToM sub-agent tool implementations.
 *
 * These 5 tools are invoked by the ToM agent to interact with the memory system:
 * - search_memory: BM25 search across all memory tiers
 * - read_memory_file: Read a specific tier file
 * - analyze_session: Extract Tier 2 model from Tier 1 log
 * - initialize_user_profile: Bootstrap Tier 3 from available sessions
 * - give_suggestions: Output structured ToMSuggestion array
 */
import type { SessionLog, SessionModel, UserModel, ToMSuggestion } from '../schemas.js';
import type { BM25SearchResult, BM25Index } from '../bm25.js';
import { MEMORY_OPERATION_TOOLS, isMemoryOperationAllowed } from './config.js';
export interface SearchMemoryParams {
    readonly query: string;
    readonly k?: number;
}
export interface SearchMemoryResult {
    readonly results: readonly BM25SearchResult[];
    readonly operationCount: number;
}
export interface ReadMemoryFileParams {
    readonly tier: 1 | 2 | 3;
    readonly id: string;
    readonly scope?: 'global' | 'project' | 'merged';
}
export interface ReadMemoryFileResult {
    readonly data: SessionLog | SessionModel | UserModel | null;
    readonly operationCount: number;
}
export interface AnalyzeSessionParams {
    readonly sessionId: string;
    readonly scope?: 'global' | 'project';
}
export interface AnalyzeSessionResult {
    readonly sessionModel: SessionModel | null;
    readonly operationCount: number;
}
export interface InitializeUserProfileParams {
    readonly scope?: 'global' | 'project';
}
export interface InitializeUserProfileResult {
    readonly created: boolean;
    readonly sessionCount: number;
}
export interface GiveSuggestionsParams {
    readonly suggestions: readonly ToMSuggestion[];
}
export interface GiveSuggestionsResult {
    readonly accepted: number;
    readonly suggestions: readonly ToMSuggestion[];
}
/**
 * Tracks the state of a single ToM agent invocation.
 * Enforces the memory operation limit.
 */
export interface AgentInvocationState {
    readonly operationCount: number;
    readonly maxOperations: number;
}
export declare function createInvocationState(maxOperations?: number): AgentInvocationState;
/**
 * Builds a BM25 index from all available memory files across tiers.
 */
export declare function buildMemoryIndex(scope?: 'global' | 'project'): BM25Index;
export declare function searchMemory(params: SearchMemoryParams, state: AgentInvocationState, index: BM25Index): {
    readonly result: SearchMemoryResult;
    readonly state: AgentInvocationState;
};
export declare function readMemoryFile(params: ReadMemoryFileParams, state: AgentInvocationState): {
    readonly result: ReadMemoryFileResult;
    readonly state: AgentInvocationState;
};
/**
 * Extracts a Tier 2 SessionModel from a Tier 1 SessionLog.
 *
 * This performs a lightweight heuristic extraction:
 * - Intent derived from the most common tool patterns
 * - Coding preferences from tool parameter shapes
 * - Interaction patterns from tool usage sequences
 * - Satisfaction signals from outcome summaries
 */
export declare function analyzeSession(params: AnalyzeSessionParams, state: AgentInvocationState): {
    readonly result: AnalyzeSessionResult;
    readonly state: AgentInvocationState;
};
export declare function initializeUserProfile(params: InitializeUserProfileParams): InitializeUserProfileResult;
export declare function giveSuggestions(params: GiveSuggestionsParams): GiveSuggestionsResult;
export { MEMORY_OPERATION_TOOLS, isMemoryOperationAllowed };
//# sourceMappingURL=tools.d.ts.map