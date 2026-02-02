"use strict";
/**
 * Smart model routing configuration and usage logging.
 *
 * Provides configurable model selection for ToM operations
 * and centralized usage logging for cost tracking.
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
exports.getModelForOperation = getModelForOperation;
exports.logUsage = logUsage;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const os = __importStar(require("node:os"));
const memory_io_js_1 = require("./memory-io.js");
// --- Defaults ---
const DEFAULT_MODELS = {
    memoryUpdate: 'haiku',
    consultation: 'sonnet',
    profileInit: 'sonnet',
};
// Maps operation types to settings.json config keys
const OPERATION_CONFIG_KEY = {
    memoryUpdate: 'memoryUpdate',
    consultation: 'consultation',
    profileInit: 'consultation',
};
// --- Model Routing ---
/**
 * Returns the model name for the given operation type.
 * Reads from tom.models.{key} in ~/.claude/settings.json,
 * falling back to defaults if not configured.
 */
function getModelForOperation(operation) {
    const defaultModel = DEFAULT_MODELS[operation];
    const configKey = OPERATION_CONFIG_KEY[operation];
    try {
        const configPath = path.join(os.homedir(), '.claude', 'tom', 'config.json');
        const content = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(content);
        const models = config['models'];
        const configuredModel = models?.[configKey];
        if (typeof configuredModel === 'string' && configuredModel.length > 0) {
            return configuredModel;
        }
        return defaultModel;
    }
    catch {
        return defaultModel;
    }
}
// --- Usage Logging ---
/**
 * Appends a usage log entry as a JSON line to tom/usage.log.
 * Creates directories if they do not exist.
 */
function logUsage(entry) {
    const logPath = path.join((0, memory_io_js_1.globalTomDir)(), 'usage.log');
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(logPath, line, 'utf-8');
}
//# sourceMappingURL=routing.js.map