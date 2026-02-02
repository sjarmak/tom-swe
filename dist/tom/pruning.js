"use strict";
/**
 * Session pruning for Tier 1.
 *
 * Prunes old sessions when maxSessionsRetained is exceeded
 * to prevent unbounded storage growth. Also removes corresponding
 * Tier 2 session models and rebuilds the BM25 index.
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
exports.pruneOldSessions = pruneOldSessions;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const memory_io_1 = require("./memory-io");
const tools_1 = require("./agent/tools");
// --- Helpers ---
function listJsonFiles(dirPath) {
    try {
        return fs.readdirSync(dirPath)
            .filter(f => f.endsWith('.json'));
    }
    catch {
        return [];
    }
}
function getSessionTimestamps(scope) {
    const tomDir = scope === 'global' ? (0, memory_io_1.globalTomDir)() : (0, memory_io_1.projectTomDir)();
    const sessionsDir = path.join(tomDir, 'sessions');
    const files = listJsonFiles(sessionsDir);
    const timestamps = [];
    for (const file of files) {
        const sessionId = file.replace('.json', '');
        const session = (0, memory_io_1.readSessionLog)(sessionId, scope);
        if (session) {
            timestamps.push({
                sessionId: session.sessionId,
                startedAt: session.startedAt,
            });
        }
    }
    return timestamps;
}
function deleteSessionFile(sessionId, scope) {
    const tomDir = scope === 'global' ? (0, memory_io_1.globalTomDir)() : (0, memory_io_1.projectTomDir)();
    const sessionPath = path.join(tomDir, 'sessions', `${sessionId}.json`);
    try {
        fs.unlinkSync(sessionPath);
    }
    catch {
        // File may not exist — ignore
    }
}
function deleteSessionModelFile(sessionId, scope) {
    const tomDir = scope === 'global' ? (0, memory_io_1.globalTomDir)() : (0, memory_io_1.projectTomDir)();
    const modelPath = path.join(tomDir, 'session-models', `${sessionId}.json`);
    try {
        fs.unlinkSync(modelPath);
    }
    catch {
        // File may not exist — ignore
    }
}
function saveIndex(index, scope) {
    const tomDir = scope === 'global' ? (0, memory_io_1.globalTomDir)() : (0, memory_io_1.projectTomDir)();
    const indexPath = path.join(tomDir, 'bm25-index.json');
    const dir = path.dirname(indexPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(indexPath, JSON.stringify(index), 'utf-8');
}
// --- Main Pruning Function ---
/**
 * Prunes old Tier 1 sessions when count exceeds maxSessionsRetained.
 * Also deletes corresponding Tier 2 session models.
 * Rebuilds BM25 index after pruning.
 *
 * Returns list of pruned session IDs.
 */
function pruneOldSessions(maxSessionsRetained, scope = 'global') {
    const sessions = getSessionTimestamps(scope);
    const sessionsBeforePrune = sessions.length;
    if (sessions.length <= maxSessionsRetained) {
        return {
            prunedSessionIds: [],
            sessionsBeforePrune,
            sessionsAfterPrune: sessionsBeforePrune,
            indexRebuilt: false,
        };
    }
    // Sort by startedAt ascending (oldest first)
    const sorted = [...sessions].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const countToRemove = sorted.length - maxSessionsRetained;
    const toRemove = sorted.slice(0, countToRemove);
    const prunedIds = [];
    for (const session of toRemove) {
        deleteSessionFile(session.sessionId, scope);
        deleteSessionModelFile(session.sessionId, scope);
        prunedIds.push(session.sessionId);
    }
    // Rebuild BM25 index after pruning
    const index = (0, tools_1.buildMemoryIndex)(scope);
    saveIndex(index, scope);
    return {
        prunedSessionIds: prunedIds,
        sessionsBeforePrune,
        sessionsAfterPrune: sessionsBeforePrune - countToRemove,
        indexRebuilt: true,
    };
}
//# sourceMappingURL=pruning.js.map