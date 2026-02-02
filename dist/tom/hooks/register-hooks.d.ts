/**
 * Registers ToM hooks (PostToolUse, PreToolUse, Stop) in ~/.claude/settings.json.
 *
 * Hooks are added alongside existing hooks (never overwriting).
 * All hooks check tom.enabled before executing.
 */
interface RegistrationResult {
    readonly added: readonly string[];
    readonly alreadyPresent: readonly string[];
    readonly settingsPath: string;
}
/**
 * Reads the current settings.json, adds ToM hook entries alongside
 * existing hooks, and writes it back. Does not overwrite existing hooks.
 *
 * Returns a summary of what was added vs already present.
 */
export declare function registerHooks(settingsPath?: string): RegistrationResult;
/**
 * Formats the registration result as human-readable output.
 */
export declare function formatResult(result: RegistrationResult): string;
/**
 * Returns an example settings.json snippet showing the hook configuration.
 */
export declare function getExampleSnippet(hooksDir?: string): string;
export declare function main(): void;
export {};
//# sourceMappingURL=register-hooks.d.ts.map