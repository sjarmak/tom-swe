/**
 * Single source of truth for secret detection and value sanitization.
 *
 * Used by redaction.ts (tool-input redaction) and the PostToolUse capture
 * hook so both apply the same pattern list.
 */

export const REDACTED = '[REDACTED]'
export const MAX_VALUE_LENGTH = 200

// --- Secret Detection Patterns ---

/**
 * Whole-token patterns: matched against a full (trimmed) value or a single
 * whitespace-delimited token. Most are ^-anchored, so they only catch a
 * secret that IS the token — embedded secrets are handled by
 * EMBEDDED_SECRET_PATTERNS below.
 */
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

/**
 * Unanchored patterns for secrets embedded inside longer strings (commands,
 * header values, connection strings). Each entry replaces only the matched
 * secret and preserves the surrounding text; all are global so every
 * occurrence in a value is redacted.
 */
interface EmbeddedSecretPattern {
  readonly pattern: RegExp
  readonly replacement: string
}

const EMBEDDED_SECRET_PATTERNS: readonly EmbeddedSecretPattern[] = [
  // Authorization header values anywhere in a command. Bearer is
  // case-insensitive (mirrors the anchored pattern); Basic is case-sensitive
  // with a length floor so prose like "basic authentication" is not swallowed.
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: REDACTED },
  { pattern: /\bBasic\s+[A-Za-z0-9+/=]{16,}/g, replacement: REDACTED },
  // AWS access key IDs anywhere, e.g. inside `AWS_ACCESS_KEY_ID=AKIA...`.
  { pattern: /\bAKIA[A-Z0-9]{16}\b/g, replacement: REDACTED },
  // JWTs anywhere: header.payload[.signature].
  {
    pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g,
    replacement: REDACTED,
  },
  // URL connection-string credentials (scheme://user:pass@host): redact the
  // credential pair, keep scheme and host readable.
  { pattern: /(\/\/)[^\s/:@]+:[^\s@]+@/g, replacement: `$1${REDACTED}@` },
  // PEM private-key blocks (RSA/EC/OPENSSH/PKCS8), including the JSON-escaped
  // form embedded in service-account keys (\n between armor and body). Matched
  // as a whole block so the base64 body never survives; the armor is specific
  // enough to carry zero false-positive risk.
  {
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: REDACTED,
  },
]

// --- Helpers ---

export function looksLikeSecret(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value.trim()))
}

/**
 * Redacts secrets embedded inside a longer string. Applies the unanchored
 * EMBEDDED_SECRET_PATTERNS as substring replacements, then tokenizes on
 * whitespace and redacts any token matching a whole-token secret pattern
 * (the same tokenization redactPrompt uses on the prompt path). Returns a
 * new string; surrounding text and whitespace are preserved.
 */
export function redactEmbeddedSecrets(value: string): string {
  let result = value
  for (const { pattern, replacement } of EMBEDDED_SECRET_PATTERNS) {
    result = result.replace(pattern, replacement)
  }
  return result
    .split(/(\s+)/)
    .map((token) => (token.trim() !== '' && looksLikeSecret(token) ? REDACTED : token))
    .join('')
}

/**
 * Replaces whole-value secrets, and values longer than MAX_VALUE_LENGTH
 * (likely file contents), with '[REDACTED]'. Secrets embedded mid-value
 * (e.g. `curl -H 'Authorization: Bearer ...'`) are redacted in place,
 * preserving the surrounding text.
 */
export function sanitizeValue(value: string): string {
  if (looksLikeSecret(value)) {
    return REDACTED
  }
  if (value.length > MAX_VALUE_LENGTH) {
    return REDACTED
  }
  return redactEmbeddedSecrets(value)
}
