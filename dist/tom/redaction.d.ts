/**
 * Redacts secret values from a tool input object.
 * Keeps parameter keys/shape but replaces values matching secret patterns with '[REDACTED]'.
 * Values longer than 200 chars (likely file contents) are also redacted.
 * Returns a new object — input is not mutated.
 */
export declare function redactToolInput(toolInput: Record<string, unknown>): Record<string, string>;
/**
 * Redacts inline code blocks, fenced code blocks, and URLs with query parameters
 * from user message summaries. Returns a new string.
 */
export declare function redactUserMessage(message: string): string;
//# sourceMappingURL=redaction.d.ts.map