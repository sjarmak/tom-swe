"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// tom/hooks/capture-interaction.ts
var capture_interaction_exports = {};
__export(capture_interaction_exports, {
  captureInteraction: () => captureInteraction,
  extractParameterShape: () => extractParameterShape,
  main: () => main
});
module.exports = __toCommonJS(capture_interaction_exports);
var fs = __toESM(require("node:fs"));
var path = __toESM(require("node:path"));
var os = __toESM(require("node:os"));
var SECRET_PATTERNS = [
  /^sk-[a-zA-Z0-9_-]+$/,
  // OpenAI-style keys
  /^ghp_[a-zA-Z0-9]+$/,
  // GitHub personal tokens
  /^gho_[a-zA-Z0-9]+$/,
  // GitHub OAuth tokens
  /^ghs_[a-zA-Z0-9]+$/,
  // GitHub server tokens
  /^github_pat_[a-zA-Z0-9_]+$/,
  // GitHub fine-grained PATs
  /^Bearer\s+.+/i,
  // Bearer tokens
  /^Basic\s+.+/i,
  // Basic auth
  /^token\s+.+/i,
  // Generic token prefix
  /^xox[bposa]-[a-zA-Z0-9-]+$/,
  // Slack tokens
  /^AKIA[A-Z0-9]{16}$/,
  // AWS access keys
  /^eyJ[a-zA-Z0-9_-]+\.eyJ/,
  // JWT tokens
  /password[=:].+/i,
  // password= or password:
  /^[a-f0-9]{40}$/,
  // 40-char hex (git hashes, some tokens)
  /^npm_[a-zA-Z0-9]+$/,
  // npm tokens
  /^pypi-[a-zA-Z0-9]+$/
  // PyPI tokens
];
var REDACTED = "[REDACTED]";
var MAX_VALUE_LENGTH = 200;
function looksLikeSecret(value) {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value.trim()));
}
function sanitizeValue(value) {
  if (looksLikeSecret(value)) {
    return REDACTED;
  }
  if (value.length > MAX_VALUE_LENGTH) {
    return REDACTED;
  }
  return value;
}
function extractParameterShape(toolInput) {
  const shape = {};
  for (const key of Object.keys(toolInput)) {
    const value = toolInput[key];
    if (typeof value === "string") {
      shape[key] = sanitizeValue(value);
    } else if (typeof value === "number" || typeof value === "boolean") {
      shape[key] = String(value);
    } else if (value === null || value === void 0) {
      shape[key] = "null";
    } else {
      shape[key] = typeof value;
    }
  }
  return shape;
}
function buildInteractionEntry(toolName, toolInput, toolOutput) {
  let parsedInput = {};
  try {
    parsedInput = JSON.parse(toolInput);
  } catch {
    parsedInput = {};
  }
  const outcomeSummary = toolOutput.length > MAX_VALUE_LENGTH ? toolOutput.slice(0, MAX_VALUE_LENGTH) + "..." : toolOutput;
  return {
    toolName,
    parameterShape: extractParameterShape(parsedInput),
    outcomeSummary: sanitizeValue(outcomeSummary),
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function getSessionId() {
  return process.env["CLAUDE_SESSION_ID"] ?? `pid-${process.pid}`;
}
function getSessionFilePath(sessionId) {
  const tomDir = path.join(os.homedir(), ".claude", "tom", "sessions");
  return path.join(tomDir, `${sessionId}.json`);
}
function ensureDirectoryExists(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
function captureInteraction(toolName, toolInput, toolOutput) {
  const sessionId = getSessionId();
  const filePath = getSessionFilePath(sessionId);
  const entry = buildInteractionEntry(toolName, toolInput, toolOutput);
  ensureDirectoryExists(filePath);
  let sessionData;
  try {
    const existing = fs.readFileSync(filePath, "utf-8");
    sessionData = JSON.parse(existing);
  } catch {
    sessionData = {
      sessionId,
      startedAt: (/* @__PURE__ */ new Date()).toISOString(),
      endedAt: (/* @__PURE__ */ new Date()).toISOString(),
      interactions: []
    };
  }
  const updated = {
    ...sessionData,
    endedAt: (/* @__PURE__ */ new Date()).toISOString(),
    interactions: [...sessionData.interactions, entry]
  };
  fs.writeFile(filePath, JSON.stringify(updated, null, 2), "utf-8", () => {
  });
}
function isTomEnabled() {
  try {
    const configPath = path.join(os.homedir(), ".claude", "tom", "config.json");
    const content = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(content);
    return config["enabled"] === true;
  } catch {
    return false;
  }
}
function main() {
  if (!isTomEnabled()) {
    return;
  }
  const toolName = process.env["TOOL_NAME"] ?? "";
  const toolInput = process.env["TOOL_INPUT"] ?? "{}";
  const toolOutput = process.env["TOOL_OUTPUT"] ?? "";
  if (!toolName) {
    return;
  }
  captureInteraction(toolName, toolInput, toolOutput);
}
if (require.main === module) {
  main();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  captureInteraction,
  extractParameterShape,
  main
});
