# ToM-SWE

Theory of Mind agent for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — learns your coding preferences, interaction style, and project patterns across sessions.

Based on the paper [ToM-SWE: User Mental Modeling for Software Engineering Agents](https://arxiv.org/abs/2505.15842).

## What it does

ToM-SWE observes how you use Claude Code and builds a model of your preferences over time. When it detects ambiguity in a tool call (e.g., which file format to use, which coding style to apply), it consults your preference history and provides context to Claude so it can act in line with what you prefer — without you needing to repeat yourself.

### Three-tier memory system

| Tier | What | Where |
|------|------|-------|
| **Tier 1** | Raw session logs (tool calls, parameters, outcomes) | `~/.claude/tom/sessions/` |
| **Tier 2** | Session models (intent, patterns, satisfaction signals) | `~/.claude/tom/session-models/` |
| **Tier 3** | Aggregated user model (confidence-scored preference clusters) | `~/.claude/tom/user-model.json` |

### Three hooks drive the system

- **PostToolUse** — captures interaction metadata after each tool call (async, non-blocking)
- **PreToolUse** — detects ambiguity in the current tool call and consults your preference model for relevant context (sync)
- **Stop** — analyzes the completed session, extracts a session model, aggregates into the user model, and rebuilds the search index (async)

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
  "maxSessionsRetained": 100
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `false` | Master switch for all ToM hooks |
| `consultThreshold` | `"medium"` | Ambiguity sensitivity: `"low"` (consults often), `"medium"`, `"high"` (consults rarely) |
| `models.memoryUpdate` | `"haiku"` | Model used for session analysis |
| `models.consultation` | `"sonnet"` | Model used for preference consultation |
| `preferenceDecayDays` | `30` | Days before low-confidence preferences expire |
| `maxSessionsRetained` | `100` | Maximum session logs kept on disk |

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
- The user model contains only aggregated preference clusters, not raw interaction data
- Use `/tom-reset` to delete all stored data at any time
- Use `/tom-forget` to selectively remove individual preferences
- Disable the system entirely by setting `"enabled": false` in config

## Development

```bash
npm install
npm run typecheck    # Type checking
npm test             # Run tests (394 tests across 20 files)
npm run build        # Bundle with esbuild (output in dist/)
```

The build uses esbuild to bundle each hook and skill entry point into a self-contained JS file with all dependencies inlined. End users do not need to install `node_modules`.

## License

MIT
