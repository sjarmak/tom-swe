# tom-swe

Theory-of-Mind plugin for Claude Code: 3-tier JSON memory under `~/.claude/tom/`, BM25 retrieval, hooks bundled by esbuild into `dist/` and registered via `hooks/hooks.json`.

## Commands

- `npm run typecheck` — tsc strict, `noUncheckedIndexedAccess` (use `?? default` on record access)
- `npm test` — vitest; tests are colocated `*.test.ts` using `fs.mkdtempSync` temp dirs + `HOME` overrides
- `npm run build` — esbuild bundles each hook/skill entry point self-contained; `dist/` is checked in because `hooks.json` invokes it directly — rebuild after changing any hook source

## Conventions

- Immutable patterns throughout: pure functions return new objects (see `tom/preferences.ts`)
- Zod v4 `strictObject` schemas in `tom/schemas.ts`; hook stdin payloads use a permissive `looseObject` (`tom/hooks/hook-input.ts`)
- All hooks exit early on `TOM_SWE_INTERNAL=1` (recursion/machinery guard) and read config from `~/.claude/tom/config.json` via `tom/config.ts`
- Telemetry: one JSON line per operation via `logUsage` in `tom/routing.ts` (versioned schema; operation vocabulary documented in README)
- LLM calls happen only in the Stop hook (`tom/llm-analyze.ts`, headless `claude -p` with logged heuristic fallback); consultation and SessionStart injection are fully local
- No silent failures: fallbacks and errors get typed `usage.log` entries

Design history and decision rationale live in git history (`progress.txt`/`prd.json` before June 2026) — the repo was built by an autonomous PRD loop in Feb 2026 and substantially remediated in June 2026.


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:7510c1e2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
