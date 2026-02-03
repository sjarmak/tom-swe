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
  main: () => main2,
  setup: () => setup
});
module.exports = __toCommonJS(tom_setup_exports);
var fs2 = __toESM(require("node:fs"));
var path2 = __toESM(require("node:path"));
var os2 = __toESM(require("node:os"));

// tom/hooks/register-hooks.ts
var fs = __toESM(require("node:fs"));
var path = __toESM(require("node:path"));
var os = __toESM(require("node:os"));
function getDistHooksDir() {
  return path.resolve(__dirname);
}
function buildTomHooks(distHooksDir) {
  return {
    PostToolUse: [{
      matcher: "",
      hooks: [{
        type: "command",
        command: `node "${path.join(distHooksDir, "capture-interaction.js")}"`,
        async: true,
        statusMessage: "ToM: capturing interaction"
      }]
    }],
    PreToolUse: [{
      matcher: "",
      hooks: [{
        type: "command",
        command: `node "${path.join(distHooksDir, "pre-tool-use.js")}"`,
        statusMessage: "ToM: checking preferences"
      }]
    }],
    Stop: [{
      matcher: "",
      hooks: [{
        type: "command",
        command: `node "${path.join(distHooksDir, "stop-analyze.js")}"`,
        async: true,
        statusMessage: "ToM: analyzing session"
      }]
    }]
  };
}
function containsTomHook(groups, tomGroup) {
  const tomCommand = tomGroup.hooks[0]?.command ?? "";
  return groups.some(
    (group) => group.hooks.some((hook) => hook.command === tomCommand)
  );
}
function mergeHookGroups(existing, tomGroups) {
  const current = existing ?? [];
  const toAdd = tomGroups.filter(
    (tomGroup) => !containsTomHook(current, tomGroup)
  );
  return {
    groups: [...current, ...toAdd],
    addedCount: toAdd.length
  };
}
function registerHooks(settingsPath) {
  const resolvedPath = settingsPath ?? path.join(os.homedir(), ".claude", "settings.json");
  const distHooksDir = getDistHooksDir();
  const tomHooks = buildTomHooks(distHooksDir);
  let settings = {};
  try {
    const content = fs.readFileSync(resolvedPath, "utf-8");
    settings = JSON.parse(content);
  } catch {
  }
  const existingHooks = settings["hooks"] ?? {};
  const added = [];
  const alreadyPresent = [];
  const updatedHooks = {};
  for (const [key, value] of Object.entries(existingHooks)) {
    if (value !== void 0) {
      updatedHooks[key] = value;
    }
  }
  const hookTypes = ["PostToolUse", "PreToolUse", "Stop"];
  for (const hookType of hookTypes) {
    const tomHookGroups = tomHooks[hookType] ?? [];
    const result = mergeHookGroups(
      existingHooks[hookType],
      tomHookGroups
    );
    updatedHooks[hookType] = result.groups;
    if (result.addedCount > 0) {
      added.push(hookType);
    } else {
      alreadyPresent.push(hookType);
    }
  }
  const updatedSettings = {
    ...settings,
    hooks: updatedHooks
  };
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(resolvedPath, JSON.stringify(updatedSettings, null, 2) + "\n", "utf-8");
  return { added, alreadyPresent, settingsPath: resolvedPath };
}
function formatResult(result) {
  const lines = ["# ToM Hook Registration"];
  if (result.added.length > 0) {
    lines.push("");
    lines.push(`Registered ${result.added.length} hook(s):`);
    for (const hookType of result.added) {
      lines.push(`  - ${hookType}`);
    }
  }
  if (result.alreadyPresent.length > 0) {
    lines.push("");
    lines.push(`Already registered (${result.alreadyPresent.length}):`);
    for (const hookType of result.alreadyPresent) {
      lines.push(`  - ${hookType}`);
    }
  }
  lines.push("");
  lines.push(`Settings file: ${result.settingsPath}`);
  lines.push("");
  lines.push("All hooks check tom.enabled before executing.");
  lines.push('Enable with: "tom": { "enabled": true } in settings.json');
  return lines.join("\n");
}
function main() {
  try {
    const result = registerHooks();
    process.stdout.write(formatResult(result) + "\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error registering hooks: ${message}
`);
    process.exitCode = 1;
  }
}
if (require.main === module) {
  main();
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
function getTomDir() {
  return path2.join(os2.homedir(), ".claude", "tom");
}
function getConfigPath() {
  return path2.join(getTomDir(), "config.json");
}
function setup() {
  const configPath = getConfigPath();
  if (fs2.existsSync(configPath)) {
    const hookResult = registerHooks();
    return {
      created: false,
      alreadyExists: true,
      configPath,
      hooksRegistered: hookResult.added,
      hooksAlreadyPresent: hookResult.alreadyPresent
    };
  }
  try {
    const dir = path2.dirname(configPath);
    if (!fs2.existsSync(dir)) {
      fs2.mkdirSync(dir, { recursive: true });
    }
    fs2.writeFileSync(
      configPath,
      JSON.stringify(DEFAULT_CONFIG, null, 2),
      "utf-8"
    );
    const hookResult = registerHooks();
    return {
      created: true,
      alreadyExists: false,
      configPath,
      hooksRegistered: hookResult.added,
      hooksAlreadyPresent: hookResult.alreadyPresent
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
    if (result.hooksRegistered && result.hooksRegistered.length > 0) {
      lines.push(`Registered missing hooks: ${result.hooksRegistered.join(", ")}`);
      lines.push("");
    }
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
    if (result.hooksRegistered && result.hooksRegistered.length > 0) {
      lines.push(`Registered hooks: ${result.hooksRegistered.join(", ")}`);
    }
    lines.push("");
    lines.push("ToM will begin learning your preferences in your next session.");
  }
  return lines.join("\n");
}
function main2() {
  const result = setup();
  const output = formatSetupResult(result);
  process.stdout.write(output);
}
if (require.main === module) {
  main2();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  formatSetupResult,
  main,
  setup
});
