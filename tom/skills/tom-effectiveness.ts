/**
 * /tom-effectiveness skill — reports whether promoting a preference into
 * CLAUDE.md reduces how often it gets corrected, versus its pre-promotion life.
 *
 * Reads usage.log via readUsageLog() and renders the promotion-effectiveness
 * rollup. See effectiveness.ts for the metric definition and its confounds.
 */

import { readUsageLog } from '../routing.js'
import {
  computeEffectivenessSummary,
  formatEffectiveness,
} from '../effectiveness.js'
import {
  computeFollowThroughSummary,
  formatFollowThrough,
} from '../follow-through.js'

export function main(): void {
  const usage = readUsageLog()
  const lines = [
    ...formatEffectiveness(computeEffectivenessSummary(usage.entries)),
    ...formatFollowThrough(computeFollowThroughSummary(usage.entries)),
  ]
  const output =
    lines.length > 0
      ? lines.join('\n')
      : 'No promotion, correction, or follow-through telemetry recorded yet. ToM ' +
        'populates this after it has analyzed, injected, and promoted ' +
        'preferences across several sessions.'
  process.stdout.write(output)
}

if (require.main === module) {
  main()
}
