"use strict";
// --- Secret Detection Patterns ---
Object.defineProperty(exports, "__esModule", { value: true });
exports.redactToolInput = redactToolInput;
exports.redactUserMessage = redactUserMessage;
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
    /^npm_[a-zA-Z0-9]+$/, // npm tokens
    /^pypi-[a-zA-Z0-9]+$/, // PyPI tokens
    /[A-Z_]+=sk-[a-zA-Z0-9_-]+/, // ENV_VAR=secret patterns
    /[A-Z_]+_KEY=[^\s]+/i, // API_KEY=value patterns
];
const REDACTED = '[REDACTED]';
const MAX_VALUE_LENGTH = 200;
// --- Tool Input Redaction ---
function looksLikeSecret(value) {
    return SECRET_PATTERNS.some((pattern) => pattern.test(value.trim()));
}
function redactValue(value) {
    if (looksLikeSecret(value)) {
        return REDACTED;
    }
    if (value.length > MAX_VALUE_LENGTH) {
        return REDACTED;
    }
    return value;
}
/**
 * Redacts secret values from a tool input object.
 * Keeps parameter keys/shape but replaces values matching secret patterns with '[REDACTED]'.
 * Values longer than 200 chars (likely file contents) are also redacted.
 * Returns a new object — input is not mutated.
 */
function redactToolInput(toolInput) {
    const result = {};
    for (const key of Object.keys(toolInput)) {
        const value = toolInput[key];
        if (typeof value === 'string') {
            result[key] = redactValue(value);
        }
        else if (typeof value === 'number' || typeof value === 'boolean') {
            result[key] = String(value);
        }
        else if (value === null || value === undefined) {
            result[key] = 'null';
        }
        else {
            result[key] = typeof value;
        }
    }
    return result;
}
// --- User Message Redaction ---
/**
 * Redacts inline code blocks, fenced code blocks, and URLs with query parameters
 * from user message summaries. Returns a new string.
 */
function redactUserMessage(message) {
    // Strip fenced code blocks first (multiline)
    let result = message.replace(/```[\s\S]*?```/g, '[CODE_BLOCK]');
    // Strip inline code blocks
    result = result.replace(/`[^`]+`/g, '[CODE]');
    // Strip URLs with query parameters (keep URLs without query params)
    result = result.replace(/https?:\/\/[^\s]+\?[^\s]*/g, '[URL]');
    return result;
}
//# sourceMappingURL=redaction.js.map