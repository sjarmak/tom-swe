"use strict";
/**
 * /tom forget [session-id] — removes a specific session and rebuilds Tier 3.
 * /tom export — exports all ToM data to a single JSON file.
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
exports.forgetSession = forgetSession;
exports.formatForgetResult = formatForgetResult;
exports.collectExportData = collectExportData;
exports.exportToFile = exportToFile;
exports.formatExportResult = formatExportResult;
exports.main = main;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const memory_io_js_1 = require("../memory-io.js");
const config_js_1 = require("../config.js");
const aggregation_js_1 = require("../aggregation.js");
const tools_js_1 = require("../agent/tools.js");
// --- Forget ---
function deleteFile(filePath) {
    try {
        fs.unlinkSync(filePath);
        return true;
    }
    catch {
        return false;
    }
}
function listJsonFiles(dirPath) {
    try {
        return fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
    }
    catch {
        return [];
    }
}
function sessionFileExists(sessionId, scope) {
    const tomDir = scope === 'global' ? (0, memory_io_js_1.globalTomDir)() : (0, memory_io_js_1.projectTomDir)();
    const filePath = path.join(tomDir, 'sessions', `${sessionId}.json`);
    return fs.existsSync(filePath) ? filePath : null;
}
function sessionModelFileExists(sessionId, scope) {
    const tomDir = scope === 'global' ? (0, memory_io_js_1.globalTomDir)() : (0, memory_io_js_1.projectTomDir)();
    const filePath = path.join(tomDir, 'session-models', `${sessionId}.json`);
    return fs.existsSync(filePath) ? filePath : null;
}
/**
 * Rebuilds Tier 3 user model from scratch using all remaining
 * Tier 2 session models (after a session has been removed).
 */
function rebuildUserModel(scope) {
    const tomDir = scope === 'global' ? (0, memory_io_js_1.globalTomDir)() : (0, memory_io_js_1.projectTomDir)();
    const modelsDir = path.join(tomDir, 'session-models');
    const files = listJsonFiles(modelsDir);
    const config = (0, config_js_1.readTomConfig)();
    const emptyModel = {
        preferencesClusters: [],
        interactionStyleSummary: '',
        codingStyleSummary: '',
        projectOverrides: {},
    };
    let model = emptyModel;
    // Sort by sessionId for deterministic ordering
    const sortedFiles = [...files].sort();
    for (const file of sortedFiles) {
        const sessionId = file.replace('.json', '');
        const sessionModel = (0, memory_io_js_1.readSessionModel)(sessionId, scope);
        if (sessionModel) {
            model = (0, aggregation_js_1.aggregateSessionIntoModel)(model, sessionModel, config.preferenceDecayDays);
        }
    }
    (0, memory_io_js_1.writeUserModel)(model, scope);
}
/**
 * Forgets a specific session: deletes Tier 1 and Tier 2 files,
 * rebuilds Tier 3 user model without the deleted session's data.
 */
