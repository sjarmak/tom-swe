#!/usr/bin/env bash
# PreToolUse hook: Consults the ToM agent when ambiguity is detected in tool calls.
# No-op if tom.enabled is not true in ~/.claude/settings.json.
# If ambiguity exceeds threshold, spawns ToM sub-agent with model sonnet.
# Suggestion output written to stdout so Claude Code hook system can inject it as context.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Run the TypeScript consultation helper (synchronous — output goes to stdout)
node "${SCRIPT_DIR}/pre-tool-use.js"
