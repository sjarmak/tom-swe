"use strict";
/**
 * Registers ToM hooks (PostToolUse, PreToolUse, Stop) in ~/.claude/settings.json.
 *
 * Hooks are added alongside existing hooks (never overwriting).
 * All hooks check tom.enabled before executing.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerHooks = registerHooks;
exports.formatResult = formatResult;
exports.getExampleSnippet = getExampleSnippet;
exports.main = main;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const os = __importStar(require("node:os"));
// --- Hook Definitions ---
function getHooksDir() {
    return path.resolve(__dirname);
}
function buildTomHooks(hooksDir) {
    return {
        PostToolUse: [{
                type: 'command',
                command: `bash "${path.join(hooksDir, 'post-tool-use.sh')}"`,
            }],
        PreToolUse: [{
                type: 'command',
                command: `bash "${path.join(hooksDir, 'pre-tool-use.sh')}"`,
            }],
        Stop: [{
                type: 'command',
                command: `bash "${path.join(hooksDir, 'stop-analyze.sh')}"`,
            }],
    };
}
// --- Registration ---
function isMatchingHook(existing, tomHook) {
    return existing.command === tomHook.command;
}
function mergeHookArray(existing, tomHooks) {
    const current = existing ?? [];
    const toAdd = tomHooks.filter(tomHook => !current.some(entry => isMatchingHook(entry, tomHook)));
    return {
        hooks: [...current, ...toAdd],
        addedCount: toAdd.length,
    };
}
/**
 * Reads the current settings.json, adds ToM hook entries alongside
 * existing hooks, and writes it back. Does not overwrite existing hooks.
 *
 * Returns a summary of what was added vs already present.
 */
function registerHooks(settingsPath) {
    const resolvedPath = settingsPath ?? path.join(os.homedir(), '.claude', 'settings.json');
    const hooksDir = getHooksDir();
    const tomHooks = buildTomHooks(hooksDir);
    // Read existing settings or start fresh
    let settings = {};
    try {
        const content = fs.readFileSync(resolvedPath, 'utf-8');
        settings = JSON.parse(content);
    }
    catch {
        // File missing or invalid — start with empty object
    }
    // Get or create hooks section
    const existingHooks = (settings['hooks'] ?? {});
    const added = [];
    const alreadyPresent = [];
    const updatedHooks = {};
    for (const [key, value] of Object.entries(existingHooks)) {
        if (value !== undefined) {
            updatedHooks[key] = value;
        }
    }
    const hookTypes = ['PostToolUse', 'PreToolUse', 'Stop'];
    for (const hookType of hookTypes) {
        const tomHookArray = tomHooks[hookType] ?? [];
        const result = mergeHookArray(existingHooks[hookType], tomHookArray);
        updatedHooks[hookType] = result.hooks;
        if (result.addedCount > 0) {
            added.push(hookType);
        }
        else {
            alreadyPresent.push(hookType);
        }
    }
    // Write updated settings
    const updatedSettings = {
        ...settings,
        hooks: updatedHooks,
    };
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(resolvedPath, JSON.stringify(updatedSettings, null, 2) + '\n', 'utf-8');
    return { added, alreadyPresent, settingsPath: resolvedPath };
}
// --- Formatting ---
/**
 * Formats the registration result as human-readable output.
 */
function formatResult(result) {
    const lines = ['# ToM Hook Registration'];
    if (result.added.length > 0) {
        lines.push('');
        lines.push(`Registered ${result.added.length} hook(s):`);
        for (const hookType of result.added) {
            lines.push(`  - ${hookType}`);
        }
    }
    if (result.alreadyPresent.length > 0) {
        lines.push('');
        lines.push(`Already registered (${result.alreadyPresent.length}):`);
        for (const hookType of result.alreadyPresent) {
            lines.push(`  - ${hookType}`);
        }
    }
    lines.push('');
    lines.push(`Settings file: ${result.settingsPath}`);
    lines.push('');
    lines.push('All hooks check tom.enabled before executing.');
    lines.push('Enable with: "tom": { "enabled": true } in settings.json');
    return lines.join('\n');
}
// --- Example Settings Snippet ---
/**
 * Returns an example settings.json snippet showing the hook configuration.
 */
function getExampleSnippet(hooksDir) {
    const dir = hooksDir ?? getHooksDir();
    return JSON.stringify({
        tom: {
            enabled: true,
            consultThreshold: 'medium',
            models: {
                memoryUpdate: 'haiku',
                consultation: 'sonnet',
            },
        },
        hooks: {
            PostToolUse: [{
                    type: 'command',
                    command: `bash "${path.join(dir, 'post-tool-use.sh')}"`,
                }],
            PreToolUse: [{
                    type: 'command',
                    command: `bash "${path.join(dir, 'pre-tool-use.sh')}"`,
                }],
            Stop: [{
                    type: 'command',
                    command: `bash "${path.join(dir, 'stop-analyze.sh')}"`,
                }],
        },
    }, null, 2);
}
// --- CLI Entry Point ---
function main() {
    try {
        const result = registerHooks();
        process.stdout.write(formatResult(result) + '\n');
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Error registering hooks: ${message}\n`);
        process.exitCode = 1;
    }
}
if (require.main === module) {
    main();
}
//# sourceMappingURL=register-hooks.js.map