"use strict";
/**
 * /tom status skill — displays the current state of the ToM model,
 * session count, preference summary, and configuration.
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
exports.getStatus = getStatus;
exports.formatStatus = formatStatus;
exports.main = main;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const memory_io_js_1 = require("../memory-io.js");
const config_js_1 = require("../config.js");
// --- Helpers ---
function countJsonFiles(dirPath) {
    try {
        const entries = fs.readdirSync(dirPath);
        return entries.filter((e) => e.endsWith('.json')).length;
    }
    catch {
        return 0;
    }
}
function getFileSize(filePath) {
    try {
        const stat = fs.statSync(filePath);
        return stat.size;
    }
    catch {
        return 0;
    }
}
function getStorageStats() {
    const globalSessions = path.join((0, memory_io_js_1.globalTomDir)(), 'sessions');
    const projectSessions = path.join((0, memory_io_js_1.projectTomDir)(), 'sessions');
    const globalModels = path.join((0, memory_io_js_1.globalTomDir)(), 'session-models');
    const projectModels = path.join((0, memory_io_js_1.projectTomDir)(), 'session-models');
    const globalUserModelFile = path.join((0, memory_io_js_1.globalTomDir)(), 'user-model.json');
    const projectUserModelFile = path.join((0, memory_io_js_1.projectTomDir)(), 'user-model.json');
    return {
        tier1SessionCount: countJsonFiles(globalSessions) + countJsonFiles(projectSessions),
        tier2ModelCount: countJsonFiles(globalModels) + countJsonFiles(projectModels),
        tier3SizeBytes: getFileSize(globalUserModelFile) + getFileSize(projectUserModelFile),
    };
}
function getTopPreferences(model, limit = 10) {
    const sorted = [...model.preferencesClusters].sort((a, b) => b.confidence - a.confidence);
    return sorted.slice(0, limit);
}
// --- Main ---
function getStatus() {
    const config = (0, config_js_1.readTomConfig)();
    const userModel = (0, memory_io_js_1.readUserModel)('merged');
    const storage = getStorageStats();
    if (userModel === null) {
        return {
            hasModel: false,
            config: {
                enabled: config.enabled,
                consultThreshold: config.consultThreshold,
                models: {
                    memoryUpdate: config.models.memoryUpdate,
                    consultation: config.models.consultation,
                },
                preferenceDecayDays: config.preferenceDecayDays,
                maxSessionsRetained: config.maxSessionsRetained,
            },
            storage,
            topPreferences: [],
            interactionStyleSummary: '',
            codingStyleSummary: '',
        };
    }
    return {
        hasModel: true,
        config: {
            enabled: config.enabled,
            consultThreshold: config.consultThreshold,
            models: {
                memoryUpdate: config.models.memoryUpdate,
                consultation: config.models.consultation,
            },
            preferenceDecayDays: config.preferenceDecayDays,
            maxSessionsRetained: config.maxSessionsRetained,
        },
        storage,
        topPreferences: getTopPreferences(userModel),
        interactionStyleSummary: userModel.interactionStyleSummary,
        codingStyleSummary: userModel.codingStyleSummary,
    };
}
function formatStatus(status) {
    const lines = [];
    lines.push('# ToM Status');
    lines.push('');
    // Configuration
    lines.push('## Configuration');
    lines.push(`- Enabled: ${status.config.enabled ? 'Yes' : 'No'}`);
    lines.push(`- Consult Threshold: ${status.config.consultThreshold}`);
    lines.push(`- Models: memoryUpdate=${status.config.models.memoryUpdate}, consultation=${status.config.models.consultation}`);
    lines.push(`- Preference Decay: ${status.config.preferenceDecayDays} days`);
    lines.push(`- Max Sessions Retained: ${status.config.maxSessionsRetained}`);
    lines.push('');
    // Storage
    lines.push('## Storage');
    lines.push(`- Tier 1 Sessions: ${status.storage.tier1SessionCount}`);
    lines.push(`- Tier 2 Models: ${status.storage.tier2ModelCount}`);
    lines.push(`- Tier 3 User Model: ${formatBytes(status.storage.tier3SizeBytes)}`);
    lines.push('');
    // User Model
    if (!status.hasModel) {
        lines.push('No user model found. ToM will begin learning after your first session.');
        return lines.join('\n');
    }
    lines.push('## Sessions Analyzed');
    lines.push(`- Total: ${status.storage.tier1SessionCount}`);
    lines.push('');
    // Top Preferences
    if (status.topPreferences.length > 0) {
        lines.push('## Top Preferences (by confidence)');
        for (const pref of status.topPreferences) {
            const confidence = (pref.confidence * 100).toFixed(0);
            lines.push(`- [${pref.category}] ${pref.key}: ${pref.value} (${confidence}% confidence, ${pref.sessionCount} sessions)`);
        }
        lines.push('');
    }
    // Summaries
    if (status.interactionStyleSummary) {
        lines.push('## Interaction Style');
        lines.push(status.interactionStyleSummary);
        lines.push('');
    }
    if (status.codingStyleSummary) {
        lines.push('## Coding Style');
        lines.push(status.codingStyleSummary);
        lines.push('');
    }
    return lines.join('\n');
}
function formatBytes(bytes) {
    if (bytes === 0)
        return '0 B';
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
// --- CLI Entry Point ---
function main() {
    const status = getStatus();
    const output = formatStatus(status);
    process.stdout.write(output);
}
if (require.main === module) {
    main();
}
//# sourceMappingURL=tom-status.js.map