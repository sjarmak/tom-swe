"use strict";
/**
 * ToM sub-agent configuration.
 *
 * Defines the agent metadata, model settings, and tool declarations
 * used when spawning the ToM agent from hooks.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MEMORY_OPERATION_TOOLS = void 0;
exports.getAgentConfig = getAgentConfig;
exports.isMemoryOperationAllowed = isMemoryOperationAllowed;
function getAgentConfig() {
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
    };
}
/**
 * Tools that count toward the memory operation limit.
 */
exports.MEMORY_OPERATION_TOOLS = new Set([
    'search_memory',
    'read_memory_file',
    'analyze_session',
]);
/**
 * Checks whether an additional memory operation is allowed given the current count.
 */
function isMemoryOperationAllowed(currentCount, maxOperations = 3) {
    return currentCount < maxOperations;
}
//# sourceMappingURL=config.js.map