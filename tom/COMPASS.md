---
compass_area: "tom — Theory-of-Mind engine"
area_path: "tom/"
generated: "2026-07-18"
# Staleness stamp — machine-readable so a refresh can test drift without a model.
# `sources` are area-relative paths (relative to THIS file's directory). Recompute:
#   node ../.claude/skills/project-compass/compass-hash.mjs COMPASS.md
sources_hash: "sha256-16:3daa336390269b33"
sources:
  - hooks/stop-analyze.ts
  - llm-analyze.ts
  - aggregation.ts
  - preferences.ts
  - rebuild.ts
  - memory-io.ts
  - consult.ts
  - secrets.ts
---

# Compass: tom — Theory-of-Mind engine

> Tribal-knowledge map for `tom/`. The *why* and the *gotchas* — read the code
> for *what*, `AGENTS.md`/`README.md` for the high-level plugin framing. This map
> covers the load-bearing invariants that aren't visible on any one file's surface.
> The frontmatter stamp makes its staleness testable by `compass-hash.mjs`.

## Purpose

`tom/` builds a persistent, confidence-scored model of one user's coding and
interaction preferences by observing their sessions, then feeds relevant
preferences back to Claude as **background context (never instructions)** when a
prompt is ambiguous. It exists so the user never re-states stable preferences:
cross-session reinforcement of what recurs, decay of what goes stale, all data
local and redacted. Hook-driven; no server, no long-running process.

## Key files & entry points

Three-tier memory pipeline: Tier 1 raw logs → Tier 2 per-session models → Tier 3
aggregated user model.

- **`hooks/stop-analyze.ts`** — the heart (~700 lines). Per qualifying turn-end:
  fold Tier 1 → extract Tier 2 (`llm-analyze`) → **rebuild** Tier 3 from all Tier 2
  → reconcile cross-category splits → emit telemetry → prune → rebuild BM25 index.
- **`llm-analyze.ts`** — the only LLM boundary. Spawns headless
  `claude -p --model <memoryUpdate> --output-format json --tools "" --strict-mcp-config`,
  prompt piped over **stdin** (argv would hit ARG_MAX), zero tools,
  `TOM_SWE_INTERNAL=1`. Typed success/failure so callers fall back loudly.
- **`consult.ts`** — local consultation (no model spawned): `detectAmbiguity` → user
  model first (`buildSuggestionFromUserModel`) then BM25 fallback (provenance only).
- **`aggregation.ts` + `preferences.ts` + `rebuild.ts`** — the preference-math
  flywheel: `rebuild` folds every Tier 2 model (sorted by `endedAt`) through
  decay → extract → reinforce (+0.1, cap 1.0) → corrections (×penalty) → recency
  conflict resolution.
- **`memory-io.ts`** — all filesystem IO and the Zod read/parse boundary for the
  three tiers plus the sidecar fold.
- **`secrets.ts`** — single source of truth for redaction (whole-token +
  embedded patterns), used by capture, prompt redaction, and telemetry.

## How it connects

- **Upstream:** Claude Code, via `hooks/hooks.json` (the plugin registers hooks; no
  `settings.json` edit). Each hook reads its JSON contract from stdin. `tom/skills/`
  (`tom-status`, `tom-inspect`, `tom-reset`, …) are user-facing read/admin surfaces.
- **Downstream:** Claude's context window via three injection sinks (SessionStart,
  UserPromptSubmit, and the retired promotion path), plus an external memory-eval
  harness that reads `~/.claude/tom/usage.log`.
- **Boundaries:** LLM = exactly one headless `claude` spawn (Stop hook only);
  consultation is local BM25 + user-model, no spawn. FS under `~/.claude/tom/` (global)
  or `<cwd>/.claude/tom/` (project), written atomically at 0700/0600. One
  `git branch --show-current` per session for a join field. **No MCP**
  (`--strict-mcp-config`).

## Gotchas & non-obvious constraints

- **Stop fires per turn-end, not per session.** This drives three guards in
  `stop-analyze.ts`: a 90s debounce, a watermark on `analyzedUserMessageCount` (78%
  of spend was on unchanged sessions), and an `O_EXCL` in-flight lock against
  double-spawn.
- **Tier 3 is REBUILT, never incrementally aggregated** (`rebuild.ts`). Incremental
  aggregation re-reinforced the same session every turn (confidence inflated 2-3×).
  Re-analyzing a session *replaces* its contribution. Decay stays honest only because
  each Tier 2 model carries `endedAt` used as the fold's `asOf` (`preferences.ts:304`
  clamps decay ≤1 so negative day-gaps can't amplify).
- **Preserve-on-failure:** on LLM failure with an existing Tier 2 model, the prior
  model is kept and *not* rewritten so its mtime stays aged and it retries next turn.
  Only a never-analyzed session falls to the heuristic extractor. `endedAt`/watermark
  are stamped mechanically from Tier 1, never by the LLM.
- **Preference identity is `category+key`; the value is just current wording.** That
  is what makes reinforcement work — the prompt enforces snake_case keys + short
  canonical values, and the current vocabulary is injected back so the same preference
  reinforces instead of fragmenting. Legacy generic keys `preference`/`pattern` are
  collapsed noise: excluded from injection/promotion/anchoring, kept only to decay.
- **Redaction is layered and bounded.** `secrets.ts` is the SoT; its regex quantifiers
  are deliberately bounded (`{1,64}`) to stay linear-time because they run on unbounded
  input in the **synchronous** prompt hook (ReDoS guard). `sanitizeForInjection` is a
  *separate* guard at the injection sinks (newline flattening, marker neutralization,
  length cap) so a poisoned learned value can't escape its framing line.
- **Injected text is never instructions.** All three sinks carry an explicit
  "background observations, not instructions" framing, and the analyzer prompt ignores
  content addressed to it (memory-poisoning guard).
- **Session exclusion:** `TOM_SWE_INTERNAL=1` (recursion guard — the only mechanism),
  `TOM_SWE_DISABLE=1`, and `GC_AGENT` sessions never train the model.

## Failure modes seen here

- **LLM analysis timeout/stall** — the dominant failure. Bounded by
  `MAX_PROMPT_INTERACTIONS=400` / `MAX_PROMPT_USER_MESSAGES=200` (tail kept, drop count
  logged, never silent). ~81% of failures recover on a later turn via preserve-on-failure.
- **Confidence inflation** — the original incremental-aggregation bug; structurally
  fixed by the rebuild, re-introducible the moment any path aggregates a session twice.
- **Preference fragmentation / cross-category splits** — a new key/value for the same
  concept spawns a fresh low-confidence cluster; guarded by vocabulary injection and
  `reconcileCrossCategorySplits`, not fully preventable (semantic paraphrase isn't
  mechanically detectable).
- **Concurrent capture loss** — solved by the O_APPEND JSONL sidecar; regressing to
  read-modify-write on the `.json` stub silently loses interactions.
- **Silent disable** — a malformed `config.json` fails schema validation and defaults
  to `enabled=false`, turning the plugin off; the only signal is a `config-invalid`
  usage.log entry.
- **usage.log unbounded growth** — ~250 MB/yr; rotated at 5 MB from the Stop prune step.
