/**
 * Vocabulary-anchoring echo measurement.
 *
 * The analysis prompt injects the current preference vocabulary and instructs
 * the analyzer to REUSE those exact keys and values — that reuse is how a
 * preference reinforces across sessions. The risk of anchoring is the model
 * echoing an injected key+value the session did not actually exhibit, so
 * confidence accrues to a preference the current session is no evidence for.
 *
 * This is the instrument, not a mitigation: it counts, mechanically, how much
 * of what the analyzer returned is a verbatim echo of what we fed it. Whether
 * a given echo is genuine reinforcement or anchoring noise is a semantic
 * judgment left to humans / downstream analysis (see the ZFC boundary) — the
 * measurement only surfaces the rate so a prompt change can be evaluated
 * against a real baseline rather than a hunch.
 */

import type { SessionModel } from './schemas.js'
import type { VocabularyEntry } from './llm-analyze.js'

export interface VocabularyEchoCounts {
  /** Vocabulary entries shown to the analyzer this run. */
  readonly injected: number
  /**
   * Keyed preference entries the analyzer returned. Legacy bare-string
   * entries have no key/value to match a vocabulary entry and are excluded
   * from the denominator.
   */
  readonly returned: number
  /**
   * Returned entries whose category + key + value exactly matches an injected
   * entry — a verbatim echo of what the analyzer was shown.
   */
  readonly echoedKeyValue: number
  /**
   * Returned entries whose category + key matches an injected entry
   * regardless of value — key reuse, the intended reinforcement channel.
   * A superset of echoedKeyValue.
   */
  readonly echoedKey: number
}

// Composite ids via JSON.stringify of a tuple: injective and fully printable,
// so no magic separator can collide with model-authored category/key/value.
function keyId(category: string, key: string): string {
  return JSON.stringify([category, key])
}

function keyValueId(category: string, key: string, value: string): string {
  return JSON.stringify([category, key, value])
}

/**
 * Counts how many of the analyzer's returned preferences are verbatim echoes
 * of the injected vocabulary. Pure and deterministic — exact string match on
 * category/key/value, never a semantic judgment.
 *
 * The SessionModel splits preferences into two arrays that map to the two
 * vocabulary categories: interactionPatterns → interactionStyle,
 * codingPreferences → codingPreferences. An entry only echoes a vocabulary
 * entry in the SAME category.
 */
export function computeVocabularyEcho(
  vocabulary: readonly VocabularyEntry[],
  model: SessionModel
): VocabularyEchoCounts {
  const keyValueSet = new Set(
    vocabulary.map((v) => keyValueId(v.category, v.key, v.value))
  )
  const keySet = new Set(vocabulary.map((v) => keyId(v.category, v.key)))

  let returned = 0
  let echoedKeyValue = 0
  let echoedKey = 0

  const scan = (
    entries: readonly (string | { readonly key: string; readonly value: string })[],
    category: string
  ): void => {
    for (const entry of entries) {
      if (typeof entry === 'string') {
        continue // Legacy bare string: no key/value to compare.
      }
      returned++
      if (keyValueSet.has(keyValueId(category, entry.key, entry.value))) {
        echoedKeyValue++
      }
      if (keySet.has(keyId(category, entry.key))) {
        echoedKey++
      }
    }
  }

  scan(model.interactionPatterns, 'interactionStyle')
  scan(model.codingPreferences, 'codingPreferences')

  return { injected: vocabulary.length, returned, echoedKeyValue, echoedKey }
}
