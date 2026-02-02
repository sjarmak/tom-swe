---
name: tom-reset
description: Clear all ToM memory data (sessions, models, indexes). Use when the user wants to start fresh with their user model. Requires confirmation.
---

# /tom-reset

Clear all Theory of Mind memory data.

**This is a destructive operation.** Before proceeding:
1. Ask the user to confirm they want to delete all ToM data
2. Only proceed after explicit confirmation

Execute with the --confirm flag after user confirms:
```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/tom/skills/tom-reset.js --confirm
```

This deletes:
- All session logs (Tier 1)
- All session models (Tier 2)
- The user model (Tier 3)
- The BM25 search index
- The usage log

It does NOT delete the ToM config file.

Display the deletion summary to the user.
