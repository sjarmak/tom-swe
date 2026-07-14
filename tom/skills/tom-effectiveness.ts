/**
 * /tom-effectiveness skill — reports whether preferences ToM ASSERTS (injected
 * at SessionStart or surfaced by an ambiguity-consultation) survive the session
 * un-corrected (followed through / confirmed) or get overridden (corrected).
 *
 * Reads usage.log via readUsageLog() and renders the follow-through rollup.
 * See follow-through.ts for the metric definition and its confounds. (The old
 * CLAUDE.md-promotion effectiveness metric was retired with the promotion
 * feature — tom-swe-x1m.2/.3.)
 */

import { readUsageLog } from '../routing.js'
import {
  computeFollowThroughSummary,
  formatFollowThrough,
} from '../follow-through.js'

export function main(): void {
  const usage = readUsageLog()
  const lines = formatFollowThrough(computeFollowThroughSummary(usage.entries))
  const output =
    lines.length > 0
      ? lines.join('\n')
      : 'No follow-through telemetry recorded yet. ToM populates this after it ' +
        'has injected preferences and analyzed corrections across several sessions.'
  process.stdout.write(output)
}

if (require.main === module) {
  main()
}
