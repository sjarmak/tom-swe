---
name: tom-status
description: Show the current state of your ToM user model, preferences, and configuration. Use when the user asks about their ToM profile or wants to see what the system has learned.
---

# /tom-status

Display the current Theory of Mind model state.

Run the ToM status helper to show:
- Whether ToM is enabled and current configuration
- Storage stats (session count, model count, storage size)
- Top preferences by confidence score
- Interaction style and coding style summaries

Execute:
```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/tom/skills/tom-status.js
```

Display the output to the user as-is (it's pre-formatted markdown).

If the output says "No user model found", explain that ToM will begin learning after the user completes a few sessions.
