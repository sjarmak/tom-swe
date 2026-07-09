import { describe, it, expect } from 'vitest'

import {
  assertedKeysForSession,
  splitFollowThrough,
  computeFollowThroughSummary,
  formatFollowThrough,
} from './follow-through'
import type { UsageLogEntry } from './routing'

function entry(
  partial: Partial<UsageLogEntry> & { operation: string; timestamp: string }
): UsageLogEntry {
  return {
    model: 'none',
    tokenCount: 0,
    ...partial,
  }
}

function injection(
  timestamp: string,
  sessionId: string,
  ...injectedKeys: string[]
): UsageLogEntry {
  return entry({
    operation: 'session-start-injection',
    timestamp,
    sessionId,
    detail: { chars: 100, lines: injectedKeys.length, preferences: injectedKeys.length, injectedKeys },
  })
}

function consultation(
  timestamp: string,
  sessionId: string,
  source: string,
  ...suggestionKeys: string[]
): UsageLogEntry {
  return entry({
    operation: 'ambiguity-consultation',
    timestamp,
    sessionId,
    detail: { score: 0.5, source, suggestionType: 'preference', suggestionKeys },
  })
}

function followThrough(
  timestamp: string,
  sessionId: string,
  asserted: string[],
  confirmed: string[],
  corrected: string[]
): UsageLogEntry {
  return entry({
    operation: 'preference-follow-through',
    timestamp,
    sessionId,
    detail: { asserted, confirmed, corrected },
  })
}

describe('assertedKeysForSession', () => {
  it('collects injected keys and user-model consultation keys for the session', () => {
    const entries = [
      injection('2026-07-01T00:00:00.000Z', 'S1', 'codingPreferences:language'),
      consultation(
        '2026-07-01T00:05:00.000Z',
        'S1',
        'user-model',
        'interactionStyle:verbosity'
      ),
    ]
    expect(assertedKeysForSession(entries, 'S1').sort()).toEqual([
      'codingPreferences:language',
      'interactionStyle:verbosity',
    ])
  })

  it('excludes bm25 consultation keys (provenance ids, never correctable)', () => {
    const entries = [
      consultation('2026-07-01T00:00:00.000Z', 'S1', 'bm25', 'session:abc', 'user-model'),
    ]
    expect(assertedKeysForSession(entries, 'S1')).toEqual([])
  })

  it('deduplicates a key asserted by both injection and consultation', () => {
    const entries = [
      injection('2026-07-01T00:00:00.000Z', 'S1', 'codingPreferences:language'),
      consultation(
        '2026-07-01T00:05:00.000Z',
        'S1',
        'user-model',
        'codingPreferences:language'
      ),
    ]
    expect(assertedKeysForSession(entries, 'S1')).toEqual(['codingPreferences:language'])
  })

  it('ignores events from other sessions', () => {
    const entries = [
      injection('2026-07-01T00:00:00.000Z', 'S1', 'codingPreferences:language'),
      injection('2026-07-01T00:00:00.000Z', 'S2', 'interactionStyle:verbosity'),
    ]
    expect(assertedKeysForSession(entries, 'S1')).toEqual(['codingPreferences:language'])
  })
})

describe('splitFollowThrough', () => {
  it('splits asserted keys into confirmed (uncorrected) and corrected', () => {
    const result = splitFollowThrough(
      ['codingPreferences:language', 'interactionStyle:verbosity'],
      ['codingPreferences:language']
    )
    expect(result.corrected).toEqual(['codingPreferences:language'])
    expect(result.confirmed).toEqual(['interactionStyle:verbosity'])
  })

  it('confirms every asserted key when no corrections occurred', () => {
    const result = splitFollowThrough(['a:b', 'c:d'], [])
    expect(result.confirmed).toEqual(['a:b', 'c:d'])
    expect(result.corrected).toEqual([])
  })

  it('ignores corrections on keys that were never asserted', () => {
    const result = splitFollowThrough(['a:b'], ['x:y'])
    expect(result.confirmed).toEqual(['a:b'])
    expect(result.corrected).toEqual([])
  })
})

describe('follow-through over a synthetic session (AC: one confirmed + one corrected)', () => {
  it('emits a session record splitting the two injected keys by outcome', () => {
    // Session S1 injects two preference keys; the user corrects one of them.
    const entries = [
      injection(
        '2026-07-01T00:00:00.000Z',
        'S1',
        'codingPreferences:language',
        'interactionStyle:verbosity'
      ),
    ]
    const asserted = assertedKeysForSession(entries, 'S1')
    const { confirmed, corrected } = splitFollowThrough(asserted, [
      'codingPreferences:language',
    ])
    expect(corrected).toEqual(['codingPreferences:language'])
    expect(confirmed).toEqual(['interactionStyle:verbosity'])
  })
})

describe('computeFollowThroughSummary', () => {
  it('reports no data for an empty log', () => {
    const summary = computeFollowThroughSummary([])
    expect(summary.hasData).toBe(false)
    expect(summary.analyses).toBe(0)
    expect(summary.followThroughRate).toBe(0)
  })

  it('counts the exposure unit as the analysis run, not the host session', () => {
    // The Stop analyzer re-runs per turn, so one host session can emit several
    // preference-follow-through records. The summary sums per record (per
    // analysis run) — matching preference-correction/promotion — rather than
    // deduping to one per sessionId.
    const entries = [
      followThrough('2026-07-01T00:00:00.000Z', 'same-session', ['a:b'], ['a:b'], []),
      followThrough('2026-07-01T01:00:00.000Z', 'same-session', ['a:b'], ['a:b'], []),
    ]
    const summary = computeFollowThroughSummary(entries)
    expect(summary.analyses).toBe(2)
    expect(summary.assertedKeys).toBe(2)
  })

  it('aggregates emitted follow-through records into a rate', () => {
    const entries = [
      followThrough(
        '2026-07-01T00:00:00.000Z',
        'S1',
        ['codingPreferences:language', 'interactionStyle:verbosity'],
        ['interactionStyle:verbosity'],
        ['codingPreferences:language']
      ),
      followThrough(
        '2026-07-02T00:00:00.000Z',
        'S2',
        ['codingPreferences:testing'],
        ['codingPreferences:testing'],
        []
      ),
    ]
    const summary = computeFollowThroughSummary(entries)
    expect(summary.hasData).toBe(true)
    expect(summary.analyses).toBe(2)
    expect(summary.assertedKeys).toBe(3)
    expect(summary.confirmedKeys).toBe(2)
    expect(summary.correctedKeys).toBe(1)
    // 2 confirmed / 3 asserted * 100
    expect(summary.followThroughRate).toBe(66.67)
  })
})

describe('formatFollowThrough', () => {
  it('returns an empty array when there is no data', () => {
    expect(formatFollowThrough(computeFollowThroughSummary([]))).toEqual([])
  })

  it('renders the follow-through rate and counts', () => {
    const entries = [
      followThrough(
        '2026-07-01T00:00:00.000Z',
        'S1',
        ['a:b', 'c:d'],
        ['a:b'],
        ['c:d']
      ),
    ]
    const lines = formatFollowThrough(computeFollowThroughSummary(entries))
    const text = lines.join('\n')
    expect(text).toContain('Follow-through')
    expect(text).toContain('50')
  })
})
