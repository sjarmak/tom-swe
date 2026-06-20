/**
 * Derivability gate for project-scoped promotions.
 *
 * CLAUDE.md should carry only what an agent CANNOT infer from the
 * repository itself ("prefers vitest" in a repo whose package.json says
 * vitest is noise). Whether a fact is statically derivable is a semantic
 * judgment, so it belongs to a model, not a heuristic — and promotion is a
 * rare event, so the one headless call is cheap.
 *
 * Correction-derived candidates bypass this gate entirely: a correction is
 * prima facie evidence the static information was not enough.
 */

import { spawnSync } from 'node:child_process'

export interface GateCandidate {
  /** Stable identity (category::key::value) echoed back by the judge. */
  readonly id: string
  /** Human-readable statement of the candidate preference. */
  readonly statement: string
}

/**
 * A gate returns the set of candidate ids that PASS (are not derivable
 * from the repo and worth writing down), or null when judgment was
 * unavailable — callers fall back conservatively.
 */
export type DerivabilityGate = (
  candidates: readonly GateCandidate[]
) => ReadonlySet<string> | null

// Matches the session-analysis path (LLM_ANALYSIS_TIMEOUT_MS). The gate is an
// agentic call — it inspects the repo with Read/Glob/Grep — so it is slower
// than a plain extraction. A 45s ceiling left ~37% of gate runs unavailable
// (derivability-gate-unavailable in usage.log); 90s covers the tool-using tail.
//
// Latency note: this gate runs synchronously in the Stop hook AFTER the (up to
// 90s) async analysis, so a promotion turn's worst-case background wall time is
// ~180s. That ceiling is only reachable on turns that actually have new
// project-scoped promotion candidates needing judgment (rare — most Stops have
// none and skip the spawn entirely), and the Stop hook is background work that
// does not block the interactive turn. The bound is accepted for that rarity.
const GATE_TIMEOUT_MS = 90_000

export function buildGatePrompt(candidates: readonly GateCandidate[]): string {
  return [
    `You are auditing candidate additions to this repository's CLAUDE.md.`,
    `CLAUDE.md must only carry facts an agent could NOT infer from the repository itself: configs, dependencies, lockfiles, scripts, existing docs, and code conventions are all visible to agents already.`,
    ``,
    `Candidates:`,
    ...candidates.map((c) => `- id: ${c.id} — ${c.statement}`),
    ``,
    `Inspect the repository as needed (Read/Glob/Grep). For each candidate, decide: is this fact already statically derivable from the repository?`,
    `Respond with ONLY a JSON array of the ids that are NOT derivable and therefore worth writing down. Example: ["a::b::c"]. No other text.`,
  ].join('\n')
}

function extractJsonArray(text: string): string[] | null {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

/**
 * Runs the headless derivability judgment in the project directory.
 * Returns null on any failure (spawn error, non-zero exit, unparseable
 * output) — the caller's conservative fallback handles it loudly.
 */
export function judgeDerivability(
  candidates: readonly GateCandidate[],
  cwd: string,
  model: string
): ReadonlySet<string> | null {
  if (candidates.length === 0) {
    return new Set()
  }

  // The prompt is piped via stdin, NOT passed on argv: the gate prompt embeds
  // every candidate statement, and a large candidate set on argv overflows the
  // OS ARG_MAX (spawn E2BIG). `claude -p` with no prompt arg reads from stdin,
  // so argv length stays constant regardless of candidate count. This mirrors
  // the analysis path's stdin fix (see llm-analyze.ts).
  const proc = spawnSync(
    'claude',
    [
      '-p',
      '--model',
      model,
      '--output-format',
      'json',
      '--allowedTools',
      'Read,Glob,Grep',
    ],
    {
      cwd,
      input: buildGatePrompt(candidates),
      encoding: 'utf-8',
      timeout: GATE_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, TOM_SWE_INTERNAL: '1' },
    }
  )

  if (proc.error || proc.status !== 0) {
    return null
  }

  let resultText: string
  try {
    const wrapper = JSON.parse(proc.stdout) as Record<string, unknown>
    resultText = typeof wrapper['result'] === 'string' ? wrapper['result'] : proc.stdout
  } catch {
    resultText = proc.stdout
  }

  const ids = extractJsonArray(resultText)
  if (ids === null) {
    return null
  }

  const candidateIds = new Set(candidates.map((c) => c.id))
  return new Set(ids.filter((id) => candidateIds.has(id)))
}
