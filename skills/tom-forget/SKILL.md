---
name: tom-forget
description: Remove a specific session from ToM memory and rebuild the user model without it. Use when the user wants to delete a particular session's influence on their profile.
---

# /tom-forget

Remove a specific session from Theory of Mind memory.

The user should provide a session ID. If they don't know the ID, suggest running `/tom-inspect` first to see all sessions.

Execute with the session ID from $ARGUMENTS:
```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/tom/skills/tom-forget-export.js forget $ARGUMENTS
```

This will:
1. Delete the Tier 1 session log and Tier 2 session model for that session
2. Rebuild the Tier 3 user model from remaining sessions
3. Rebuild the BM25 search index

Display the result to the user.
