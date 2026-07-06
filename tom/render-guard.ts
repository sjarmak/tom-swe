/**
 * Render-boundary sanitization for LLM-learned strings.
 *
 * Preference keys/values (and style summaries) are extracted by a model
 * from attacker-influenceable session content, then interpolated into the
 * two injection sinks: CLAUDE.md marker blocks (persistent instruction
 * space) and hook additionalContext. Every guard upstream is prompt-level;
 * this is the structural one. Sanitizing at render time — instead of
 * tightening the stored schemas — keeps existing on-disk models parsing.
 *
 * Neutralized:
 * - newlines/control chars: an embedded newline would escape the
 *   "not instructions" framing as an independent bullet line
 * - HTML comment sequences: a value containing the literal tom-swe end
 *   marker would break marker-block integrity, stranding content OUTSIDE
 *   the managed block where it survives /tom-reset
 * - unbounded length: values are ~6 words by prompt discipline; a hard cap
 *   bounds what a poisoned value can inject
 */

export const MAX_INJECTED_VALUE_LENGTH = 200

export function sanitizeForInjection(text: string): string {
  const flattened = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/<!--/g, '(!--')
    .replace(/-->/g, '--)')
    .trim()
  return flattened.length > MAX_INJECTED_VALUE_LENGTH
    ? `${flattened.slice(0, MAX_INJECTED_VALUE_LENGTH)}…`
    : flattened
}
