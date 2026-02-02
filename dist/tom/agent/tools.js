"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.isMemoryOperationAllowed = exports.MEMORY_OPERATION_TOOLS = void 0;
exports.createInvocationState = createInvocationState;
exports.buildMemoryIndex = buildMemoryIndex;
exports.searchMemory = searchMemory;
exports.readMemoryFile = readMemoryFile;
exports.analyzeSession = analyzeSession;
exports.initializeUserProfile = initializeUserProfile;
exports.giveSuggestions = giveSuggestions;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const schemas_js_1 = require("../schemas.js");
const bm25_js_1 = require("../bm25.js");
const memory_io_js_1 = require("../memory-io.js");
const aggregation_js_1 = require("../aggregation.js");
const config_js_1 = require("./config.js");
Object.defineProperty(exports, "MEMORY_OPERATION_TOOLS", { enumerable: true, get: function () { return config_js_1.MEMORY_OPERATION_TOOLS; } });
Object.defineProperty(exports, "isMemoryOperationAllowed", { enumerable: true, get: function () { return config_js_1.isMemoryOperationAllowed; } });
function createInvocationState(maxOperations = 3) {
    return { operationCount: 0, maxOperations };
}
function incrementOperationCount(state) {
    return { ...state, operationCount: state.operationCount + 1 };
}
// --- BM25 Index Building ---
function listJsonFiles(dirPath) {
    try {
        const files = fs.readdirSync(dirPath);
        return files.filter(f => f.endsWith('.json'));
    }
    catch {
        return [];
    }
}
/**
 * Builds a BM25 index from all available memory files across tiers.
 */
function buildMemoryIndex(scope = 'global') {
    const tomDir = scope === 'global' ? (0, memory_io_js_1.globalTomDir)() : (0, memory_io_js_1.projectTomDir)();
    const documents = [];
    // Tier 1: Session logs
    const sessionsDir = path.join(tomDir, 'sessions');
    const sessionFiles = listJsonFiles(sessionsDir);
    for (const file of sessionFiles) {
        const sessionId = file.replace('.json', '');
        const session = (0, memory_io_js_1.readSessionLog)(sessionId, scope);
        if (session) {
            const content = session.interactions
                .map(i => `${i.toolName} ${Object.keys(i.parameterShape).join(' ')} ${i.outcomeSummary}`)
                .join(' ');
            documents.push({ id: `session:${sessionId}`, content, tier: 1 });
        }
    }
    // Tier 2: Session models
    const modelsDir = path.join(tomDir, 'session-models');
    const modelFiles = listJsonFiles(modelsDir);
    for (const file of modelFiles) {
        const sessionId = file.replace('.json', '');
        const model = (0, memory_io_js_1.readSessionModel)(sessionId, scope);
        if (model) {
            const content = [
                model.intent,
                ...model.interactionPatterns,
                ...model.codingPreferences,
            ].join(' ');
            documents.push({ id: `model:${sessionId}`, content, tier: 2 });
        }
    }
    // Tier 3: User model
    const userModel = (0, memory_io_js_1.readUserModel)(scope === 'global' ? 'global' : 'project');
    if (userModel) {
        const content = [
            userModel.interactionStyleSummary,
            userModel.codingStyleSummary,
            ...userModel.preferencesClusters.map(p => `${p.category} ${p.key} ${p.value}`),
        ].join(' ');
        documents.push({ id: 'user-model', content, tier: 3 });
    }
    return (0, bm25_js_1.buildIndex)(documents);
}
// --- Tool: search_memory ---
function searchMemory(params, state, index) {
    if (!(0, config_js_1.isMemoryOperationAllowed)(state.operationCount, state.maxOperations)) {
        return {
            result: { results: [], operationCount: state.operationCount },
            state,
        };
    }
    const nextState = incrementOperationCount(state);
    const results = (0, bm25_js_1.search)(index, params.query, params.k ?? 3);
    return {
        result: { results, operationCount: nextState.operationCount },
        state: nextState,
    };
}
// --- Tool: read_memory_file ---
function readMemoryFile(params, state) {
    if (!(0, config_js_1.isMemoryOperationAllowed)(state.operationCount, state.maxOperations)) {
        return {
            result: { data: null, operationCount: state.operationCount },
            state,
        };
    }
    const nextState = incrementOperationCount(state);
    let data = null;
    if (params.tier === 1) {
        data = (0, memory_io_js_1.readSessionLog)(params.id, params.scope === 'project' ? 'project' : 'global');
    }
    else if (params.tier === 2) {
        data = (0, memory_io_js_1.readSessionModel)(params.id, params.scope === 'project' ? 'project' : 'global');
    }
    else if (params.tier === 3) {
        const modelScope = params.scope ?? 'merged';
        data = (0, memory_io_js_1.readUserModel)(modelScope);
    }
    return {
        result: { data, operationCount: nextState.operationCount },
        state: nextState,
    };
}
// --- Tool: analyze_session ---
/**
 * Extracts a Tier 2 SessionModel from a Tier 1 SessionLog.
 *
 * This performs a lightweight heuristic extraction:
 * - Intent derived from the most common tool patterns
 * - Coding preferences from tool parameter shapes
 * - Interaction patterns from tool usage sequences
 * - Satisfaction signals from outcome summaries
 */
