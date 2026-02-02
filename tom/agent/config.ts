/**
 * ToM sub-agent configuration.
 *
 * Defines the agent metadata, model settings, and tool declarations
 * used when spawning the ToM agent from hooks.
 */

export interface TomAgentConfig {
  readonly name: string
  readonly description: string
  readonly model: string
  readonly temperature: number
  readonly maxMemoryOperations: number
  readonly tools: readonly string[]
  readonly systemPromptPath: string
}

export function getAgentConfig(): TomAgentConfig {
  return {
    name: 'tom-agent',
    description: 'Theory of Mind sub-agent that reasons about user mental states, preferences, and interaction patterns',
    model: 'haiku',
    temperature: 0.1,
    maxMemoryOperations: 3,
    tools: [
      'search_memory',
      'read_memory_file',
      'analyze_session',
      'initialize_user_profile',
      'give_suggestions',
    ],
    systemPromptPath: 'tom/agent/tom-agent.md',
  }
}

/**
 * Tools that count toward the memory operation limit.
 */
export const MEMORY_OPERATION_TOOLS: ReadonlySet<string> = new Set([
  'search_memory',
  'read_memory_file',
  'analyze_session',
])

/**
 * Checks whether an additional memory operation is allowed given the current count.
 */
export function isMemoryOperationAllowed(
  currentCount: number,
  maxOperations: number = 3
): boolean {
  return currentCount < maxOperations
}
