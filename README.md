# ToM-SWE

Theory of Mind agent for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — learns your coding preferences, interaction style, and project patterns across sessions.

Based on the paper [ToM-SWE: User Mental Modeling for Software Engineering Agents](https://arxiv.org/abs/2505.15842).

## What it does

ToM-SWE observes how you use Claude Code and builds a model of your preferences over time. When it detects ambiguity in a tool call (e.g., which file format to use, which coding style to apply), it consults your preference history and provides context to Claude so it can act in line with what you prefer — without you needing to repeat yourself.

### Three-tier memory system

| Tier | What | Where |
|------|------|-------|
| **Tier 1** | Raw session logs (tool calls, parameters, outcomes, redacted prompt text) | `~/.claude/tom/sessions/` |
| **Tier 2** | Session models (intent, patterns, coding preferences, corrections) | `~/.claude/tom/session-models/` |
| **Tier 3** | Aggregated user model (confidence-scored preference clusters) | `~/.claude/tom/user-model.json` |

### Four hooks drive the system

- **SessionStart** — injects a compact summary of your learned user model (confident preferences plus interaction/coding style) as additional context at the start of each session
- **PostToolUse** — captures interaction metadata after each tool call (async, non-blocking)
- **UserPromptSubmit** — runs on every prompt you submit; stores a redacted copy of the prompt in the Tier 1 session log (so session analysis sees your real instructions) and runs ambiguity detection on the prompt text. Above the configured threshold it injects relevant preference context via `hookSpecificOutput.additionalContext`, framed as background observation — never as instructions, and never blocking the prompt. Consultation is local (BM25 search over stored memory plus the user model) — no model is spawned (sync)
- **Stop** — analyzes the completed session with a headless `claude` invocation using the configured `memoryUpdate` model; on any LLM failure it preserves the session's existing Tier 2 model when one exists (a transient failure, dominated by uncorrelated timeouts, must not downgrade a good model) and otherwise falls back to a heuristic extractor, logging the fallback with its reason to `~/.claude/tom/usage.log`. Because Stop fires on every turn-end (not once per session), re-analysis is debounced (90s) and the user model is **rebuilt from all session models** rather than aggregated incrementally — re-analyzing a session replaces its contribution instead of inflating it, with decay grounded in each session's `endedAt`. The analyzer receives the existing preference vocabulary so the same preference reinforces under the same key/value across sessions (async). Re-analysis is additionally gated on new evidence: a session model carries a watermark of the user messages it has seen, and tool-only turns skip the spawn entirely. Retention is split by tier: Tier 1 raw logs are pruned past `maxSessionsRetained` (ordered by last activity, never touching a session active in the last 2h), while Tier 2 session models — the rebuild's actual evidence — live for the full `preferenceDecayDays` window keyed on `endedAt`, so the memory horizon equals the decay design instead of collapsing to the raw-log window

Hooks are registered by the plugin's `hooks/hooks.json` — installation requires no changes to `~/.claude/settings.json`.

## Installation

### From marketplace (inside Claude Code)

First, add the marketplace source:

```
/plugin marketplace add sjarmak/tom-swe
```

Then install the plugin:

```
/plugin install tom-swe@tom-swe
```

### From local clone

```bash
git clone https://github.com/sjarmak/tom-swe.git
```

Then inside Claude Code:

```
/plugin marketplace add ./tom-swe
/plugin install tom-swe@tom-swe
```

### Setup

After installation, run the setup skill to create the config:

```
/tom-swe:tom-setup
```

This creates `~/.claude/tom/config.json` with ToM enabled and default settings. The system starts learning immediately in your next session.

You can also create the config manually:

```bash
mkdir -p ~/.claude/tom
echo '{"enabled": true}' > ~/.claude/tom/config.json
```

## Configuration

Edit `~/.claude/tom/config.json`:

```json
{
  "enabled": true,
  "consultThreshold": "medium",
  "models": {
    "memoryUpdate": "haiku",
    "consultation": "sonnet"
  },
  "preferenceDecayDays": 30,
  "maxSessionsRetained": 100,
  "correctionPenalty": 0.5,
  "promotion": {
    "enabled": true,
    "threshold": 0.8,
    "minSessions": 5
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `false` | Master switch for all ToM hooks |
| `consultThreshold` | `"medium"` | Ambiguity sensitivity: `"low"` (consults often), `"medium"`, `"high"` (consults rarely) |
| `models.memoryUpdate` | `"haiku"` | Model used by the Stop hook for headless session analysis |
| `models.consultation` | `"sonnet"` | Reserved for future use — preference consultation currently runs locally without spawning a model |
| `preferenceDecayDays` | `30` | Days before low-confidence preferences expire |
| `maxSessionsRetained` | `100` | Maximum session logs kept on disk |
| `correctionPenalty` | `0.5` | Confidence multiplier (0-1) applied to a stored preference when a session correction contradicts it — corrections cut confidence faster than repetition builds it |
| `promotion.enabled` | `true` | Promote stable high-confidence preferences into CLAUDE.md marker blocks and retire them from per-session injection |
| `promotion.threshold` | `0.8` | Minimum confidence for a preference to be promoted |
| `promotion.minSessions` | `5` | Minimum sessions a preference must be observed across before promotion |

Promoted preferences are written into a marker-bounded block (`<!-- tom-swe:begin ... -->` / `<!-- tom-swe:end -->`) that is regenerated wholesale after each session — the ToM store stays the source of truth. Coding preferences go to the project's `CLAUDE.md` (only if it already exists; tom-swe never creates files in your repos), while interaction-style preferences go to `~/.claude/CLAUDE.md`. A preference whose confidence later decays below the threshold drops out of the block automatically and returns to per-session injection. `/tom-reset` removes the marker blocks along with the store.

Crossing the thresholds is necessary but not sufficient. CLAUDE.md is a ~200-line budgeted file whose value is mostly what an agent could NOT infer from the repository, so promotion applies four further gates:

- **Category**: only `codingPreferences` and `interactionStyle` promote. Emotional signals are runtime state for ToM's own behavior, never standing guidance.
- **Derivability** (project targets): new observation-derived candidates pass a headless model judgment — "is this already visible from the repo's configs, deps, and docs?" — and statically derivable facts are dropped (logged as `promotion-skipped`). Correction-derived preferences bypass this gate: a correction is prima facie evidence the static information wasn't enough. If the judgment is unavailable, only corrections promote (conservative fallback).
- **Priority and cap**: the block carries at most 10 lines, correction-derived first (the negative surface — what the agent got wrong — is the valuable half), then by confidence × sessions. Correction-derived entries render as negative guidance: `Avoid X for key; use Y instead (user corrected this)`.
- **Host-file budget**: a CLAUDE.md already over ~200 lines accepts no new entries (existing ones keep regenerating so retirement still works); skips are logged, never silent.

## Skills

All skills are namespaced under `tom-swe:` when installed as a plugin.

| Skill | Description |
|-------|-------------|
| `/tom-swe:tom-setup` | Create config and enable ToM for first-time use |
| `/tom-swe:tom-status` | Show current model state, storage stats, top preferences |
| `/tom-swe:tom-inspect` | Deep inspection of session logs, models, and raw data |
| `/tom-swe:tom-reset` | Clear all ToM memory data (requires confirmation) |
| `/tom-swe:tom-export` | Export your user model as JSON |
| `/tom-swe:tom-forget` | Selectively remove specific preferences |

## Privacy

- All data is stored locally in `~/.claude/tom/` — nothing leaves your machine
- Secrets (API keys, tokens, passwords) are redacted before storage using pattern matching
- Long values are truncated to 200 characters
- Session logs contain tool names and parameter shapes, not full file contents
- Session logs also contain the text of your submitted prompts (captured by the UserPromptSubmit hook) after redaction: code blocks, URLs with query strings, and secret-shaped tokens are stripped before storage. This stored prompt text lives in Tier 1 (`~/.claude/tom/sessions/`) and is deleted by `/tom-reset`; preferences derived from it can be removed with `/tom-forget`
- The user model contains only aggregated preference clusters, not raw interaction data
- Use `/tom-reset` to delete all stored data at any time
- Use `/tom-forget` to selectively remove individual preferences
- Disable the system entirely by setting `"enabled": false` in config

### Session exclusion (agent sessions never train the user model)

ToM models one user. Autonomous agent sessions are machine behavior, and learning from them poisons the model, so every hook exits silently when any of these hold:

- `TOM_SWE_INTERNAL=1` — ToM's own headless spawns (recursion guard)
- `TOM_SWE_DISABLE=1` — explicit opt-out for any agent harness or automation
- `GC_AGENT` is set — Gas City rig sessions (mayors and polecats; the rig exports this to every agent it launches, so no rig configuration is needed)

### Work-audit join fields and model history

For coordination with external work-audit tooling, the Tier 1 session log records the session's `cwd` and git branch (set once per session; the branch is resolved in the async capture path only), and `session-usage` telemetry entries carry both. After each analysis, the post-session user model is also snapshotted to `~/.claude/tom/user-model-history/<session-id>.json` so the model's state *as of* any past session can be queried (temporal leave-one-out evaluation); snapshots are pruned together with their sessions under `maxSessionsRetained`.

## Telemetry

Every ToM operation appends one JSON line to `~/.claude/tom/usage.log`. The format is versioned (`v: 1`) and designed for external consumers — evaluation harnesses, analysis agents, or `jq` — in addition to the `/tom-status` rollup. Telemetry never leaves your machine.

Entry shape (validated by `UsageLogEntrySchema`, exported from `tom/routing.ts`; read with `readUsageLog()`, aggregate with `computeTelemetrySummary()` from `tom/telemetry.ts`):

```json
{"v": 1, "timestamp": "...", "operation": "...", "model": "...", "tokenCount": 0,
 "sessionId": "...", "durationMs": 12, "reason": "human-readable", "detail": {"machine": "fields"}}
```

| Operation | When | `detail` fields |
|-----------|------|-----------------|
| `prompt-hook` | Every prompt submission (this hook blocks the prompt, so its latency matters) | `consulted`, `injected`, `promptChars` |
| `ambiguity-consultation` | Prompt scored above the ambiguity threshold | `score`, `threshold`, `triggers`, `source` (`bm25`\|`user-model`\|`none`), `suggestionType`, `suggestionKeys`, `suggestionChars` |
| `session-start-injection` | User-model summary injected at session start | `chars`, `lines`, `preferences`, `injectedKeys` (`category:key` list of the asserted preferences) |
| `session-analysis` | LLM session analysis succeeded (real model + token usage) | `path: "llm"` |
| `session-analysis-fallback` | LLM path failed; the session's prior Tier 2 model was preserved if one existed (`preserved`), else the heuristic extractor ran (`heuristic`) | `path: "preserved" \| "heuristic"`, `failure` (typed reason) |
| `analysis-debounced` | Stop re-fired within the 90s debounce of a fresh analysis | `ageMs`, `debounceMs` |
| `analysis-skipped-no-new-evidence` | The Tier 1 log gained no new user messages since the last successful analysis (the watermark gate) | `userMessageCount`, `analyzedUserMessageCount` |
| `analysis-in-flight` | A concurrent Stop for the same session holds the analysis lock | `lockPath` |
| `analysis-log-truncated` | The bounded session log dropped interactions and/or user messages to fit the prompt budget (never silent) | `dropped`, `droppedUserMessages` |
| `analysis-vocabulary-echo` | Per successful LLM analysis with vocabulary injected: how much of the returned model is a verbatim echo of the injected vocabulary (anchoring baseline instrument, not a control input) | `injected`, `returned`, `echoedKeyValue`, `echoedKey` |
| `derivability-gate` | One agentic gate spawn judging project-promotion candidates | `outcome` (`ok`\|`unavailable`), `candidates`, `passed` |
| `session-usage` | Host session's own token usage, parsed from the transcript at Stop (deduplicated by message id; sidechains included). Logged once per Stop fire with **cumulative** totals — consumers dedupe by `sessionId`, last entry wins | `inputTokens`, `outputTokens`, `cacheCreationTokens`, `cacheReadTokens`, `assistantMessages` |
| `session-usage-error` | Transcript missing or unreadable | — |
| `preference-correction` | Corrections applied during aggregation | `corrections` (`category:key` list), `penalty` |
| `preference-promotion` | A CLAUDE.md marker block actually changed (idempotent regenerations don't log) | `promoted` (`category:key` list), `targets` (changed files) |
| `preference-follow-through` | Per session that asserted ≥1 preference key: whether each asserted key was corrected or confirmed (left un-corrected) in-session (an outcome-usefulness signal, not just memory stability) | `asserted`, `confirmed`, `corrected` (`category:key` lists) |
| `preference-cross-category-collapse` | A key split across categories was collapsed to one canonical category on rebuild (logged when the resolved winner category or value differs from what the previous model already had — steady-state re-collapses are suppressed) | `collapses` (list of `{key, winner, resolvedValue, refiled: [{fromCategory, value, confidence, learnedViaCorrection}]}`) |
| `promotion-file-created` | Global memory file created (no silent resource creation) | `path` |
| `promotion-cleanup` | One-time upgrade heal: a retired promotion marker block was stripped from a memory file (Option A; SessionStart injection is now the single surfacing path). Logged only when a block actually changed, then silent | `removed` (changed files) |
| `config-invalid` | `config.json` exists but is malformed or fails validation — the plugin is silently running on defaults (`enabled: false`) until fixed | — |
| `usage-log-rotated` | usage.log exceeded the size threshold and was archived to `usage-YYYY-MM-DD[-n].log` (archives preserved) | `archive` |
| `promotion-error` / `promotion-cleanup-error` / `session-analysis-error` / `prune-error` / `snapshot-error` | Pipeline failures (never silent) | — |

Every `category:key` identifier and every free-form preference value written to `usage.log` is first passed through the same secret-detection backstop the capture hook uses (`sanitizeValue`): a structured secret (API-key/token/JWT shape) or an oversized string is replaced with `[REDACTED]`. This runs at the telemetry-emission sites, not at the point the analyzer coins a key, so the in-memory model keeps its real key (identity, reinforcement, and promotion are unaffected) and keys persisted before the guard existed are still screened on every emission. It catches structured tokens, not a semantically-paraphrased key — that is not mechanically detectable.

The acceptance loop joins on preference keys: an `ambiguity-consultation` whose `suggestionKeys` contains `category:key`, followed by a `preference-correction` listing the same key, is a rejected suggestion; absence of a correction while the preference's confidence grows is acceptance. The Stop hook makes this join explicit: it records a per-session `preference-follow-through` tying every key asserted that session (SessionStart `injectedKeys` + user-model `suggestionKeys`) to whether the user corrected or confirmed it, and `/tom-effectiveness` reports the pooled follow-through rate — an outcome metric, versus the promotion rollup's memory-stability proxy. Only real `category:key` preferences count (bm25 provenance keys are excluded), and "confirmed" means only that the key was not overridden in-session, not that it improved an answer.

Cost overhead joins `session-analysis` against `session-usage` on `sessionId`. The four usage buckets are reported raw: cache reads are far cheaper than uncached input, so any collapsed "overhead %" is a pricing judgment — `/tom-status` shows an unweighted in+out share and labels it as such; weight the buckets per-model for cost-true numbers. Example:

```bash
jq -s '[.[] | select(.operation == "session-analysis-fallback")] | group_by(.detail.failure) | map({failure: .[0].detail.failure, n: length})' ~/.claude/tom/usage.log
```

## Development

```bash
npm install
npm run typecheck    # Type checking
npm test             # Run tests
npm run build        # Bundle with esbuild (output in dist/)
```

The build uses esbuild to bundle each hook and skill entry point into a self-contained JS file with all dependencies inlined. End users do not need to install `node_modules`.

## Related

[brains](https://github.com/sjarmak/brains) is the project-knowledge counterpart to this plugin: it builds forkable warm-start agent sessions over a codebase scope, while tom-swe learns the *user*. The two compose at session start — and brains exports `TOM_SWE_INTERNAL=1` on every build and fork, so tom-swe treats brain machinery as internal and never learns agent behavior into your user model.

## License

MIT