function analyzeSession(params, state) {
    if (!(0, config_js_1.isMemoryOperationAllowed)(state.operationCount, state.maxOperations)) {
        return {
            result: { sessionModel: null, operationCount: state.operationCount },
            state,
        };
    }
    const nextState = incrementOperationCount(state);
    const sessionLog = (0, memory_io_js_1.readSessionLog)(params.sessionId, params.scope ?? 'global');
    if (!sessionLog) {
        return {
            result: { sessionModel: null, operationCount: nextState.operationCount },
            state: nextState,
        };
    }
    const sessionModel = extractSessionModel(sessionLog);
    (0, memory_io_js_1.writeSessionModel)(sessionModel, params.scope ?? 'global');
    return {
        result: { sessionModel, operationCount: nextState.operationCount },
        state: nextState,
    };
}
/**
 * Heuristic extraction of SessionModel from SessionLog.
 */
function extractSessionModel(sessionLog) {
    const toolCounts = {};
    const codingPrefs = [];
    const patterns = [];
    let frustrationCount = 0;
    let satisfactionCount = 0;
    for (const interaction of sessionLog.interactions) {
        toolCounts[interaction.toolName] = (toolCounts[interaction.toolName] ?? 0) + 1;
        // Extract coding preferences from parameter shapes
        const paramKeys = Object.keys(interaction.parameterShape);
        if (paramKeys.includes('language') || paramKeys.includes('file_path')) {
            const fileExt = interaction.parameterShape['file_path'] ?? '';
            if (fileExt && !codingPrefs.includes(fileExt)) {
                codingPrefs.push(fileExt);
            }
        }
        // Detect satisfaction from outcomes
        const outcome = interaction.outcomeSummary.toLowerCase();
        if (outcome.includes('error') || outcome.includes('fail') || outcome.includes('retry')) {
            frustrationCount++;
        }
        if (outcome.includes('success') || outcome.includes('complete') || outcome.includes('pass')) {
            satisfactionCount++;
        }
    }
    // Derive intent from most-used tools
    const sortedTools = Object.entries(toolCounts)
        .sort(([, a], [, b]) => b - a)
        .map(([name]) => name);
    const topTool = sortedTools[0] ?? 'unknown';
    const intent = deriveIntent(topTool, sessionLog.interactions.length);
    // Derive interaction patterns from tool sequence
    for (const toolName of sortedTools.slice(0, 5)) {
        patterns.push(`uses-${toolName}`);
    }
    const totalInteractions = sessionLog.interactions.length;
    const frustration = totalInteractions > 0 && frustrationCount / totalInteractions > 0.3;
    const satisfaction = totalInteractions > 0 && satisfactionCount / totalInteractions > 0.5;
    const urgency = totalInteractions > 20 ? 'high'
        : totalInteractions > 10 ? 'medium'
            : 'low';
    return {
        sessionId: sessionLog.sessionId,
        intent,
        interactionPatterns: patterns,
        codingPreferences: codingPrefs,
        satisfactionSignals: {
            frustration,
            satisfaction,
            urgency,
        },
    };
}
function deriveIntent(topTool, interactionCount) {
    const toolIntentMap = {
        Edit: 'code modification',
        Write: 'file creation',
        Read: 'code exploration',
        Bash: 'command execution',
        Grep: 'code search',
        Glob: 'file search',
        Task: 'complex task delegation',
    };
    const baseIntent = toolIntentMap[topTool] ?? `${topTool} usage`;
    const scope = interactionCount > 20 ? 'extensive' : interactionCount > 10 ? 'moderate' : 'brief';
    return `${scope} ${baseIntent}`;
}
// --- Tool: initialize_user_profile ---
function initializeUserProfile(params) {
    const scope = params.scope ?? 'global';
    const existing = (0, memory_io_js_1.readUserModel)(scope);
    if (existing) {
        return { created: false, sessionCount: 0 };
    }
    const emptyModel = {
        preferencesClusters: [],
        interactionStyleSummary: '',
        codingStyleSummary: '',
        projectOverrides: {},
    };
    // Bootstrap from available session models
    const tomDir = scope === 'global' ? (0, memory_io_js_1.globalTomDir)() : (0, memory_io_js_1.projectTomDir)();
    const modelsDir = path.join(tomDir, 'session-models');
    const modelFiles = listJsonFiles(modelsDir);
    let model = emptyModel;
    let sessionCount = 0;
    for (const file of modelFiles) {
        const sessionId = file.replace('.json', '');
        const sessionModel = (0, memory_io_js_1.readSessionModel)(sessionId, scope);
        if (sessionModel) {
            model = (0, aggregation_js_1.aggregateSessionIntoModel)(model, sessionModel);
            sessionCount++;
        }
    }
    (0, memory_io_js_1.writeUserModel)(model, scope);
    return { created: true, sessionCount };
}
// --- Tool: give_suggestions ---
function giveSuggestions(params) {
    const validated = [];
    for (const suggestion of params.suggestions) {
        const parseResult = schemas_js_1.ToMSuggestionSchema.safeParse(suggestion);
        if (parseResult.success) {
            validated.push(parseResult.data);
        }
    }
    return {
        accepted: validated.length,
        suggestions: validated,
    };
}
//# sourceMappingURL=tools.js.map