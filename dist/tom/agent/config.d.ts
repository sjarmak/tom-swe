/**
 * ToM sub-agent configuration.
 *
 * Defines the agent metadata, model settings, and tool declarations
 * used when spawning the ToM agent from hooks.
 */
export interface TomAgentConfig {
    readonly name: string;
    readonly description: string;
    readonly model: string;
    readonly temperature: number;
    readonly maxMemoryOperations: number;
    readonly tools: readonly string[];
    readonly systemPromptPath: string;
}
export declare function getAgentConfig(): TomAgentConfig;
/**
 * Tools that count toward the memory operation limit.
 */
export declare const MEMORY_OPERATION_TOOLS: ReadonlySet<string>;
/**
 * Checks whether an additional memory operation is allowed given the current count.
 */
export declare function isMemoryOperationAllowed(currentCount: number, maxOperations?: number): boolean;
//# sourceMappingURL=config.d.ts.map