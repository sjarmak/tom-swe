---
name: tom-setup
description: Initialize ToM configuration for first-time use. Creates ~/.claude/tom/config.json with default settings. Use when the user wants to set up or enable ToM.
---

# /tom-setup

Set up Theory of Mind for first-time use.

This creates the ToM config file at `~/.claude/tom/config.json` with sensible defaults and enables the system.

Execute:
```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/tom/skills/tom-setup.js
```

Display the output to the user as-is (it's pre-formatted markdown).

If the config already exists, inform the user and suggest `/tom-status` to check current state.
