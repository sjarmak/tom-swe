"use strict";
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
exports.readSessionLog = readSessionLog;
exports.writeSessionLog = writeSessionLog;
exports.readSessionModel = readSessionModel;
exports.writeSessionModel = writeSessionModel;
exports.readUserModel = readUserModel;
exports.writeUserModel = writeUserModel;
exports.globalTomDir = globalTomDir;
exports.projectTomDir = projectTomDir;
exports.globalSessionPath = globalSessionPath;
exports.projectSessionPath = projectSessionPath;
exports.globalSessionModelPath = globalSessionModelPath;
exports.projectSessionModelPath = projectSessionModelPath;
exports.globalUserModelPath = globalUserModelPath;
exports.projectUserModelPath = projectUserModelPath;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const os = __importStar(require("node:os"));
const schemas_1 = require("./schemas");
// --- Path Helpers ---
function globalTomDir() {
    return path.join(os.homedir(), '.claude', 'tom');
}
function projectTomDir() {
    return path.join(process.cwd(), '.claude', 'tom');
}
function globalSessionPath(sessionId) {
    return path.join(globalTomDir(), 'sessions', `${sessionId}.json`);
}
function projectSessionPath(sessionId) {
    return path.join(projectTomDir(), 'sessions', `${sessionId}.json`);
}
function globalSessionModelPath(sessionId) {
    return path.join(globalTomDir(), 'session-models', `${sessionId}.json`);
}
function projectSessionModelPath(sessionId) {
    return path.join(projectTomDir(), 'session-models', `${sessionId}.json`);
}
function globalUserModelPath() {
    return path.join(globalTomDir(), 'user-model.json');
}
function projectUserModelPath() {
    return path.join(projectTomDir(), 'user-model.json');
}
// --- Internal Utilities ---
function ensureDirectoryExists(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}
function readJsonFile(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(content);
    }
    catch {
        return null;
    }
}
function writeJsonFile(filePath, data) {
    ensureDirectoryExists(filePath);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}
// --- Session Log (Tier 1) ---
function readSessionLog(sessionId, scope = 'global') {
    const filePath = scope === 'global'
        ? globalSessionPath(sessionId)
        : projectSessionPath(sessionId);
    const raw = readJsonFile(filePath);
    if (raw === null)
        return null;
    const result = schemas_1.SessionLogSchema.safeParse(raw);
    return result.success ? result.data : null;
}
function writeSessionLog(sessionLog, scope = 'global') {
    const validated = schemas_1.SessionLogSchema.parse(sessionLog);
    const filePath = scope === 'global'
        ? globalSessionPath(validated.sessionId)
        : projectSessionPath(validated.sessionId);
    writeJsonFile(filePath, validated);
}
// --- Session Model (Tier 2) ---
function readSessionModel(sessionId, scope = 'global') {
    const filePath = scope === 'global'
        ? globalSessionModelPath(sessionId)
        : projectSessionModelPath(sessionId);
    const raw = readJsonFile(filePath);
    if (raw === null)
        return null;
    const result = schemas_1.SessionModelSchema.safeParse(raw);
    return result.success ? result.data : null;
}
function writeSessionModel(sessionModel, scope = 'global') {
    const validated = schemas_1.SessionModelSchema.parse(sessionModel);
    const filePath = scope === 'global'
        ? globalSessionModelPath(validated.sessionId)
        : projectSessionModelPath(validated.sessionId);
    writeJsonFile(filePath, validated);
}
// --- User Model (Tier 3) ---
function mergePreferences(globalPrefs, projectPrefs) {
    const merged = new Map();
    for (const pref of globalPrefs) {
        merged.set(`${pref.category}::${pref.key}`, pref);
    }
    for (const pref of projectPrefs) {
        merged.set(`${pref.category}::${pref.key}`, pref);
    }
    return Array.from(merged.values());
}
function readUserModel(scope = 'merged') {
    if (scope === 'global' || scope === 'merged') {
        const globalRaw = readJsonFile(globalUserModelPath());
        const globalResult = globalRaw !== null ? schemas_1.UserModelSchema.safeParse(globalRaw) : null;
        const globalModel = globalResult?.success ? globalResult.data : null;
        if (scope === 'global')
            return globalModel;
        const projectRaw = readJsonFile(projectUserModelPath());
        const projectResult = projectRaw !== null ? schemas_1.UserModelSchema.safeParse(projectRaw) : null;
        const projectModel = projectResult?.success ? projectResult.data : null;
        if (globalModel === null)
            return projectModel;
        if (projectModel === null)
            return globalModel;
        return {
            preferencesClusters: mergePreferences(globalModel.preferencesClusters, projectModel.preferencesClusters),
            interactionStyleSummary: projectModel.interactionStyleSummary || globalModel.interactionStyleSummary,
            codingStyleSummary: projectModel.codingStyleSummary || globalModel.codingStyleSummary,
            projectOverrides: {
                ...globalModel.projectOverrides,
                ...projectModel.projectOverrides,
            },
        };
    }
    const projectRaw = readJsonFile(projectUserModelPath());
    if (projectRaw === null)
        return null;
    const result = schemas_1.UserModelSchema.safeParse(projectRaw);
    return result.success ? result.data : null;
}
function writeUserModel(userModel, scope = 'global') {
    const validated = schemas_1.UserModelSchema.parse(userModel);
    const filePath = scope === 'global' ? globalUserModelPath() : projectUserModelPath();
    writeJsonFile(filePath, validated);
}
//# sourceMappingURL=memory-io.js.map