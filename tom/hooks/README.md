# ToM Hooks

Three hooks integrate the Theory of Mind system with Claude Code:

| Hook | Script | Behavior |
|------|--------|----------|
| **PostToolUse** | `post-tool-use.sh` | Captures interaction metadata after each tool call (backgrounded) |
| **PreToolUse** | `pre-tool-use.sh` | Consults ToM agent on ambiguous tool calls (synchronous, outputs to stdout) |
| **Stop** | `stop-analyze.sh` | Analyzes completed session and updates memory (backgrounded) |

All hooks check `tom.enabled` before executing. If ToM is not enabled, they are no-ops.

## Example settings.json

Add the following to `~/.claude/settings.json`:

```json
{
  "tom": {
    "enabled": true,
    "consultThreshold": "medium",
    "models": {
      "memoryUpdate": "haiku",
      "consultation": "sonnet"
    }
  },
  "hooks": {
    "PostToolUse": [
      {
        "type": "command",
        "command": "bash \"/path/to/tom/hooks/post-tool-use.sh\""
      }
    ],
    "PreToolUse": [
      {
        "type": "command",
        "command": "bash \"/path/to/tom/hooks/pre-tool-use.sh\""
      }
    ],
    "Stop": [
      {
        "type": "command",
        "command": "bash \"/path/to/tom/hooks/stop-analyze.sh\""
      }
    ]
  }
}
```

Replace `/path/to/tom/hooks/` with the actual path to this directory.

## Automatic Registration

Run `register-hooks.ts` to automatically add hook entries to your settings.json:

```bash
npx ts-node tom/hooks/register-hooks.ts
```

This will add hooks alongside any existing hooks without overwriting them.
