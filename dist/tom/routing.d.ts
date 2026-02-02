/**
 * Smart model routing configuration and usage logging.
 *
 * Provides configurable model selection for ToM operations
 * and centralized usage logging for cost tracking.
 */
export type OperationType = 'memoryUpdate' | 'consultation' | 'profileInit';
interface UsageLogEntry {
    readonly timestamp: string;
    readonly operation: string;
    readonly model: string;
    readonly tokenCount: number;
}
/**
 * Returns the model name for the given operation type.
 * Reads from tom.models.{key} in ~/.claude/settings.json,
 * falling back to defaults if not configured.
 */
export declare function getModelForOperation(operation: OperationType): string;
/**
 * Appends a usage log entry as a JSON line to tom/usage.log.
 * Creates directories if they do not exist.
 */
export declare function logUsage(entry: UsageLogEntry): void;
export {};
//# sourceMappingURL=routing.d.ts.map