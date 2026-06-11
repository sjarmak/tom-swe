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
