/**
 * Tier 3 rebuild: fold every Tier 2 session model into a fresh user model.
 *
 * Why rebuild instead of incremental aggregation: the Stop hook fires on
 * every turn-end, not once per session, so incremental aggregation
 * re-reinforced the same session's preferences on every fire (observed in
 * dogfooding: 9 analyses across 4 real sessions inflated confidence ~2-3x
 * and triggered a premature promotion). A rebuild makes aggregation
 * idempotent by construction — re-analyzing a session REPLACES its
 * contribution because the latest Tier 2 model per session is the only one
 * that exists.
 *
 * Decay stays honest because each session model carries endedAt and the
 * fold passes it as the aggregation's asOf: inter-session gaps decay
 * exactly as they did when the sessions originally happened. Models
 * without endedAt (pre-upgrade) sort first and fold at their file order.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import type { SessionModel, UserModel } from './schemas.js'
import { SessionModelSchema } from './schemas.js'
import { globalTomDir, projectTomDir } from './memory-io.js'
import { aggregateSessionIntoModel } from './aggregation.js'

const EMPTY_MODEL: UserModel = {
  preferencesClusters: [],
  interactionStyleSummary: '',
  codingStyleSummary: '',
  projectOverrides: {},
}

function readSessionModels(scope: 'global' | 'project'): SessionModel[] {
  const dir = path.join(
    scope === 'global' ? globalTomDir() : projectTomDir(),
    'session-models'
  )

  let files: string[]
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }

  const models: SessionModel[] = []
  for (const file of files.sort()) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as unknown
      const parsed = SessionModelSchema.safeParse(raw)
      if (parsed.success) {
        models.push(parsed.data)
      }
    } catch {
      // Unreadable model: skip — a rebuild must tolerate partial stores.
    }
  }
  return models
}

/**
 * Rebuilds the user model from all Tier 2 session models in chronological
 * order (endedAt; models without one sort first in file order). Style
 * summaries are carried from the previous model — they are narrative
 * fields the fold does not produce.
 */
export function rebuildUserModelFromTier2(
  scope: 'global' | 'project',
  decayDays: number,
  correctionPenalty: number,
  previousModel: UserModel | null
): UserModel {
  const models = readSessionModels(scope)

  const sorted = [...models].sort((a, b) => {
    const aTime = a.endedAt ?? ''
    const bTime = b.endedAt ?? ''
    return aTime.localeCompare(bTime) || a.sessionId.localeCompare(b.sessionId)
  })

  let userModel: UserModel = {
    ...EMPTY_MODEL,
    interactionStyleSummary: previousModel?.interactionStyleSummary ?? '',
    codingStyleSummary: previousModel?.codingStyleSummary ?? '',
    projectOverrides: { ...(previousModel?.projectOverrides ?? {}) },
  }

  // Undated (pre-upgrade) models sort first; fold them at the earliest
  // dated endedAt so the fold stays monotonic. Folding them at wall-clock
  // "now" stamped lastUpdated later than every dated session's endedAt, so
  // later folds saw negative day gaps (anti-decay overflow).
  const earliestDated = sorted.find((s) => s.endedAt !== undefined)?.endedAt
  const undatedAsOf =
    earliestDated !== undefined ? new Date(earliestDated) : new Date()

  for (const session of sorted) {
    const asOf = session.endedAt !== undefined ? new Date(session.endedAt) : undatedAsOf
    userModel = aggregateSessionIntoModel(
      userModel,
      session,
      decayDays,
      correctionPenalty,
      asOf
    )
  }

  return userModel
}

/**
 * Carries promotion lifecycle state forward from the previous model onto a
 * rebuilt one (matching by category+key+value): the promoted flag and any
 * persisted derivability-gate rejection. Rebuilds start from Tier 2, which
 * knows nothing about promotion state; without this, every previously
 * promoted (or gate-rejected) preference would re-enter the derivability
 * gate — an LLM spawn — on every turn-end.
 */
export function carryPromotedFlags(
  rebuilt: UserModel,
  previous: UserModel | null
): UserModel {
  if (!previous) {
    return rebuilt
  }
  const carried = new Map(
    previous.preferencesClusters
      .filter((p) => p.promoted === true || p.gateRejectedValue !== undefined)
      .map((p) => [
        `${p.category}::${p.key}::${p.value}`,
        {
          ...(p.promoted === true ? { promoted: true as const } : {}),
          ...(p.gateRejectedValue !== undefined
            ? { gateRejectedValue: p.gateRejectedValue }
            : {}),
          ...(p.gateRejectedAt !== undefined
            ? { gateRejectedAt: p.gateRejectedAt }
            : {}),
        },
      ])
  )
  if (carried.size === 0) {
    return rebuilt
  }
  return {
    ...rebuilt,
    preferencesClusters: rebuilt.preferencesClusters.map((p) => {
      const state = carried.get(`${p.category}::${p.key}::${p.value}`)
      return state !== undefined ? { ...p, ...state } : p
    }),
  }
}
