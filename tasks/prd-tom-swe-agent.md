# PRD: Theory of Mind (ToM) Agent for Claude Code

## Introduction

Implement the ToM-SWE framework from the paper "ToM-SWE: User Mental Modeling for Software Engineering Agents" (Zhou et al.) as a Claude Code extension. The system pairs a dedicated Theory of Mind sub-agent with Claude Code's main agent to infer user goals, preferences, and constraints from instructions and interaction history. It maintains a persistent, hierarchical memory of the user across sessions, enabling personalized coding style, reduced ambiguity in vague instructions, and adaptive interaction patterns.

The architecture uses **hooks as the automatic trigger layer** (ensuring the ToM system fires consistently on every session) that **spawn a specialized ToM sub-agent** for mental state reasoning. This hybrid approach combines the paper's recommended dual-agent separation of concerns with guaranteed invocation consistency.

**Reference:** [ToM-SWE: User Mental Modeling for Software Engineering Agents](https://arxiv.org/html/2510.21903v2)

---

## Goals

- Implement the full 3-tier hierarchical memory system (raw sessions, session models, overall user model)
- Automatically analyze completed sessions to extract user intent, preferences, and coding style
- Provide in-session consultation when the main agent encounters ambiguity
- Personalize coding style, interaction verbosity, question timing, and response format across sessions
- Persist user models at both global (`~/.claude/tom/`) and project-level (`.claude/tom/`) scopes
- Use smart model routing: haiku for memory updates, sonnet for in-session consultation
- Match the paper's architecture as closely as possible for evaluation and iteration
- Achieve high user acceptance rate (paper reports 86% acceptance of ToM suggestions)

---

## User Stories

### US-001: Create 3-tier hierarchical memory system
**Description:** As a developer, I need a persistent memory structure so the ToM agent can store and retrieve user models across sessions.

**Acceptance Criteria:**
- [ ] Tier 1 (Raw Sessions): Store complete session histories as JSON files in `tom/sessions/`
- [ ] Tier 2 (Session Models): Store per-session analysis (intent, patterns, preferences) in `tom/session-models/`
- [ ] Tier 3 (Overall User Model): Store aggregated cross-session model in `tom/user-model.json`
- [ ] All data validated against Pydantic-style JSON schemas (use Zod for TypeScript)
- [ ] Global memory at `~/.claude/tom/` for cross-project preferences
- [ ] Project memory at `.claude/tom/` for project-specific preferences
- [ ] Merger logic: project-level overrides global-level when both exist
- [ ] Typecheck passes

### US-002: Implement session capture hook (PostToolUse)
**Description:** As a system, I need to automatically capture session interactions so the ToM agent has raw data to analyze.

**Acceptance Criteria:**
- [ ] PostToolUse hook fires after each tool execution
- [ ] Captures tool name, parameters (sanitized — no secrets), and outcome summary
- [ ] Appends to current session log (Tier 1) incrementally
- [ ] Minimal performance impact — async write, no blocking
- [ ] Does not capture file contents or sensitive data (only metadata)
- [ ] Typecheck passes

### US-003: Implement session analysis hook (Stop)
**Description:** As a system, I need to automatically analyze completed sessions so user models stay current without manual intervention.

**Acceptance Criteria:**
- [ ] Stop hook fires when a Claude Code session ends
- [ ] Spawns ToM sub-agent with `model: haiku` for cost efficiency
- [ ] Sub-agent reads Tier 1 raw session and produces Tier 2 session model
- [ ] Session model contains: session intent, interaction patterns, coding preferences observed, emotional/satisfaction signals
- [ ] Sub-agent updates Tier 3 overall user model by merging new session insights
- [ ] Runs in background — does not block session exit
- [ ] Typecheck passes

### US-004: Implement ToM sub-agent
**Description:** As a developer, I need a specialized ToM sub-agent that can reason about user mental states, search memory, and produce suggestions.

**Acceptance Criteria:**
- [ ] Sub-agent defined as a new agent type in `~/.claude/agents/tom-agent/`
- [ ] Supports 5 core actions from the paper: `search_memory`, `read_file`, `analyze_session`, `initialize_user_profile`, `give_suggestions`
- [ ] `search_memory` uses BM25-style keyword matching across memory tiers (top-k=3)
- [ ] `analyze_session` extracts intent, preferences, and interaction patterns from raw sessions
- [ ] `initialize_user_profile` creates Tier 3 model from scratch when no history exists
- [ ] `give_suggestions` produces structured recommendations for the main agent
- [ ] Maximum 3 memory operations per consultation (matches paper's action limit)
- [ ] Temperature 0.1 for deterministic reasoning (matches paper)
- [ ] Typecheck passes

### US-005: Implement in-session consultation trigger (PreToolUse)
**Description:** As a system, I need to detect ambiguity in user instructions and automatically consult the ToM agent before the main agent acts.

**Acceptance Criteria:**
- [ ] PreToolUse hook fires before tool execution
- [ ] Ambiguity detection heuristics: vague instructions, multiple valid interpretations, user-preference-sensitive decisions (e.g., code style, architecture choices)
- [ ] When ambiguity detected, spawns ToM sub-agent with `model: sonnet` for quality
- [ ] ToM agent searches memory for relevant user preferences and past decisions
- [ ] Suggestions injected into main agent's context before tool execution proceeds
- [ ] Hook does NOT fire on every tool call — only when ambiguity score exceeds threshold
- [ ] Configurable sensitivity: `tom.consultThreshold` in settings (default: medium)
- [ ] Typecheck passes

### US-006: Define Zod schemas for all ToM data structures
**Description:** As a developer, I need validated data structures for user profiles, session analyses, and memory entries so the system is type-safe and consistent.

**Acceptance Criteria:**
- [ ] `SessionLog` schema: timestamp, tools used, user messages (sanitized), outcomes
- [ ] `SessionModel` schema: session intent, interaction patterns array, coding preferences array, satisfaction signals
- [ ] `UserModel` schema: preference clusters, interaction style summary, coding style summary, per-project overrides
- [ ] `ToMSuggestion` schema: suggestion type (preference | disambiguation | style), content, confidence score, source sessions
- [ ] All schemas exported from a single `tom/schemas.ts` file
- [ ] Validation applied on read and write of all memory files
- [ ] Typecheck passes

### US-007: Implement preference tracking categories
**Description:** As a user, I want the system to track my specific coding and interaction preferences so suggestions are relevant and accurate.

**Acceptance Criteria:**
- [ ] **Interaction style**: verbosity preference (concise/moderate/verbose), question timing (upfront/iterative), response length expectation
- [ ] **Coding preferences**: language defaults, library preferences, testing approach (TDD/post-hoc), architecture patterns, naming conventions
- [ ] **Emotional/contextual signals**: frustration indicators, satisfaction indicators, urgency level, exploration vs. execution mode
- [ ] Each preference has a confidence score (0-1) that increases with repeated observation
- [ ] Preferences decay over time if not reinforced (configurable half-life)
- [ ] Typecheck passes

### US-008: Implement smart model routing
**Description:** As a system operator, I need to minimize ToM cost overhead while maintaining quality for critical consultations.

**Acceptance Criteria:**
- [ ] Memory updates (Stop hook, session analysis) use `model: haiku` — cheap and fast
- [ ] In-session consultations (PreToolUse ambiguity) use `model: sonnet` — higher quality
- [ ] User profile initialization uses `model: sonnet` (one-time cost)
- [ ] Model selection configurable via `tom.models.memoryUpdate` and `tom.models.consultation` settings
- [ ] Log model used and token count for each ToM operation to `tom/usage.log`
- [ ] Typecheck passes

### US-009: Create ToM configuration and opt-in system
**Description:** As a user, I want to control whether ToM is active and configure its behavior without editing code.

**Acceptance Criteria:**
- [ ] Configuration in `~/.claude/settings.json` under `tom` key
- [ ] `tom.enabled`: boolean, default `false` (opt-in)
- [ ] `tom.consultThreshold`: "low" | "medium" | "high", default "medium"
- [ ] `tom.models.memoryUpdate`: model name, default "haiku"
- [ ] `tom.models.consultation`: model name, default "sonnet"
- [ ] `tom.preferenceDecayDays`: number, default 30
- [ ] `tom.maxSessionsRetained`: number, default 100 (Tier 1 pruning)
- [ ] `/tom status` skill shows current model state, session count, and preference summary
- [ ] `/tom reset` skill clears all ToM memory (with confirmation)
- [ ] Typecheck passes

### US-010: Implement memory search with BM25 retrieval
**Description:** As the ToM sub-agent, I need to efficiently search across memory tiers to find relevant past sessions and preferences.

**Acceptance Criteria:**
- [ ] BM25 keyword-based search implementation (lightweight, no external dependencies)
- [ ] Searches across all 3 tiers with configurable weighting (Tier 3 highest, Tier 1 lowest)
- [ ] Returns top-k=3 most relevant results by default (configurable)
- [ ] Search indexed on: session intent, preference keywords, tool names, user message fragments
- [ ] Index rebuilt on session analysis completion (not on every query)
- [ ] Sub-200ms query latency for up to 100 stored sessions
- [ ] Typecheck passes

### US-011: Implement cross-session preference aggregation
**Description:** As a system, I need to merge per-session observations into a stable overall user model that improves over time.

**Acceptance Criteria:**
- [ ] After each session analysis (Tier 2), merge new preferences into Tier 3
- [ ] Preferences reinforced by multiple sessions get higher confidence scores
- [ ] Conflicting preferences resolved by recency-weighted voting
- [ ] Preference clusters identified: e.g., "prefers functional style", "likes detailed error messages"
- [ ] Tier 3 model includes `lastUpdated` timestamp and `sessionCount` for each preference
- [ ] Model is immutable — each update produces a new version (append, not mutate)
- [ ] Typecheck passes

### US-012: Add privacy and data controls
**Description:** As a user, I want full control over what data the ToM system stores and the ability to inspect or delete it.

**Acceptance Criteria:**
- [ ] No file contents stored in session logs — only tool names, parameter shapes, and outcomes
- [ ] No secrets, API keys, or credentials captured (redaction layer in session capture hook)
- [ ] `/tom inspect` skill shows what data is currently stored (human-readable summary)
- [ ] `/tom forget [session-id]` skill removes a specific session and re-aggregates
- [ ] `/tom export` skill exports all ToM data as a single JSON file
- [ ] `.gitignore` template includes `.claude/tom/` by default
- [ ] Typecheck passes

---

## Functional Requirements

- FR-1: The system must maintain a 3-tier hierarchical memory: raw sessions (Tier 1), session models (Tier 2), and overall user model (Tier 3)
- FR-2: A PostToolUse hook must capture session interaction metadata after each tool execution
- FR-3: A Stop hook must spawn a ToM sub-agent (haiku) to analyze completed sessions and update memory
- FR-4: A PreToolUse hook must detect ambiguity in user instructions and spawn a ToM sub-agent (sonnet) for consultation when threshold is exceeded
- FR-5: The ToM sub-agent must support 5 actions: `search_memory`, `read_file`, `analyze_session`, `initialize_user_profile`, `give_suggestions`
- FR-6: Memory search must use BM25 keyword retrieval with top-k=3 results across all tiers
- FR-7: The system must track 3 preference categories: interaction style, coding preferences, and emotional/contextual signals
- FR-8: Each preference must have a confidence score (0-1) that increases with reinforcement and decays over time
- FR-9: User models must persist at both global (`~/.claude/tom/`) and project (`.claude/tom/`) levels, with project overriding global
- FR-10: All memory data structures must be validated against Zod schemas on read and write
- FR-11: The ToM sub-agent must be limited to 3 memory operations per consultation (matching the paper)
- FR-12: Smart model routing must use haiku for background updates and sonnet for real-time consultation
- FR-13: The system must be opt-in via `tom.enabled` in settings, defaulting to `false`
- FR-14: No file contents, secrets, or credentials may be stored in ToM memory
- FR-15: Users must be able to inspect, export, forget, and reset their ToM data via skills

---

## Non-Goals (Out of Scope)

- **No cloud sync** — ToM data stays local only; no remote storage or cross-machine sync
- **No multi-user modeling** — system models one user per machine, not teams
- **No automatic code modification** — ToM provides suggestions to the main agent, never edits code directly
- **No training or fine-tuning** — uses prompt-based reasoning only, no model training
- **No integration with external memory systems** — no Redis, vector DBs, or external services
- **No real-time streaming** — ToM consultation is request/response, not streamed
- **No UI/dashboard** — all interaction via CLI skills and config files

---

## Technical Considerations

### Architecture (matching paper)

```
┌─────────────────────────────────────────────────┐
│                  Claude Code Main Agent          │
│                                                  │
│  PreToolUse ──► Ambiguity? ──► ToM Agent (sonnet)│
│       │              │              │             │
│       ▼              ▼              ▼             │
│  Execute Tool   No action    Inject suggestion   │
│       │                                          │
│  PostToolUse ──► Capture session metadata        │
│       │                                          │
│  Stop Hook ──► ToM Agent (haiku)                 │
│                    │                             │
│              Analyze session                     │
│              Update memory                       │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│              3-Tier Memory System                │
│                                                  │
│  Tier 1: ~/.claude/tom/sessions/*.json           │
│          .claude/tom/sessions/*.json             │
│                                                  │
│  Tier 2: ~/.claude/tom/session-models/*.json     │
│          .claude/tom/session-models/*.json        │
│                                                  │
│  Tier 3: ~/.claude/tom/user-model.json           │
│          .claude/tom/user-model.json             │
└─────────────────────────────────────────────────┘
```

### Hook implementation

Hooks are configured in `~/.claude/settings.json` under the existing hooks system. The ToM hooks will:
- **PostToolUse**: Shell script that appends interaction metadata to current session log
- **Stop**: Shell script that invokes `claude --agent tom-agent --task analyze-session`
- **PreToolUse**: Shell script that checks ambiguity heuristics and optionally invokes `claude --agent tom-agent --task consult`

### Dependencies

- Zero external dependencies — BM25 implemented as a lightweight utility
- Zod for schema validation (already available in most Claude Code projects)
- All file I/O uses Node.js built-ins

### Performance budget

- PostToolUse hook: < 10ms (async file append)
- PreToolUse ambiguity check: < 50ms (local heuristics only; sub-agent spawn only if triggered)
- Stop hook session analysis: < 30s (background, non-blocking)
- BM25 search: < 200ms for 100 sessions

### Paper alignment

| Paper Component | Implementation |
|---|---|
| Dual-agent architecture | ToM sub-agent + hooks trigger layer |
| consult_tom (in-session) | PreToolUse hook spawning sonnet sub-agent |
| update_memory (after-session) | Stop hook spawning haiku sub-agent |
| 3-tier memory | JSON files in `~/.claude/tom/` and `.claude/tom/` |
| BM25 retrieval | Lightweight JS implementation, top-k=3 |
| Action limit (3 per consult) | Enforced in sub-agent prompt |
| Temperature 0.1 (ToM) | Set in sub-agent configuration |
| Pydantic schemas | Zod schemas with identical structure |
| 5 core actions | Mapped to sub-agent tool definitions |

---

## Success Metrics

- ToM suggestions accepted/partially accepted at >= 80% rate (paper reports 86%)
- Session analysis completes in < 30s without blocking session exit
- In-session consultation adds < 3s latency when triggered
- User model stabilizes (preference confidence > 0.7) within 5-10 sessions
- Cost overhead < 20% of typical session cost (paper reports ~16%)
- Zero secrets or file contents leaked into ToM memory (verified by privacy audit)
- Users report feeling "understood" after 3+ sessions (qualitative feedback)

---

## Open Questions

1. **Ambiguity detection heuristics** — What specific signals should trigger in-session consultation? The paper uses the SWE agent's own judgment; should we add rule-based triggers (e.g., user instruction length < N words, multiple valid file targets)?
2. **Session boundary** — How do we define a "session" for Tier 1 capture? Is it one `claude` CLI invocation, or should continued conversations count as one session?
3. **Memory pruning** — When `maxSessionsRetained` is exceeded, should we prune oldest sessions or lowest-confidence sessions?
4. **Conflict resolution** — When global and project preferences conflict, should project always win, or should we consider confidence scores?
5. **Evaluation framework** — Should we build an automated eval harness (simulated users like the paper's benchmark) or rely on real-world dogfooding?
6. **Hook shell overhead** — Spawning a new `claude` process for the Stop hook may be slow. Should we explore in-process agent invocation instead?
