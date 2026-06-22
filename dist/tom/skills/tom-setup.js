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

// tom/skills/tom-setup.ts
var tom_setup_exports = {};
__export(tom_setup_exports, {
  formatSetupResult: () => formatSetupResult,
  main: () => main,
  setup: () => setup
});
module.exports = __toCommonJS(tom_setup_exports);
var fs2 = __toESM(require("node:fs"));
var path2 = __toESM(require("node:path"));
var os = __toESM(require("node:os"));

// tom/fs-atomic.ts
var fs = __toESM(require("node:fs"));
var path = __toESM(require("node:path"));
var crypto = __toESM(require("node:crypto"));
var tempCounter = 0;
function tempPathFor(filePath) {
  const suffix = `${process.pid}.${tempCounter++}.${crypto.randomBytes(4).toString("hex")}`;
  return `${filePath}.${suffix}.tmp`;
}
function ensureDirectoryExists(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
function atomicWriteFileSync(filePath, data) {
  ensureDirectoryExists(filePath);
  const tempPath = tempPathFor(filePath);
  try {
    fs.writeFileSync(tempPath, data, "utf-8");
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
    }
    throw error;
  }
}

// tom/skills/tom-setup.ts
var DEFAULT_CONFIG = {
  enabled: true,
  consultThreshold: "medium",
  models: {
    memoryUpdate: "haiku",
    consultation: "sonnet"
  },
  preferenceDecayDays: 30,
  maxSessionsRetained: 100
};
function getConfigPath() {
  return path2.join(os.homedir(), ".claude", "tom", "config.json");
}
function setup() {
  const configPath = getConfigPath();
  if (fs2.existsSync(configPath)) {
    return {
      created: false,
      alreadyExists: true,
      configPath
    };
  }
  try {
    atomicWriteFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return {
      created: true,
      alreadyExists: false,
      configPath
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      created: false,
      alreadyExists: false,
      configPath,
      error: message
    };
  }
}
function formatSetupResult(result) {
  const lines = [];
  lines.push("# ToM Setup");
  lines.push("");
  if (result.alreadyExists) {
    lines.push(`Config already exists at \`${result.configPath}\`.`);
    lines.push("");
    lines.push("ToM is already configured. Use `/tom-status` to see current state.");
    return lines.join("\n");
  }
  if (result.error) {
    lines.push(`Failed to create config: ${result.error}`);
    return lines.join("\n");
  }
  if (result.created) {
    lines.push(`Created config at \`${result.configPath}\`.`);
    lines.push("");
    lines.push("ToM is now **enabled** with default settings:");
    lines.push(`- Consult threshold: ${DEFAULT_CONFIG.consultThreshold}`);
    lines.push(`- Memory update model: ${DEFAULT_CONFIG.models.memoryUpdate}`);
    lines.push(`- Consultation model: ${DEFAULT_CONFIG.models.consultation}`);
    lines.push(`- Preference decay: ${DEFAULT_CONFIG.preferenceDecayDays} days`);
    lines.push(`- Max sessions retained: ${DEFAULT_CONFIG.maxSessionsRetained}`);
    lines.push("");
    lines.push("Hooks are registered automatically by the plugin (hooks/hooks.json).");
    lines.push("ToM will begin learning your preferences in your next session.");
  }
  return lines.join("\n");
}
function main() {
  const result = setup();
  const output = formatSetupResult(result);
  process.stdout.write(output);
}
if (require.main === module) {
  main();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  formatSetupResult,
  main,
  setup
});
