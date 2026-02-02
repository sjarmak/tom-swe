#!/usr/bin/env bash
# Stop hook: Spawns the ToM sub-agent to analyze the completed session and update memory.
# No-op if tom.enabled is not true in ~/.claude/settings.json.
# Runs analysis in the background so it does not block session exit.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Run the TypeScript analysis helper in the background (does not block session exit)
node "${SCRIPT_DIR}/stop-analyze.js" &

exit 0
