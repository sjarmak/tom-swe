/**
 * /tom-setup skill — creates ~/.claude/tom/config.json with default
 * configuration if it doesn't already exist.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { registerHooks, formatResult as formatHookResult } from '../hooks/register-hooks'

// --- Types ---

interface SetupResult {
  readonly created: boolean
  readonly alreadyExists: boolean
  readonly configPath: string
  readonly hooksRegistered?: readonly string[]
  readonly hooksAlreadyPresent?: readonly string[]
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

// --- Setup ---

function getTomDir(): string {
  return path.join(os.homedir(), '.claude', 'tom')
}

function getConfigPath(): string {
  return path.join(getTomDir(), 'config.json')
}

export function setup(): SetupResult {
  const configPath = getConfigPath()

  if (fs.existsSync(configPath)) {
    // Always ensure hooks are registered, even if config already exists
    const hookResult = registerHooks()

    return {
      created: false,
      alreadyExists: true,
      configPath,
      hooksRegistered: hookResult.added,
      hooksAlreadyPresent: hookResult.alreadyPresent,
    }
  }

  try {
    const dir = path.dirname(configPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    fs.writeFileSync(
      configPath,
      JSON.stringify(DEFAULT_CONFIG, null, 2),
      'utf-8'
    )

    // Register hooks in settings.json
    const hookResult = registerHooks()

    return {
      created: true,
      alreadyExists: false,
      configPath,
      hooksRegistered: hookResult.added,
      hooksAlreadyPresent: hookResult.alreadyPresent,
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

  if (result.alreadyExists) {
    lines.push(`Config already exists at \`${result.configPath}\`.`)
    lines.push('')
    if (result.hooksRegistered && result.hooksRegistered.length > 0) {
      lines.push(`Registered missing hooks: ${result.hooksRegistered.join(', ')}`)
      lines.push('')
    }
    lines.push('ToM is already configured. Use `/tom-status` to see current state.')
    return lines.join('\n')
  }

  if (result.error) {
    lines.push(`Failed to create config: ${result.error}`)
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
    if (result.hooksRegistered && result.hooksRegistered.length > 0) {
      lines.push(`Registered hooks: ${result.hooksRegistered.join(', ')}`)
    }
    lines.push('')
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
