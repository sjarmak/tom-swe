---
name: tom-inspect
description: Show exactly what data the ToM system has stored — all sessions, their analysis, and the full user model. Use when the user wants to audit their ToM data.
---

# /tom-inspect

Inspect all stored Theory of Mind data.

Execute:
```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/tom/skills/tom-inspect.js
```

Display the output to the user. It shows:
- All stored sessions with date, ID, and intent summary
- Sessions marked for pruning on next analysis
- The full Tier 3 user model with preferences grouped by category
- Project-specific overrides if any exist
