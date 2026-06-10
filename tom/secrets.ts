/**
 * Single source of truth for secret detection and value sanitization.
 *
 * Used by redaction.ts (tool-input redaction) and the PostToolUse capture
 * hook so both apply the same pattern list.
 */

// --- Secret Detection Patterns ---

export const SECRET_PATTERNS: readonly RegExp[] = [
  /^sk-[a-zA-Z0-9_-]+$/,          // OpenAI-style keys
  /^ghp_[a-zA-Z0-9]+$/,           // GitHub personal tokens
  /^gho_[a-zA-Z0-9]+$/,           // GitHub OAuth tokens
  /^ghs_[a-zA-Z0-9]+$/,           // GitHub server tokens
  /^github_pat_[a-zA-Z0-9_]+$/,   // GitHub fine-grained PATs
  /^Bearer\s+.+/i,                // Bearer tokens
  /^Basic\s+.+/i,                 // Basic auth
  /^token\s+.+/i,                 // Generic token prefix
  /^xox[bposa]-[a-zA-Z0-9-]+$/,   // Slack tokens
  /^AKIA[A-Z0-9]{16}$/,           // AWS access keys
  /^eyJ[a-zA-Z0-9_-]+\.eyJ/,     // JWT tokens
  /password[=:].+/i,              // password= or password:
  /^[a-f0-9]{40}$/,               // 40-char hex (git hashes, some tokens)
  /^npm_[a-zA-Z0-9]+$/,           // npm tokens
  /^pypi-[a-zA-Z0-9]+$/,          // PyPI tokens
  /[A-Z_]+=sk-[a-zA-Z0-9_-]+/,   // ENV_VAR=secret patterns
  /[A-Z_]+_KEY=[^\s]+/i,          // API_KEY=value patterns
]

export const REDACTED = '[REDACTED]'
export const MAX_VALUE_LENGTH = 200

// --- Helpers ---

export function looksLikeSecret(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value.trim()))
}

/**
 * Replaces values matching a secret pattern, or longer than
 * MAX_VALUE_LENGTH (likely file contents), with '[REDACTED]'.
 */
export function sanitizeValue(value: string): string {
  if (looksLikeSecret(value)) {
    return REDACTED
  }
  if (value.length > MAX_VALUE_LENGTH) {
    return REDACTED
  }
  return value
}
