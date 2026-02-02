import * as fs from 'fs'
import * as path from 'path'

const TOM_GITIGNORE_ENTRY = '.claude/tom/'

interface EnsureGitignoreResult {
  readonly action: 'added' | 'already_present' | 'no_gitignore'
  readonly gitignorePath: string
}

export function ensureGitignoreEntry(projectRoot: string): EnsureGitignoreResult {
  const gitignorePath = path.join(projectRoot, '.gitignore')

  if (!fs.existsSync(gitignorePath)) {
    return { action: 'no_gitignore', gitignorePath }
  }

  const content = fs.readFileSync(gitignorePath, 'utf-8')
  const lines = content.split('\n')

  const alreadyPresent = lines.some(
    (line) => line.trim() === TOM_GITIGNORE_ENTRY
  )

  if (alreadyPresent) {
    return { action: 'already_present', gitignorePath }
  }

  const endsWithNewline = content.endsWith('\n')
  const appendContent = endsWithNewline
    ? `${TOM_GITIGNORE_ENTRY}\n`
    : `\n${TOM_GITIGNORE_ENTRY}\n`

  fs.appendFileSync(gitignorePath, appendContent)

  return { action: 'added', gitignorePath }
}

export function formatResult(result: EnsureGitignoreResult): string {
  switch (result.action) {
    case 'added':
      return `Added '${TOM_GITIGNORE_ENTRY}' to ${result.gitignorePath}`
    case 'already_present':
      return `'${TOM_GITIGNORE_ENTRY}' already present in ${result.gitignorePath}`
    case 'no_gitignore':
      return 'No .gitignore file found in project root. Skipping.'
  }
}

function main(): void {
  const projectRoot = process.cwd()
  const result = ensureGitignoreEntry(projectRoot)
  process.stdout.write(formatResult(result) + '\n')
}

if (require.main === module) {
  main()
}
