"use strict";
/**
 * /tom reset skill — clears all ToM memory with a confirmation step.
 *
 * Deletes all files in ~/.claude/tom/ and .claude/tom/ (sessions,
 * session-models, user-model.json, usage.log, BM25 index) but
 * does NOT delete config from settings.json.
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
exports.performReset = performReset;
exports.formatBytes = formatBytes;
exports.formatResetResult = formatResetResult;
exports.formatConfirmationPrompt = formatConfirmationPrompt;
exports.main = main;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const memory_io_js_1 = require("../memory-io.js");
// --- Helpers ---
function collectFiles(dirPath) {
    const results = [];
    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                results.push(...collectFiles(fullPath));
            }
            else {
                results.push(fullPath);
            }
        }
    }
    catch {
        // Directory doesn't exist or unreadable
    }
    return results;
}
function deleteDirectory(dirPath) {
    const files = collectFiles(dirPath);
    let totalBytes = 0;
    for (const filePath of files) {
        try {
            const stat = fs.statSync(filePath);
            totalBytes += stat.size;
        }
        catch {
            // File may have been removed concurrently
        }
    }
    const fileCount = files.length;
    try {
        fs.rmSync(dirPath, { recursive: true, force: true });
    }
    catch {
        // Directory may not exist
    }
    return { fileCount, totalBytes };
}
// --- Main ---
function performReset() {
    const globalDir = (0, memory_io_js_1.globalTomDir)();
    const projectDir = (0, memory_io_js_1.projectTomDir)();
    const globalDeleted = deleteDirectory(globalDir);
    const projectDeleted = globalDir === projectDir
        ? { fileCount: 0, totalBytes: 0 }
        : deleteDirectory(projectDir);
    return {
        globalDeleted,
        projectDeleted,
        totalFileCount: globalDeleted.fileCount + projectDeleted.fileCount,
        totalBytes: globalDeleted.totalBytes + projectDeleted.totalBytes,
    };
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
function formatResetResult(result) {
    const lines = [];
    lines.push('# ToM Reset Complete');
    lines.push('');
    if (result.totalFileCount === 0) {
        lines.push('No ToM data found to delete.');
        return lines.join('\n');
    }
    lines.push('## Deleted Data');
    lines.push(`- Total files deleted: ${result.totalFileCount}`);
    lines.push(`- Total size freed: ${formatBytes(result.totalBytes)}`);
    lines.push('');
    if (result.globalDeleted.fileCount > 0) {
        lines.push(`- Global (~/.claude/tom/): ${result.globalDeleted.fileCount} files (${formatBytes(result.globalDeleted.totalBytes)})`);
    }
    if (result.projectDeleted.fileCount > 0) {
        lines.push(`- Project (.claude/tom/): ${result.projectDeleted.fileCount} files (${formatBytes(result.projectDeleted.totalBytes)})`);
    }
    lines.push('');
    lines.push('Configuration in settings.json was preserved.');
    lines.push('ToM will begin learning again from your next session.');
    return lines.join('\n');
}
function formatConfirmationPrompt() {
    const lines = [];
    lines.push('# ToM Reset');
    lines.push('');
    lines.push('This will delete ALL ToM memory data:');
    lines.push('- All session logs (Tier 1)');
    lines.push('- All session models (Tier 2)');
    lines.push('- User model (Tier 3)');
    lines.push('- Usage log');
    lines.push('- BM25 search index');
    lines.push('');
    lines.push('Configuration in settings.json will be preserved.');
    lines.push('');
    lines.push('Are you sure you want to proceed? (yes/no)');
    return lines.join('\n');
}
// --- CLI Entry Point ---
function main() {
    const args = process.argv.slice(2);
    const confirmed = args.includes('--confirm');
    if (!confirmed) {
        process.stdout.write(formatConfirmationPrompt());
        return;
    }
    const result = performReset();
    const output = formatResetResult(result);
    process.stdout.write(output);
}
if (require.main === module) {
    main();
}
//# sourceMappingURL=tom-reset.js.map