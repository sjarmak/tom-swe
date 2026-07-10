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
  // Env-var-name prefixes are bounded to a realistic length ({1,64}); an
  // unbounded `[A-Z_]+` prefix is quadratic (unanchored greedy retry at every
  // position) and these run per whitespace-token in redactEmbeddedSecrets on
  // uncapped input (redactPrompt/truncateDetail), where a long paste would hang
  // the synchronous prompt hook.
  /[A-Z_]{1,64}=sk-[a-zA-Z0-9_-]+/,  // ENV_VAR=secret patterns
  /[A-Z_]{1,64}_KEY=[^\s]+/i,        // API_KEY=value patterns
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
  // AWS secret access keys: context-anchored, NOT a bare 40-char base64 token.
  // A lone 40-char base64 string is ambiguous (git hashes, resource IDs), so we
  // only redact when the literal `secret_access_key` label precedes the value.
  // The label + a 40+-char base64 run together carry near-zero false-positive
  // risk. Separators accepted: `=`, `:`, or whitespace (covers `key=val`,
  // `"key": "val"`, and the space-delimited CLI form `aws configure set … val`).
  // The `AWS_SECRET_ACCESS_KEY=…` env-assignment form is already caught upstream
  // by the `/[A-Z_]+_KEY=[^\s]+/i` whole-token pattern. Label and any opening
  // quote are preserved; only the value is redacted.
  {
    pattern:
      /((?:aws[_-]?)?secret[_-]?access[_-]?key["']?\s*[:=]?\s*["']?)[A-Za-z0-9/+]{40,}={0,2}/gi,
    replacement: `$1${REDACTED}`,
  },
  // ODBC/ADO connection-string passwords using the `Pwd=` abbreviation, which
  // the whole-token `/password[=:].+/i` pattern misses. Connection strings are
  // `;`-delimited (never split by the whitespace tokenizer below). A value may
  // be brace-quoted (`Pwd={p@ss;word}`) to embed a literal `;`, so the
  // brace-quoted form is matched as a whole `{...}` unit first; otherwise the
  // value runs to the next `;` or whitespace. The `\b` before `pwd` avoids
  // firing inside `OLDPWD`. Full `Password=`/`password=` forms are already
  // whole-value-redacted upstream and are intentionally left to that path. Key
  // is preserved; only the value is redacted.
  { pattern: /(\bpwd\s*=\s*)(?:\{[^}]*\}|[^;\s]+)/gi, replacement: `$1${REDACTED}` },
  // Email addresses (PII). The local-part class excludes `[` and `]`, so this
  // cannot re-match the `[REDACTED]@host` span the URL-credential pattern above
  // leaves behind — keeping this entry after that pattern is load-bearing for
  // connection-string host preservation. Requires a dotted TLD, so a bare
  // `user@localhost` is left intact. Quantifiers are bounded to RFC 5321 limits
  // (local ≤64, domain ≤255) so the pattern stays linear-time: `redactPrompt`
  // and `truncateDetail` call this on unbounded input that bypasses the
  // MAX_VALUE_LENGTH cap, and the synchronous prompt hook must not stall.
  //
  // Two dev-syntax false positives are excluded (tom-swe-nsn) without widening
  // the local-part class or unbounding a quantifier:
  //  - Retina/image assets (`logo@2x.png`): a leading negative lookahead drops
  //    known image extensions (png/jpg/jpeg/svg/webp/gif/ico) as the TLD — none
  //    is a real TLD, so this cannot suppress a genuine email.
  //  - scp-style git remotes (`git@github.com:org/repo.git`): `(?!:\S)` refuses
  //    to match when the TLD is immediately followed by `:` + non-whitespace
  //    (the `host:path` shape). A real email is a terminal token (space, end,
  //    or closing punctuation), so this only spares `email:nonspace`, which is
  //    not an email token shape. The port-in-URL case (`host:5432`) is already
  //    protected by the ordering invariant above, so this stays scoped to the
  //    bare remote. `(?![A-Za-z])` forces the TLD to be its full label so the
  //    engine cannot shrink the TLD (e.g. `com`→`co`) to slip past `(?!:\S)`.
  {
    pattern:
      /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.(?!(?:png|jpe?g|svg|webp|gif|ico)\b)[A-Za-z]{2,24}(?![A-Za-z])(?!:\S)/g,
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
