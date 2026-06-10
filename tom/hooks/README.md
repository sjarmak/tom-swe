# ToM Hooks

Four hooks integrate the Theory of Mind system with Claude Code:

| Hook | Bundle | Matcher | Behavior |
|------|--------|---------|----------|
| **SessionStart** | `dist/tom/hooks/session-start.js` | all | Injects a compact summary of the learned user model (confident preferences + style summaries) via `hookSpecificOutput.additionalContext` |
| **PostToolUse** | `dist/tom/hooks/capture-interaction.js` | all | Captures interaction metadata after each tool call (async) |
| **PreToolUse** | `dist/tom/hooks/pre-tool-use.js` | `Write\|Edit\|NotebookEdit` | Consults ToM on ambiguous edit-type tool calls; injects context via `hookSpecificOutput.additionalContext` (no permission decision) |
| **Stop** | `dist/tom/hooks/stop-analyze.js` | all | Analyzes the completed session via headless claude (configured `memoryUpdate` model) with a logged heuristic fallback, then updates memory (async) |

All hooks:

- Read the Claude Code hook payload as **JSON on stdin** (`session_id`,
  `hook_event_name`, `tool_name`, `tool_input`, `tool_response`,
  `stop_hook_active`, ...) via `hook-input.ts`. Parsing is permissive —
  unknown fields are preserved.
- Resolve session identity as: payload `session_id`, then
  `CLAUDE_SESSION_ID`, then a pid-based last resort.
- Check `~/.claude/tom/config.json` `enabled` before doing anything.
- Exit immediately and silently when `TOM_SWE_INTERNAL=1` (set on headless
  claude invocations spawned by ToM itself, to prevent recursion).
- The Stop hook additionally exits when the payload has
  `stop_hook_active: true` (loop guard).

## Registration

`hooks/hooks.json` is the single registration mechanism: when the plugin is
installed, Claude Code wires the dist bundles automatically via
`${CLAUDE_PLUGIN_ROOT}`. Nothing is written to `~/.claude/settings.json`;
`/tom-setup` only creates `~/.claude/tom/config.json`.
