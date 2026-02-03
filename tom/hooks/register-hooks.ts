/**
 * Registers ToM hooks (PostToolUse, PreToolUse, Stop) in ~/.claude/settings.json.
 *
 * Hooks are added alongside existing hooks (never overwriting).
 * All hooks check tom.enabled before executing.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

// --- Types ---

interface HookCommand {
  readonly type: string
  readonly command: string
  readonly async?: boolean
  readonly statusMessage?: string
}

interface HookGroup {
  readonly matcher: string
  readonly hooks: readonly HookCommand[]
}

interface HooksConfig {
  readonly PreToolUse?: readonly HookGroup[]
  readonly PostToolUse?: readonly HookGroup[]
  readonly Stop?: readonly HookGroup[]
}

interface RegistrationResult {
  readonly added: readonly string[]
  readonly alreadyPresent: readonly string[]
  readonly settingsPath: string
}

// --- Hook Definitions ---

function getDistHooksDir(): string {
  // From compiled dist/tom/hooks/, resolve to dist/tom/hooks/
  return path.resolve(__dirname)
}

function buildTomHooks(distHooksDir: string): HooksConfig {
  return {
    PostToolUse: [{
      matcher: '',
      hooks: [{
        type: 'command',
        command: `node "${path.join(distHooksDir, 'capture-interaction.js')}"`,
        async: true,
        statusMessage: 'ToM: capturing interaction',
      }],
    }],
    PreToolUse: [{
      matcher: '',
      hooks: [{
        type: 'command',
        command: `node "${path.join(distHooksDir, 'pre-tool-use.js')}"`,
        statusMessage: 'ToM: checking preferences',
      }],
    }],
    Stop: [{
      matcher: '',
      hooks: [{
        type: 'command',
        command: `node "${path.join(distHooksDir, 'stop-analyze.js')}"`,
        async: true,
        statusMessage: 'ToM: analyzing session',
      }],
    }],
  }
}

// --- Registration ---

function containsTomHook(groups: readonly HookGroup[], tomGroup: HookGroup): boolean {
  const tomCommand = tomGroup.hooks[0]?.command ?? ''
  return groups.some(group =>
    group.hooks.some(hook => hook.command === tomCommand)
  )
}

function mergeHookGroups(
  existing: readonly HookGroup[] | undefined,
  tomGroups: readonly HookGroup[]
): { readonly groups: readonly HookGroup[]; readonly addedCount: number } {
  const current: readonly HookGroup[] = existing ?? []
  const toAdd = tomGroups.filter(
    tomGroup => !containsTomHook(current, tomGroup)
  )

  return {
    groups: [...current, ...toAdd],
    addedCount: toAdd.length,
  }
}

/**
 * Reads the current settings.json, adds ToM hook entries alongside
 * existing hooks, and writes it back. Does not overwrite existing hooks.
 *
 * Returns a summary of what was added vs already present.
 */
export function registerHooks(settingsPath?: string): RegistrationResult {
  const resolvedPath = settingsPath ?? path.join(os.homedir(), '.claude', 'settings.json')
  const distHooksDir = getDistHooksDir()
  const tomHooks = buildTomHooks(distHooksDir)

  // Read existing settings or start fresh
  let settings: Record<string, unknown> = {}
  try {
    const content = fs.readFileSync(resolvedPath, 'utf-8')
    settings = JSON.parse(content) as Record<string, unknown>
  } catch {
    // File missing or invalid — start with empty object
  }

  // Get or create hooks section
  const existingHooks = (settings['hooks'] ?? {}) as Record<string, readonly HookGroup[] | undefined>

  const added: string[] = []
  const alreadyPresent: string[] = []
  const updatedHooks: Record<string, readonly HookGroup[]> = {}
  for (const [key, value] of Object.entries(existingHooks)) {
    if (value !== undefined) {
      updatedHooks[key] = value
    }
  }

  const hookTypes = ['PostToolUse', 'PreToolUse', 'Stop'] as const
  for (const hookType of hookTypes) {
    const tomHookGroups = tomHooks[hookType] ?? []
    const result = mergeHookGroups(
      existingHooks[hookType],
      tomHookGroups
    )
    updatedHooks[hookType] = result.groups

    if (result.addedCount > 0) {
      added.push(hookType)
    } else {
      alreadyPresent.push(hookType)
    }
  }

  // Write updated settings
  const updatedSettings = {
    ...settings,
    hooks: updatedHooks,
  }

  const dir = path.dirname(resolvedPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  fs.writeFileSync(resolvedPath, JSON.stringify(updatedSettings, null, 2) + '\n', 'utf-8')

  return { added, alreadyPresent, settingsPath: resolvedPath }
}

// --- Formatting ---

/**
 * Formats the registration result as human-readable output.
 */
export function formatResult(result: RegistrationResult): string {
  const lines: string[] = ['# ToM Hook Registration']

  if (result.added.length > 0) {
    lines.push('')
    lines.push(`Registered ${result.added.length} hook(s):`)
    for (const hookType of result.added) {
      lines.push(`  - ${hookType}`)
    }
  }

  if (result.alreadyPresent.length > 0) {
    lines.push('')
    lines.push(`Already registered (${result.alreadyPresent.length}):`)
    for (const hookType of result.alreadyPresent) {
      lines.push(`  - ${hookType}`)
    }
  }

  lines.push('')
  lines.push(`Settings file: ${result.settingsPath}`)
  lines.push('')
  lines.push('All hooks check tom.enabled before executing.')
  lines.push('Enable with: "tom": { "enabled": true } in settings.json')

  return lines.join('\n')
}

// --- Example Settings Snippet ---

/**
 * Returns an example settings.json snippet showing the hook configuration.
 */
export function getExampleSnippet(distHooksDir?: string): string {
  const dir = distHooksDir ?? getDistHooksDir()
  return JSON.stringify({
    tom: {
      enabled: true,
      consultThreshold: 'medium',
      models: {
        memoryUpdate: 'haiku',
        consultation: 'sonnet',
      },
    },
    hooks: buildTomHooks(dir),
  }, null, 2)
}

// --- CLI Entry Point ---

export function main(): void {
  try {
    const result = registerHooks()
    process.stdout.write(formatResult(result) + '\n')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Error registering hooks: ${message}\n`)
    process.exitCode = 1
  }
}

if (require.main === module) {
  main()
}
