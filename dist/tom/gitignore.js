"use strict";
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
exports.ensureGitignoreEntry = ensureGitignoreEntry;
exports.formatResult = formatResult;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const TOM_GITIGNORE_ENTRY = '.claude/tom/';
function ensureGitignoreEntry(projectRoot) {
    const gitignorePath = path.join(projectRoot, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
        return { action: 'no_gitignore', gitignorePath };
    }
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    const lines = content.split('\n');
    const alreadyPresent = lines.some((line) => line.trim() === TOM_GITIGNORE_ENTRY);
    if (alreadyPresent) {
        return { action: 'already_present', gitignorePath };
    }
    const endsWithNewline = content.endsWith('\n');
    const appendContent = endsWithNewline
        ? `${TOM_GITIGNORE_ENTRY}\n`
        : `\n${TOM_GITIGNORE_ENTRY}\n`;
    fs.appendFileSync(gitignorePath, appendContent);
    return { action: 'added', gitignorePath };
}
function formatResult(result) {
    switch (result.action) {
        case 'added':
            return `Added '${TOM_GITIGNORE_ENTRY}' to ${result.gitignorePath}`;
        case 'already_present':
            return `'${TOM_GITIGNORE_ENTRY}' already present in ${result.gitignorePath}`;
        case 'no_gitignore':
            return 'No .gitignore file found in project root. Skipping.';
    }
}
function main() {
    const projectRoot = process.cwd();
    const result = ensureGitignoreEntry(projectRoot);
    process.stdout.write(formatResult(result) + '\n');
}
if (require.main === module) {
    main();
}
//# sourceMappingURL=gitignore.js.map