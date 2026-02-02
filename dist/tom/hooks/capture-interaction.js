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
exports.extractParameterShape = extractParameterShape;
exports.captureInteraction = captureInteraction;
exports.main = main;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const os = __importStar(require("node:os"));
// --- Secret Patterns ---
const SECRET_PATTERNS = [
    /^sk-[a-zA-Z0-9_-]+$/, // OpenAI-style keys
    /^ghp_[a-zA-Z0-9]+$/, // GitHub personal tokens
    /^gho_[a-zA-Z0-9]+$/, // GitHub OAuth tokens
    /^ghs_[a-zA-Z0-9]+$/, // GitHub server tokens
    /^github_pat_[a-zA-Z0-9_]+$/, // GitHub fine-grained PATs
    /^Bearer\s+.+/i, // Bearer tokens
    /^Basic\s+.+/i, // Basic auth
    /^token\s+.+/i, // Generic token prefix
    /^xox[bposa]-[a-zA-Z0-9-]+$/, // Slack tokens
    /^AKIA[A-Z0-9]{16}$/, // AWS access keys
    /^eyJ[a-zA-Z0-9_-]+\.eyJ/, // JWT tokens
    /password[=:].+/i, // password= or password:
    /^[a-f0-9]{40}$/, // 40-char hex (git hashes, some tokens)
    /^npm_[a-zA-Z0-9]+$/, // npm tokens
    /^pypi-[a-zA-Z0-9]+$/, // PyPI tokens
];
const REDACTED = '[REDACTED]';
const MAX_VALUE_LENGTH = 200;
// --- Sanitization ---
function looksLikeSecret(value) {
    return SECRET_PATTERNS.some((pattern) => pattern.test(value.trim()));
}
function sanitizeValue(value) {
    if (looksLikeSecret(value)) {
        return REDACTED;
    }
    if (value.length > MAX_VALUE_LENGTH) {
        return REDACTED;
    }
    return value;
}
function extractParameterShape(toolInput) {
    const shape = {};
    for (const key of Object.keys(toolInput)) {
        const value = toolInput[key];
        if (typeof value === 'string') {
            shape[key] = sanitizeValue(value);
        }
        else if (typeof value === 'number' || typeof value === 'boolean') {
            shape[key] = String(value);
        }
        else if (value === null || value === undefined) {
            shape[key] = 'null';
        }
        else {
            shape[key] = typeof value;
        }
    }
    return shape;
}
function buildInteractionEntry(toolName, toolInput, toolOutput) {
    let parsedInput = {};
    try {
        parsedInput = JSON.parse(toolInput);
    }
    catch {
        parsedInput = {};
    }
    const outcomeSummary = toolOutput.length > MAX_VALUE_LENGTH
        ? toolOutput.slice(0, MAX_VALUE_LENGTH) + '...'
        : toolOutput;
    return {
        toolName,
        parameterShape: extractParameterShape(parsedInput),
        outcomeSummary: sanitizeValue(outcomeSummary),
        timestamp: new Date().toISOString(),
    };
}
// --- Session File Management ---
function getSessionId() {
    return process.env['CLAUDE_SESSION_ID'] ?? `pid-${process.pid}`;
}
function getSessionFilePath(sessionId) {
    const tomDir = path.join(os.homedir(), '.claude', 'tom', 'sessions');
    return path.join(tomDir, `${sessionId}.json`);
}
function ensureDirectoryExists(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}
// --- Main Capture Function ---
function captureInteraction(toolName, toolInput, toolOutput) {
    const sessionId = getSessionId();
    const filePath = getSessionFilePath(sessionId);
    const entry = buildInteractionEntry(toolName, toolInput, toolOutput);
    ensureDirectoryExists(filePath);
    // Read existing session log or create new one
    let sessionData;
    try {
        const existing = fs.readFileSync(filePath, 'utf-8');
        sessionData = JSON.parse(existing);
    }
    catch {
        sessionData = {
            sessionId,
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
            interactions: [],
        };
    }
    // Append interaction (async-safe: write full file with new entry)
    const updated = {
        ...sessionData,
        endedAt: new Date().toISOString(),
        interactions: [...sessionData.interactions, entry],
    };
    // Use async write for speed — fire and forget
    fs.writeFile(filePath, JSON.stringify(updated, null, 2), 'utf-8', () => {
        // no-op callback — fire and forget
    });
}
// --- CLI Entry Point ---
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
function main() {
    if (!isTomEnabled()) {
        return;
    }
    const toolName = process.env['TOOL_NAME'] ?? '';
    const toolInput = process.env['TOOL_INPUT'] ?? '{}';
    const toolOutput = process.env['TOOL_OUTPUT'] ?? '';
    if (!toolName) {
        return;
    }
    captureInteraction(toolName, toolInput, toolOutput);
}
// Run if executed directly
if (require.main === module) {
    main();
}
//# sourceMappingURL=capture-interaction.js.map