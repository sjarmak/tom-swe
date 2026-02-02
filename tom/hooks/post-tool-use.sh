#!/usr/bin/env bash
# PostToolUse hook: Captures session interaction metadata after each tool execution.
# No-op if tom.enabled is not true in ~/.claude/settings.json.
# Delegates to capture-interaction.ts for sanitization and persistence.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Run the TypeScript capture helper in the background for speed (<10ms)
node "${SCRIPT_DIR}/capture-interaction.js" &

exit 0
