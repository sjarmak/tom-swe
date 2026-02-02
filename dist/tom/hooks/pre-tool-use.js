"use strict";
/**
 * PreToolUse hook TypeScript helper: Consults the ToM agent when ambiguity is detected.
 *
 * 1. Checks if ToM is enabled
 * 2. Runs ambiguity detection from ambiguity.ts against current tool call
 * 3. If ambiguity exceeds threshold, searches memory for relevant preferences
 * 4. Produces ToMSuggestion and writes to stdout for Claude Code hook injection
 * 5. Logs consultation to tom/usage.log
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
exports.readTomSettings = readTomSettings;
exports.isTomEnabled = isTomEnabled;
exports.getSessionId = getSessionId;
exports.logUsage = logUsage;
exports.consultToM = consultToM;
exports.main = main;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const os = __importStar(require("node:os"));
const schemas_js_1 = require("../schemas.js");
const ambiguity_js_1 = require("../ambiguity.js");
const memory_io_js_1 = require("../memory-io.js");
const bm25_js_1 = require("../bm25.js");
// --- Configuration ---
const DEFAULT_CONSULTATION_MODEL = 'sonnet';
const DEFAULT_THRESHOLD = 'medium';
function readTomSettings() {
    try {
        const configPath = path.join(os.homedir(), '.claude', 'tom', 'config.json');
        const content = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(content);
        const enabled = config['enabled'] === true;
        const threshold = config['consultThreshold'];
        const validThresholds = ['low', 'medium', 'high'];
        const consultThreshold = typeof threshold === 'string' && validThresholds.includes(threshold)
            ? threshold
            : DEFAULT_THRESHOLD;
        return { enabled, consultThreshold };
    }
    catch {
        return { enabled: false, consultThreshold: DEFAULT_THRESHOLD };
    }
}
function isTomEnabled() {
    return readTomSettings().enabled;
}
// --- Session & Environment ---
function getSessionId() {
    return process.env['CLAUDE_SESSION_ID'] ?? `pid-${process.pid}`;
}
function parseToolInput(raw) {
    try {
        return JSON.parse(raw);
    }
    catch {
        return {};
    }
}
// --- BM25 Index Loading ---
function loadCachedIndex() {
    try {
        const indexPath = path.join((0, memory_io_js_1.globalTomDir)(), 'bm25-index.json');
        const content = fs.readFileSync(indexPath, 'utf-8');
        return JSON.parse(content);
    }
    catch {
        return null;
    }
}
// --- Suggestion Generation ---
function buildSuggestionFromSearch(searchResults, ambiguityResult, toolName) {
    if (searchResults.length === 0) {
        return null;
    }
    const topResults = searchResults.slice(0, 3);
    const sourceSessions = topResults
        .map(r => r.id)
        .filter(id => id.startsWith('session:') || id.startsWith('model:'))
        .map(id => id.replace(/^(session|model):/, ''));
    const preferenceHints = topResults
        .map(r => r.id.startsWith('user-model')
        ? 'user model preferences'
        : `session ${r.id.replace(/^(session|model):/, '')}`)
        .join(', ');
    const content = `Based on past interactions (${preferenceHints}), ` +
        `the user may have preferences relevant to this ${toolName} operation. ` +
        `Ambiguity reason: ${ambiguityResult.reason}.`;
    const suggestion = {
        type: ambiguityResult.reason.includes('style') || ambiguityResult.reason.includes('preference')
            ? 'style'
            : 'disambiguation',
        content,
        confidence: Math.round(ambiguityResult.score * 100) / 100,
        sourceSessions,
    };
    const parseResult = schemas_js_1.ToMSuggestionSchema.safeParse(suggestion);
    return parseResult.success ? parseResult.data : null;
}
function buildSuggestionFromUserModel(ambiguityResult, toolName) {
    const userModel = (0, memory_io_js_1.readUserModel)('merged');
    if (!userModel || userModel.preferencesClusters.length === 0) {
        return null;
    }
    const topPrefs = [...userModel.preferencesClusters]
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 5);
    const prefSummary = topPrefs
        .map(p => `${p.key}=${p.value} (${Math.round(p.confidence * 100)}%)`)
        .join(', ');
    const content = `User preferences: ${prefSummary}. ` +
        `Consider these for the current ${toolName} operation. ` +
        `Ambiguity reason: ${ambiguityResult.reason}.`;
    const suggestion = {
        type: 'preference',
        content,
        confidence: Math.round(ambiguityResult.score * 100) / 100,
        sourceSessions: [],
    };
    const parseResult = schemas_js_1.ToMSuggestionSchema.safeParse(suggestion);
    return parseResult.success ? parseResult.data : null;
}
function logUsage(entry) {
    const logPath = path.join((0, memory_io_js_1.globalTomDir)(), 'usage.log');
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(logPath, line, 'utf-8');
}
/**
 * Runs the full consultation pipeline:
 * 1. Detect ambiguity
 * 2. If ambiguous, search memory or read user model
 * 3. Generate suggestion
 * 4. Log consultation
 */
function consultToM(toolName, toolInput, recentMessages, threshold) {
    const hasUserModel = (0, memory_io_js_1.readUserModel)('global') !== null;
    const ambiguityResult = (0, ambiguity_js_1.detectAmbiguity)({
        toolName,
        toolParameters: toolInput,
        recentUserMessages: recentMessages,
        threshold,
        hasUserModel,
    });
    if (!ambiguityResult.isAmbiguous) {
        return {
            consulted: false,
            ambiguityResult,
            suggestion: null,
        };
    }
    // Try BM25 search first
    const cachedIndex = loadCachedIndex();
    let suggestion = null;
    if (cachedIndex) {
        const query = [toolName, ...recentMessages].join(' ');
        const results = (0, bm25_js_1.search)(cachedIndex, query, 3);
        suggestion = buildSuggestionFromSearch(results, ambiguityResult, toolName);
    }
    // Fall back to direct user model reading if no BM25 results
    if (!suggestion) {
        suggestion = buildSuggestionFromUserModel(ambiguityResult, toolName);
    }
    const sessionId = getSessionId();
    logUsage({
        timestamp: new Date().toISOString(),
        operation: 'consultation',
        model: DEFAULT_CONSULTATION_MODEL,
        tokenCount: 0,
        sessionId,
    });
    return {
        consulted: true,
        ambiguityResult,
        suggestion,
    };
}
// --- CLI Entry Point ---
function main() {
    if (!isTomEnabled()) {
        return;
    }
    const toolName = process.env['TOOL_NAME'] ?? '';
    const toolInputRaw = process.env['TOOL_INPUT'] ?? '{}';
    if (!toolName) {
        return;
    }
    const toolInput = parseToolInput(toolInputRaw);
    const settings = readTomSettings();
    // Recent messages not available in env; use empty array
    // The ambiguity detection will still work based on tool parameters
    const recentMessages = [];
    try {
        const result = consultToM(toolName, toolInput, recentMessages, settings.consultThreshold);
        if (result.consulted && result.suggestion) {
            // Write suggestion to stdout for Claude Code hook system injection
            const output = JSON.stringify(result.suggestion);
            process.stdout.write(output);
        }
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const sessionId = getSessionId();
        logUsage({
            timestamp: new Date().toISOString(),
            operation: 'consultation-error',
            model: DEFAULT_CONSULTATION_MODEL,
            tokenCount: 0,
            sessionId,
        });
        process.stderr.write(`ToM pre-tool-use error: ${errorMessage}\n`);
    }
}
// Run if executed directly
if (require.main === module) {
    main();
}
//# sourceMappingURL=pre-tool-use.js.map