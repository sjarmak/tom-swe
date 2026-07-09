---
name: tom-effectiveness
description: Report whether promoting a preference into CLAUDE.md reduces how often it gets corrected. Use when the user asks whether ToM is working, effective, or useful, or wants a before/after promotion analysis.
---

# /tom-effectiveness

Show the promotion-effectiveness rollup: does pinning a preference into CLAUDE.md
reduce how often it gets corrected, versus its pre-promotion life?

The metric uses analysis runs (not host sessions) as the exposure unit, because
corrections only fire inside the Stop-hook analyzer. Rates are corrections per 100
analyses, split before vs after each key's first promotion. It reports:

- The headline share of corrections landing on never-promoted keys (the promotion
  gate filtering unstable inferences out).
- Per-key before/after correction rates, with thin after-windows flagged.
- Weekly correction rate over time.

Execute:
```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/tom/skills/tom-effectiveness.js
```

Display the output to the user as-is (it's pre-formatted markdown).

Correction rate measures memory stability (does the model stop flip-flopping), not
task usefulness (did asserting the preference change an outcome). Relay that framing
if the user reads the numbers as a usefulness score.
