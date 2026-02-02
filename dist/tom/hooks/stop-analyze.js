"use strict";
/**
 * Stop hook TypeScript helper: Analyzes the completed session and updates memory.
 *
 * 1. Reads current session's Tier 1 log
 * 2. Extracts Tier 2 session model (heuristic analysis)
 * 3. Aggregates new session model into Tier 3 user model
 * 4. Rebuilds BM25 search index
 * 5. Logs completion status to tom/usage.log
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
exports.isTomEnabled = isTomEnabled;
exports.getSessionId = getSessionId;
exports.readRawSessionLog = readRawSessionLog;
exports.extractSessionModel = extractSessionModel;
exports.logUsage = logUsage;
exports.analyzeCompletedSession = analyzeCompletedSession;
exports.main = main;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const os = __importStar(require("node:os"));
const schemas_js_1 = require("../schemas.js");
const memory_io_js_1 = require("../memory-io.js");
const aggregation_js_1 = require("../aggregation.js");
const tools_js_1 = require("../agent/tools.js");
// --- Configuration ---
const DEFAULT_MODEL = 'haiku';
// --- Helpers ---
function isTomEnabled() {
    try {
        const configPath = path.join(os.homedir(), '.claude', 'tom', 'config.json');
        const content = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(content);
        return config['enabled'] === true;
    }
    catch {
        return false;
    }
}
function getSessionId() {
    return process.env['CLAUDE_SESSION_ID'] ?? `pid-${process.pid}`;
}
function getSessionFilePath(sessionId) {
    return path.join((0, memory_io_js_1.globalTomDir)(), 'sessions', `${sessionId}.json`);
}
// --- Session Analysis ---
/**
 * Reads a raw Tier 1 session log from disk.
 */
function readRawSessionLog(sessionId) {
    try {
        const filePath = getSessionFilePath(sessionId);
        const content = fs.readFileSync(filePath, 'utf-8');
        const raw = JSON.parse(content);
        const result = schemas_js_1.SessionLogSchema.safeParse(raw);
        return result.success ? result.data : null;
    }
    catch {
        return null;
    }
}
/**
 * Heuristic extraction of SessionModel from SessionLog.
 * Mirrors the logic in agent/tools.ts extractSessionModel.
 */
function extractSessionModel(sessionLog) {
    const toolCounts = {};
    const codingPrefs = [];
    const patterns = [];
    let frustrationCount = 0;
    let satisfactionCount = 0;
    for (const interaction of sessionLog.interactions) {
        toolCounts[interaction.toolName] = (toolCounts[interaction.toolName] ?? 0) + 1;
        const paramKeys = Object.keys(interaction.parameterShape);
        if (paramKeys.includes('language') || paramKeys.includes('file_path')) {
            const fileExt = interaction.parameterShape['file_path'] ?? '';
            if (fileExt && !codingPrefs.includes(fileExt)) {
                codingPrefs.push(fileExt);
            }
        }
        const outcome = interaction.outcomeSummary.toLowerCase();
        if (outcome.includes('error') || outcome.includes('fail') || outcome.includes('retry')) {
            frustrationCount++;
        }
        if (outcome.includes('success') || outcome.includes('complete') || outcome.includes('pass')) {
            satisfactionCount++;
        }
    }
    const sortedTools = Object.entries(toolCounts)
        .sort(([, a], [, b]) => b - a)
        .map(([name]) => name);
    const topTool = sortedTools[0] ?? 'unknown';
    const intent = deriveIntent(topTool, sessionLog.interactions.length);
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
function getUsageLogPath() {
    return path.join((0, memory_io_js_1.globalTomDir)(), 'usage.log');
}
function logUsage(entry) {
    const logPath = getUsageLogPath();
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(logPath, line, 'utf-8');
}
/**
 * Runs the full session analysis pipeline:
 * 1. Read Tier 1 session log
 * 2. Extract Tier 2 session model
 * 3. Aggregate into Tier 3 user model
 * 4. Rebuild BM25 index
 * 5. Log completion
 */
function analyzeCompletedSession(sessionId) {
    // Step 1: Read Tier 1 session log
    const sessionLog = readRawSessionLog(sessionId);
    if (!sessionLog) {
        return {
            success: false,
            sessionId,
            sessionModel: null,
            userModelUpdated: false,
            indexRebuilt: false,
            error: `Session log not found for ${sessionId}`,
        };
    }
    // Step 2: Extract Tier 2 session model
    const sessionModel = extractSessionModel(sessionLog);
    (0, memory_io_js_1.writeSessionModel)(sessionModel, 'global');
    // Step 3: Aggregate into Tier 3 user model
    const currentUserModel = (0, memory_io_js_1.readUserModel)('global');
    const emptyModel = {
        preferencesClusters: [],
        interactionStyleSummary: '',
        codingStyleSummary: '',
        projectOverrides: {},
    };
    const updatedUserModel = (0, aggregation_js_1.aggregateSessionIntoModel)(currentUserModel ?? emptyModel, sessionModel);
    (0, memory_io_js_1.writeUserModel)(updatedUserModel, 'global');
    // Step 4: Rebuild BM25 index
    const index = (0, tools_js_1.buildMemoryIndex)('global');
    const indexPath = path.join((0, memory_io_js_1.globalTomDir)(), 'bm25-index.json');
    const indexDir = path.dirname(indexPath);
    if (!fs.existsSync(indexDir)) {
        fs.mkdirSync(indexDir, { recursive: true });
    }
    fs.writeFileSync(indexPath, JSON.stringify(index), 'utf-8');
    // Step 5: Log completion
    logUsage({
        timestamp: new Date().toISOString(),
        operation: 'session-analysis',
        model: DEFAULT_MODEL,
        tokenCount: 0,
        sessionId,
    });
    return {
        success: true,
        sessionId,
        sessionModel,
        userModelUpdated: true,
        indexRebuilt: true,
    };
}
// --- CLI Entry Point ---
function main() {
    if (!isTomEnabled()) {
        return;
    }
    const sessionId = getSessionId();
    if (!sessionId) {
        return;
    }
    try {
        analyzeCompletedSession(sessionId);
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logUsage({
            timestamp: new Date().toISOString(),
            operation: 'session-analysis-error',
            model: DEFAULT_MODEL,
            tokenCount: 0,
            sessionId,
        });
        // Write error to stderr but don't throw — this runs in background
        process.stderr.write(`ToM stop-analyze error: ${errorMessage}\n`);
    }
}
// Run if executed directly
if (require.main === module) {
    main();
}
//# sourceMappingURL=stop-analyze.js.map