function forgetSession(sessionId) {
    let tier1Deleted = false;
    let tier2Deleted = false;
    let tier3Rebuilt = false;
    // Try both scopes
    for (const scope of ['global', 'project']) {
        const sessionPath = sessionFileExists(sessionId, scope);
        if (sessionPath) {
            tier1Deleted = deleteFile(sessionPath) || tier1Deleted;
        }
        const modelPath = sessionModelFileExists(sessionId, scope);
        if (modelPath) {
            tier2Deleted = deleteFile(modelPath) || tier2Deleted;
        }
        if (tier1Deleted || tier2Deleted) {
            rebuildUserModel(scope);
            tier3Rebuilt = true;
            // Rebuild BM25 index
            const index = (0, tools_js_1.buildMemoryIndex)(scope);
            const tomDir = scope === 'global' ? (0, memory_io_js_1.globalTomDir)() : (0, memory_io_js_1.projectTomDir)();
            const indexPath = path.join(tomDir, 'bm25-index.json');
            const dir = path.dirname(indexPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(indexPath, JSON.stringify(index), 'utf-8');
        }
    }
    return { sessionId, tier1Deleted, tier2Deleted, tier3Rebuilt };
}
function formatForgetResult(result) {
    const lines = [];
    lines.push('# ToM Forget');
    lines.push('');
    if (!result.tier1Deleted && !result.tier2Deleted) {
        lines.push(`Session "${result.sessionId}" not found in any scope.`);
        return lines.join('\n');
    }
    lines.push(`Session "${result.sessionId}" has been removed:`);
    lines.push(`- Tier 1 session log: ${result.tier1Deleted ? 'deleted' : 'not found'}`);
    lines.push(`- Tier 2 session model: ${result.tier2Deleted ? 'deleted' : 'not found'}`);
    lines.push(`- Tier 3 user model: ${result.tier3Rebuilt ? 'rebuilt without this session' : 'unchanged'}`);
    return lines.join('\n');
}
// --- Export ---
function readUsageLog() {
    const logPath = path.join((0, memory_io_js_1.globalTomDir)(), 'usage.log');
    try {
        const content = fs.readFileSync(logPath, 'utf-8');
        return content.split('\n').filter(line => line.trim().length > 0);
    }
    catch {
        return [];
    }
}
function readAllSessions(scope) {
    const tomDir = scope === 'global' ? (0, memory_io_js_1.globalTomDir)() : (0, memory_io_js_1.projectTomDir)();
    const sessionsDir = path.join(tomDir, 'sessions');
    const files = listJsonFiles(sessionsDir);
    const sessions = [];
    for (const file of files) {
        const sessionId = file.replace('.json', '');
        const session = (0, memory_io_js_1.readSessionLog)(sessionId, scope);
        if (session) {
            sessions.push(session);
        }
    }
    return sessions;
}
function readAllSessionModels(scope) {
    const tomDir = scope === 'global' ? (0, memory_io_js_1.globalTomDir)() : (0, memory_io_js_1.projectTomDir)();
    const modelsDir = path.join(tomDir, 'session-models');
    const files = listJsonFiles(modelsDir);
    const models = [];
    for (const file of files) {
        const sessionId = file.replace('.json', '');
        const model = (0, memory_io_js_1.readSessionModel)(sessionId, scope);
        if (model) {
            models.push(model);
        }
    }
    return models;
}
function deduplicateById(global, project) {
    const seen = new Set();
    const result = [];
    for (const item of global) {
        if (!seen.has(item.sessionId)) {
            seen.add(item.sessionId);
            result.push(item);
        }
    }
    for (const item of project) {
        if (!seen.has(item.sessionId)) {
            seen.add(item.sessionId);
            result.push(item);
        }
    }
    return result;
}
/**
 * Collects all ToM data (Tier 1, 2, 3, config, usage log) for export.
 */
function collectExportData() {
    const config = (0, config_js_1.readTomConfig)();
    const userModel = (0, memory_io_js_1.readUserModel)('merged');
    const usageLog = readUsageLog();
    const globalSessions = readAllSessions('global');
    const projectSessions = readAllSessions('project');
    const allSessions = deduplicateById(globalSessions, projectSessions);
    const globalModels = readAllSessionModels('global');
    const projectModels = readAllSessionModels('project');
    const allModels = deduplicateById(globalModels, projectModels);
    return {
        exportedAt: new Date().toISOString(),
        version: '1.0',
        config,
        tier1Sessions: allSessions,
        tier2Models: allModels,
        tier3UserModel: userModel,
        usageLog,
    };
}
/**
 * Exports all ToM data to a JSON file in the current directory.
 * Returns the path of the exported file.
 */
function exportToFile() {
    const data = collectExportData();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `tom-export-${timestamp}.json`;
    const filePath = path.join(process.cwd(), filename);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return filePath;
}
function formatExportResult(filePath, data) {
    const lines = [];
    lines.push('# ToM Export');
    lines.push('');
    lines.push(`Exported to: ${filePath}`);
    lines.push('');
    lines.push('## Contents');
    lines.push(`- Tier 1 sessions: ${data.tier1Sessions.length}`);
    lines.push(`- Tier 2 session models: ${data.tier2Models.length}`);
    lines.push(`- Tier 3 user model: ${data.tier3UserModel !== null ? 'present' : 'none'}`);
    lines.push(`- Usage log entries: ${data.usageLog.length}`);
    lines.push('');
    lines.push('The export file is self-contained and could be imported in a future version.');
    return lines.join('\n');
}
// --- CLI Entry Point ---
function main() {
    const args = process.argv.slice(2);
    const command = args[0] ?? '';
    if (command === 'forget') {
        const sessionId = args[1] ?? '';
        if (sessionId === '') {
            process.stdout.write('Usage: tom-forget-export forget <session-id>\n');
            return;
        }
        const result = forgetSession(sessionId);
        process.stdout.write(formatForgetResult(result));
        return;
    }
    if (command === 'export') {
        const data = collectExportData();
        const filePath = exportToFile();
        process.stdout.write(formatExportResult(filePath, data));
        return;
    }
    process.stdout.write('Usage: tom-forget-export <forget|export> [args]\n');
}
if (require.main === module) {
    main();
}
//# sourceMappingURL=tom-forget-export.js.map