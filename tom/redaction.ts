import { sanitizeValue } from './secrets.js'

// --- Tool Input Redaction ---

/**
 * Redacts secret values from a tool input object.
 * Keeps parameter keys/shape but replaces values matching secret patterns with '[REDACTED]'.
 * Values longer than 200 chars (likely file contents) are also redacted.
 * Returns a new object — input is not mutated.
 */
export function redactToolInput(
  toolInput: Record<string, unknown>
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const key of Object.keys(toolInput)) {
    const value = toolInput[key]
    if (typeof value === 'string') {
      result[key] = sanitizeValue(value)
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      result[key] = String(value)
    } else if (value === null || value === undefined) {
      result[key] = 'null'
    } else {
      result[key] = typeof value
    }
  }
  return result
}

// --- User Message Redaction ---

/**
 * Redacts inline code blocks, fenced code blocks, and URLs with query parameters
 * from user message summaries. Returns a new string.
 */
export function redactUserMessage(message: string): string {
  // Strip fenced code blocks first (multiline)
  let result = message.replace(/```[\s\S]*?```/g, '[CODE_BLOCK]')

  // Strip inline code blocks
  result = result.replace(/`[^`]+`/g, '[CODE]')

  // Strip URLs with query parameters (keep URLs without query params)
  result = result.replace(/https?:\/\/[^\s]+\?[^\s]*/g, '[URL]')

  return result
}
