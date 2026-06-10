/**
 * Reads and validates the Claude Code hook stdin JSON contract.
 *
 * Claude Code invokes each hook command as a fresh process and writes a JSON
 * payload to stdin (session_id, hook_event_name, tool_name, tool_input, ...).
 * The schema is deliberately permissive (loose object) because Claude Code
 * may add fields between releases.
 */

import { z } from 'zod'

export const HookInputSchema = z.looseObject({
  session_id: z.string().optional(),
  hook_event_name: z.string().optional(),
  tool_name: z.string().optional(),
  tool_input: z.unknown().optional(),
  tool_response: z.unknown().optional(),
  stop_hook_active: z.boolean().optional(),
  source: z.string().optional(),
})

export type HookInput = z.infer<typeof HookInputSchema>

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : chunk)
  }
  return Buffer.concat(chunks).toString('utf-8')
}

/**
 * Reads the full hook payload from stdin (or an injected stream for tests).
 * Returns null on empty, malformed, or schema-invalid input.
 */
export async function readHookInput(
  stream: NodeJS.ReadableStream = process.stdin
): Promise<HookInput | null> {
  let raw: string
  try {
    raw = await readAll(stream)
  } catch {
    return null
  }

  if (raw.trim() === '') {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  const result = HookInputSchema.safeParse(parsed)
  return result.success ? result.data : null
}

/**
 * Session identity precedence: payload session_id, then CLAUDE_SESSION_ID,
 * then a pid-based last resort (each hook invocation is a fresh process,
 * so the pid fallback fragments sessions and must stay last).
 */
export function getSessionId(input: HookInput | null): string {
  return input?.session_id ?? process.env['CLAUDE_SESSION_ID'] ?? `pid-${process.pid}`
}

/**
 * Guard for headless claude invocations spawned by ToM itself
 * (TOM_SWE_INTERNAL=1): hooks must be silent no-ops to avoid recursion.
 */
export function isInternalInvocation(): boolean {
  return process.env['TOM_SWE_INTERNAL'] === '1'
}

/**
 * Narrows an unknown tool_input payload to a plain record, defaulting to {}.
 */
export function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}
