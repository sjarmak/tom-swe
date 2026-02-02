"use strict";
/**
 * ToM configuration schema and opt-in system.
 *
 * Provides a Zod-validated configuration schema for the ToM system,
 * read from ~/.claude/tom/config.json.
 * All hooks use isTomEnabled() as a guard before executing.
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
exports.TomConfigSchema = void 0;
exports.readTomConfig = readTomConfig;
exports.isTomEnabled = isTomEnabled;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const os = __importStar(require("node:os"));
const zod_1 = require("zod");
// --- Configuration Schema ---
exports.TomConfigSchema = zod_1.z.strictObject({
    enabled: zod_1.z.boolean().default(false),
    consultThreshold: zod_1.z.enum(['low', 'medium', 'high']).default('medium'),
    models: zod_1.z.strictObject({
        memoryUpdate: zod_1.z.string().default('haiku'),
        consultation: zod_1.z.string().default('sonnet'),
    }).default({ memoryUpdate: 'haiku', consultation: 'sonnet' }),
    preferenceDecayDays: zod_1.z.number().default(30),
    maxSessionsRetained: zod_1.z.number().default(100),
});
// --- Reading Configuration ---
/**
 * Reads the "tom" key from ~/.claude/settings.json,
 * validates it against the Zod schema, and returns
 * a fully-defaulted TomConfig.
 *
 * Returns all defaults if the file is missing, unreadable,
 * or the tom key is absent/invalid.
 */
function readTomConfig() {
    try {
        const configPath = path.join(os.homedir(), '.claude', 'tom', 'config.json');
        const content = fs.readFileSync(configPath, 'utf-8');
        const raw = JSON.parse(content);
        const result = exports.TomConfigSchema.safeParse(raw);
        if (result.success) {
            return result.data;
        }
        // If validation fails, return defaults
        return exports.TomConfigSchema.parse({});
    }
    catch {
        return exports.TomConfigSchema.parse({});
    }
}
// --- Guard ---
/**
 * Returns true if ToM is enabled in settings.
 * Used as a guard in all hooks to skip execution when disabled.
 */
function isTomEnabled() {
    return readTomConfig().enabled;
}
//# sourceMappingURL=config.js.map