/**
 * /tom reset skill — clears all ToM memory with a confirmation step.
 *
 * Deletes all files in ~/.claude/tom/ and .claude/tom/ (sessions,
 * session-models, user-model.json, usage.log, BM25 index) but
 * does NOT delete config from settings.json.
 *
 * Also removes tom-swe marker blocks from the CLAUDE.md promotion targets
 * (~/.claude/CLAUDE.md and the project CLAUDE.md): managed content must
 * not outlive the store it projects.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { globalTomDir, projectTomDir } from '../memory-io.js'
import {
  globalMemoryFilePath,
  findProjectMemoryFile,
  removePromotionBlock,
} from '../promotion.js'

// --- Types ---

export interface DeletedSummary {
  readonly fileCount: number
  readonly totalBytes: number
}

export interface ResetResult {
  readonly globalDeleted: DeletedSummary
  readonly projectDeleted: DeletedSummary
  readonly totalFileCount: number
  readonly totalBytes: number
  /** CLAUDE.md files whose tom-swe marker blocks were removed. */
  readonly markerBlocksRemoved: readonly string[]
}

// --- Helpers ---

function collectFiles(dirPath: string): readonly string[] {
  const results: string[] = []

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)
      if (entry.isDirectory()) {
        results.push(...collectFiles(fullPath))
      } else {
        results.push(fullPath)
      }
    }
  } catch {
    // Directory doesn't exist or unreadable
  }

  return results
}

function deleteDirectory(dirPath: string): DeletedSummary {
  const files = collectFiles(dirPath)
  let totalBytes = 0

  for (const filePath of files) {
    try {
      const stat = fs.statSync(filePath)
      totalBytes += stat.size
    } catch {
      // File may have been removed concurrently
    }
  }

  const fileCount = files.length

  try {
    fs.rmSync(dirPath, { recursive: true, force: true })
  } catch {
    // Directory may not exist
  }

  return { fileCount, totalBytes }
}

// --- Main ---

/**
 * Removes tom-swe marker blocks from both promotion targets (global
 * ~/.claude/CLAUDE.md and the project CLAUDE.md). Only the marker-bounded
 * section is removed; all other file content stays untouched.
 */
function removeMarkerBlocks(): readonly string[] {
  const candidates = new Set<string>([globalMemoryFilePath()])
  const projectFile = findProjectMemoryFile(process.cwd())
  if (projectFile !== null) {
    candidates.add(projectFile)
  }

  const removed: string[] = []
  for (const filePath of candidates) {
    if (removePromotionBlock(filePath)) {
      removed.push(filePath)
    }
  }
  return removed
}

export function performReset(): ResetResult {
  const globalDir = globalTomDir()
  const projectDir = projectTomDir()

  const globalDeleted = deleteDirectory(globalDir)
  const projectDeleted =
    globalDir === projectDir
      ? { fileCount: 0, totalBytes: 0 }
      : deleteDirectory(projectDir)

  const markerBlocksRemoved = removeMarkerBlocks()

  return {
    globalDeleted,
    projectDeleted,
    totalFileCount: globalDeleted.fileCount + projectDeleted.fileCount,
    totalBytes: globalDeleted.totalBytes + projectDeleted.totalBytes,
    markerBlocksRemoved,
  }
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function formatResetResult(result: ResetResult): string {
  const lines: string[] = []

  lines.push('# ToM Reset Complete')
  lines.push('')

  if (result.totalFileCount === 0 && result.markerBlocksRemoved.length === 0) {
    lines.push('No ToM data found to delete.')
    return lines.join('\n')
  }

  lines.push('## Deleted Data')
  lines.push(`- Total files deleted: ${result.totalFileCount}`)
  lines.push(`- Total size freed: ${formatBytes(result.totalBytes)}`)
  lines.push('')

  if (result.globalDeleted.fileCount > 0) {
    lines.push(
      `- Global (~/.claude/tom/): ${result.globalDeleted.fileCount} files (${formatBytes(result.globalDeleted.totalBytes)})`
    )
  }

  if (result.projectDeleted.fileCount > 0) {
    lines.push(
      `- Project (.claude/tom/): ${result.projectDeleted.fileCount} files (${formatBytes(result.projectDeleted.totalBytes)})`
    )
  }

  if (result.markerBlocksRemoved.length > 0) {
    lines.push('')
    lines.push('## Removed CLAUDE.md Marker Blocks')
    for (const filePath of result.markerBlocksRemoved) {
      lines.push(`- ${filePath}`)
    }
  }

  lines.push('')
  lines.push('Configuration in settings.json was preserved.')
  lines.push('ToM will begin learning again from your next session.')

  return lines.join('\n')
}

export function formatConfirmationPrompt(): string {
  const lines: string[] = []

  lines.push('# ToM Reset')
  lines.push('')
  lines.push('This will delete ALL ToM memory data:')
  lines.push('- All session logs (Tier 1)')
  lines.push('- All session models (Tier 2)')
  lines.push('- User model (Tier 3)')
  lines.push('- Usage log')
  lines.push('- BM25 search index')
  lines.push('- tom-swe marker blocks in CLAUDE.md promotion targets')
  lines.push('')
  lines.push('Configuration in settings.json will be preserved.')
  lines.push('')
  lines.push('Are you sure you want to proceed? (yes/no)')

  return lines.join('\n')
}

// --- CLI Entry Point ---

export function main(): void {
  const args = process.argv.slice(2)
  const confirmed = args.includes('--confirm')

  if (!confirmed) {
    process.stdout.write(formatConfirmationPrompt())
    return
  }

  const result = performReset()
  const output = formatResetResult(result)
  process.stdout.write(output)
}

if (require.main === module) {
  main()
}
