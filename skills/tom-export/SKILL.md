---
name: tom-export
description: Export all ToM data (sessions, models, config, usage log) to a single JSON file. Use when the user wants a backup or wants to inspect their data externally.
---

# /tom-export

Export all Theory of Mind data to a single JSON file.

Execute:
```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/tom/skills/tom-forget-export.js export
```

This creates a `tom-export-{timestamp}.json` file in the current directory containing:
- All Tier 1 session logs
- All Tier 2 session models
- The Tier 3 user model
- Current configuration
- Usage log

The file is self-contained and could be used for import in a future version.

Display the output path to the user.
