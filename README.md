# ToM-SWE

Theory of Mind agent for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — learns your coding preferences, interaction style, and project patterns across sessions.

Based on the paper [ToM-SWE: User Mental Modeling for Software Engineering Agents](https://arxiv.org/abs/2505.15842).

## What it does

ToM-SWE observes how you use Claude Code and builds a model of your preferences over time. When it detects ambiguity in a tool call (e.g., which file format to use, which coding style to apply), it consults your preference history and provides context to Claude so it can act in line with what you prefer — without you needing to repeat yourself.

### Three-tier memory system

| Tier | What | Where |
|------|------|-------|
| **Tier 1** | Raw session logs (tool calls, parameters, outcomes, redacted prompt text) | `~/.claude/tom/sessions/` |
| **Tier 2** | Session models (intent, patterns, satisfaction signals) | `~/.claude/tom/session-models/` |
| **Tier 3** | Aggregated user model (confidence-scored preference clusters) | `~/.claude/tom/user-model.json` |

### Four hooks drive the system

- **SessionStart** — injects a compact summary of your learned user model (confident preferences plus interaction/coding style) as additional context at the start of each session
- **PostToolUse** — captures interaction metadata after each tool call (async, non-blocking)
- **UserPromptSubmit** — runs on every prompt you submit; stores a redacted copy of the prompt in the Tier 1 session log (so session analysis sees your real instructions) and runs ambiguity detection on the prompt text. Above the configured threshold it injects relevant preference context via `hookSpecificOutput.additionalContext`, framed as background observation — never as instructions, and never blocking the prompt. Consultation is local (BM25 search over stored memory plus the user model) — no model is spawned (sync)
- **Stop** — analyzes the completed session with a headless `claude` invocation using the configured `memoryUpdate` model; on any LLM failure it falls back to a heuristic extractor and logs the fallback with its reason to `~/.claude/tom/usage.log`. The resulting session model is aggregated into the user model and the search index is rebuilt (async)

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

Promoted preferences are written into a marker-bounded block (`<!-- tom-swe:begin ... -->` / `<!-- tom-swe:end -->`) that is regenerated wholesale after each session — the ToM store stays the source of truth. Coding preferences go to the project's `CLAUDE.md` (only if it already exists; tom-swe never creates files in your repos), while interaction-style and emotional-signal preferences go to `~/.claude/CLAUDE.md`. A preference whose confidence later decays below the threshold drops out of the block automatically and returns to per-session injection. `/tom-reset` removes the marker blocks along with the store.

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
| `session-start-injection` | User-model summary injected at session start | `chars`, `lines`, `preferences` |
| `session-analysis` | LLM session analysis succeeded (real model + token usage) | `path: "llm"` |
| `session-analysis-fallback` | LLM path failed; heuristic extractor ran | `path: "heuristic"`, `failure` (typed reason) |
| `session-usage` | Host session's own token usage, parsed from the transcript at Stop (deduplicated by message id; sidechains included) | `inputTokens`, `outputTokens`, `cacheCreationTokens`, `cacheReadTokens`, `assistantMessages` |
| `session-usage-error` | Transcript missing or unreadable | — |
| `preference-correction` | Corrections applied during aggregation | `corrections` (`category:key` list), `penalty` |
| `preference-promotion` | Preferences promoted to CLAUDE.md | `promoted` (`category:key` list), `targets` (files) |
| `promotion-file-created` | Global memory file created (no silent resource creation) | `path` |
| `promotion-error` / `session-analysis-error` | Pipeline failures (never silent) | — |

The acceptance loop joins on preference keys: an `ambiguity-consultation` whose `suggestionKeys` contains `category:key`, followed by a `preference-correction` listing the same key, is a rejected suggestion; absence of a correction while the preference's confidence grows is acceptance.

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
