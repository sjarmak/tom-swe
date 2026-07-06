/**
 * /tom-setup skill — creates ~/.claude/tom/config.json with default
 * configuration if it doesn't already exist.
 *
 * Hook registration is handled entirely by the plugin's hooks/hooks.json
 * (via ${CLAUDE_PLUGIN_ROOT}); setup only creates the config file.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import { atomicWriteFileSync, TOM_DIR_MODE, TOM_FILE_MODE } from '../fs-atomic.js'

// --- Types ---

interface SetupResult {
  readonly created: boolean
  readonly alreadyExists: boolean
  readonly configPath: string
  readonly error?: string
}

// --- Default Config ---

const DEFAULT_CONFIG = {
  enabled: true,
  consultThreshold: 'medium',
  models: {
    memoryUpdate: 'haiku',
    consultation: 'sonnet',
  },
  preferenceDecayDays: 30,
  maxSessionsRetained: 100,
}

// --- Permission Hardening ---

/**
 * Recursively chmods an existing ~/.claude/tom tree to owner-only modes
 * (dirs 0o700, files 0o600). Releases before v0.5.4 created the tree with
 * the default umask (world-readable); setup repairs that once. Symlinks are
 * skipped so the pass cannot chmod targets outside the tree. A missing path
 * is a no-op; any other failure propagates to the caller.
 */
export function hardenTreePermissions(rootPath: string): void {
  let stats: fs.Stats
  try {
    stats = fs.lstatSync(rootPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw error
  }
  if (stats.isSymbolicLink()) {
    return
  }
  if (stats.isDirectory()) {
    fs.chmodSync(rootPath, TOM_DIR_MODE)
    for (const entry of fs.readdirSync(rootPath)) {
      hardenTreePermissions(path.join(rootPath, entry))
    }
    return
  }
  fs.chmodSync(rootPath, TOM_FILE_MODE)
}

// --- Setup ---

function getConfigPath(): string {
  return path.join(os.homedir(), '.claude', 'tom', 'config.json')
}

export function setup(): SetupResult {
  const configPath = getConfigPath()

  try {
    hardenTreePermissions(path.dirname(configPath))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      created: false,
      alreadyExists: fs.existsSync(configPath),
      configPath,
      error: `permission hardening failed: ${message}`,
    }
  }

  if (fs.existsSync(configPath)) {
    return {
      created: false,
      alreadyExists: true,
      configPath,
    }
  }

  try {
    atomicWriteFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2))

    return {
      created: true,
      alreadyExists: false,
      configPath,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      created: false,
      alreadyExists: false,
      configPath,
      error: message,
    }
  }
}

// --- Output Formatting ---

export function formatSetupResult(result: SetupResult): string {
  const lines: string[] = []

  lines.push('# ToM Setup')
  lines.push('')

  if (result.error) {
    lines.push(`Failed to create config: ${result.error}`)
    return lines.join('\n')
  }

  if (result.alreadyExists) {
    lines.push(`Config already exists at \`${result.configPath}\`.`)
    lines.push('')
    lines.push('ToM is already configured. Use `/tom-status` to see current state.')
    return lines.join('\n')
  }

  if (result.created) {
    lines.push(`Created config at \`${result.configPath}\`.`)
    lines.push('')
    lines.push('ToM is now **enabled** with default settings:')
    lines.push(`- Consult threshold: ${DEFAULT_CONFIG.consultThreshold}`)
    lines.push(`- Memory update model: ${DEFAULT_CONFIG.models.memoryUpdate}`)
    lines.push(`- Consultation model: ${DEFAULT_CONFIG.models.consultation}`)
    lines.push(`- Preference decay: ${DEFAULT_CONFIG.preferenceDecayDays} days`)
    lines.push(`- Max sessions retained: ${DEFAULT_CONFIG.maxSessionsRetained}`)
    lines.push('')
    lines.push('Hooks are registered automatically by the plugin (hooks/hooks.json).')
    lines.push('ToM will begin learning your preferences in your next session.')
  }

  return lines.join('\n')
}

// --- CLI Entry Point ---

export function main(): void {
  const result = setup()
  const output = formatSetupResult(result)
  process.stdout.write(output)
}

if (require.main === module) {
  main()
}
