# Architecture diagram (LikeC4)

Architecture-as-code model of `tom-swe`, rendered with [LikeC4](https://likec4.dev).
The model is the source of truth across [`spec.c4`](spec.c4) (element kinds,
tags, deployment node kinds), [`model.c4`](model.c4) (the system), and
[`views.c4`](views.c4) (structure, walkthrough, and risk views), with the
deployment model in [`deployment.c4`](deployment.c4). The narrative companion is
the repo-root [`README.md`](../README.md).

`tom-swe` is a Theory-of-Mind plugin for Claude Code: it observes how one user
drives the harness, builds a confidence-scored model of their coding preferences
and interaction style across sessions, and injects relevant context when a prompt
is ambiguous. It ships as four lifecycle hooks plus a set of management skills,
bundled by esbuild into `dist/` and registered via `hooks/hooks.json`; memory
lives as plain JSON in three tiers under `~/.claude/tom/`.

Every element `link`s to its source (`tom/…`, `agents/…`, `skills/…`,
`hooks/…`) so any box in the explorer is one click from the code.

## Delivery state is tagged, not guessed

Every element carries a tag so **designed-but-unwired work renders distinctly
from what is already running** (legend in `spec.c4`):

| Tag | Meaning | Render |
|---|---|---|
| `#built` | code path exists and runs in the live hook/skill pipeline | solid |
| `#evolving` | built and running, but the contract/behavior is still moving | solid |
| `#planned` | designed, code exists, but **not wired into the runtime path** | **dashed, dimmed** |
| `#research` | speculative track (paper-derived, not implemented) | **dashed, indigo** |

The headline finding the tags surface: the namesake **ToM reasoning sub-agent**
(`agents/tom-agent.md` + `tom/agent/`) is built and unit-tested but **never
spawned by any hook** — only its `buildMemoryIndex` helper is wired in. The live
consultation path is a fully local BM25 lookup (`tom/consult.ts`), and the only
model call is the headless `claude -p` session analysis on Stop
(`tom/llm-analyze.ts`). Planned/research items in the model: the interactive ToM
sub-agent (`#planned`) and the model-backed consultation path
(`models.consultation = sonnet`, reserved but unused — `#research`).

## Views

**Structure** — the static map:

| View | Scope |
|---|---|
| `index` | system landscape — `tom-swe` in context of the Claude Code harness, the modeled user, and headless inference |
| `tomSystem` | the `tom-swe` system decomposed into containers (built vs planned) |
| `hooksContainer` | the four lifecycle hooks (`tom/hooks/`) — the Claude Code integration surface |
| `reasoningContainer` | the reasoning core (`tom/`) — ambiguity, consultation, BM25, LLM + heuristic extraction, telemetry |
| `modelingContainer` | preference modeling — aggregation, idempotent rebuild, decay, and cleanup of any legacy CLAUDE.md marker block |
| `storeContainer` | the 3-tier JSON store (`~/.claude/tom/`) plus index, history snapshots, and the telemetry log |
| `skillsContainer` | the management skills — setup / status / inspect / reset / forget / export |
| `planned` | the unwired sub-agent + research track, with built dependencies dimmed |
| `deployment` | where each piece runs — everything on the developer workstation (harness, hook procs, JSON store, headless claude) |

**Walkthrough flows** (dynamic / numbered-step views) — the narrative spine for
a design-review walkthrough:

| View | Flow |
|---|---|
| `consultFlow` | the live runtime path: ambiguity detected → local BM25 consultation → preference context injected → response adjusted |
| `analyzeFlow` | the Stop-hook learning loop: parse usage → extract Tier 2 (LLM, heuristic fallback) → idempotent Tier 3 rebuild → reindex → prune |
| `promotionFlow` | one-time cleanup of any legacy CLAUDE.md promotion block (the write-path is retired; SessionStart surfaces prefs directly) |
| `agentLoop` | the **planned** interactive ToM sub-agent consultation loop (built, not yet wired) |

**Risk lens:**

| View | Scope |
|---|---|
| `risks` | the `#risk`-flagged elements with each open question stated in-box (sub-agent unwired, local-only consultation, headless-CLI dependency + env-only recursion guard) |

### Running the walkthrough

For a design review, present in this order: `index` → `tomSystem` (orient on
structure) → the four walkthrough flows in sequence (what actually happens) →
`deployment` (where it runs) → `risks` (what to probe) → `planned` (what's next).
In `npx likec4 start`, the dynamic views animate step-by-step and each view's
notes panel carries the gotchas (consultation is local and never blocks the
prompt; Stop fires per turn-end and is debounced; Tier 3 is rebuilt not
incremented; the promotion write-path is retired — only a legacy marker-block
cleanup remains).

## Viewing & regenerating

```bash
# Interactive, hot-reloading explorer (recommended)
npx likec4 start architecture

# Re-export the static PNGs in exports/ (needs a one-time browser download:
#   npx playwright install chromium-headless-shell)
npx likec4 export png architecture -o architecture/exports

# Validate the model (strict — the source of truth for correctness)
npx likec4 validate architecture
```

### Viewing the interactive explorer over SSH (headless remote)

`likec4 start` serves a Vite dev server on `localhost:5173`. From a headless
remote, forward that port to your laptop and open it locally — three options,
easiest first:

1. **VS Code / Cursor Remote-SSH** — run `npx likec4 start architecture` in the
   integrated terminal; the editor auto-forwards 5173 and offers "Open in
   Browser". Nothing else to configure.
2. **SSH local port-forward** — on your laptop:
   ```bash
   ssh -N -L 5173:localhost:5173 user@remote   # leave running
   ```
   then on the remote `npx likec4 start architecture` and open
   <http://localhost:5173> locally. (Already in an SSH session? Add the tunnel
   without reconnecting: press `~C` then type `-L 5173:localhost:5173`.)
3. **Bind + reach directly** — `npx likec4 start architecture --listen 0.0.0.0`
   and browse to `http://<remote-ip>:5173` (only if that port is reachable /
   firewall-open; the tunnel in option 2 is safer).

No browser at all? Export the static PNGs with `npx likec4 export png` — they
need no display, so `scp` them down, or view inline if your terminal supports
images.
