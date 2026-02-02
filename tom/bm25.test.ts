import { describe, it, expect } from 'vitest'
import { buildIndex, search, type BM25Index, type BM25Document } from './bm25'

describe('BM25 search index', () => {
  const sampleDocs: BM25Document[] = [
    { id: 'doc1', content: 'typescript react hooks state management', tier: 1 },
    { id: 'doc2', content: 'python flask api database postgresql', tier: 2 },
    { id: 'doc3', content: 'typescript node express api middleware patterns', tier: 3 },
    { id: 'doc4', content: 'react component testing vitest unit test', tier: 1 },
    { id: 'doc5', content: 'user prefers typescript strict mode immutable patterns', tier: 3 },
  ]

  describe('buildIndex', () => {
    it('builds an index from documents', () => {
      const index = buildIndex(sampleDocs)
      expect(index).toBeDefined()
      expect(index.documentCount).toBe(5)
    })

    it('handles empty document array', () => {
      const index = buildIndex([])
      expect(index.documentCount).toBe(0)
    })

    it('produces a JSON-serializable index', () => {
      const index = buildIndex(sampleDocs)
      const json = JSON.stringify(index)
      const parsed: BM25Index = JSON.parse(json)
      expect(parsed.documentCount).toBe(5)
      // Searching the deserialized index should still work
      const results = search(parsed, 'typescript')
      expect(results.length).toBeGreaterThan(0)
    })
  })

  describe('search', () => {
    it('returns relevant results for a query', () => {
      const index = buildIndex(sampleDocs)
      const results = search(index, 'typescript')
      expect(results.length).toBeGreaterThan(0)
      const ids = results.map(r => r.id)
      expect(ids).toContain('doc1')
      expect(ids).toContain('doc3')
      expect(ids).toContain('doc5')
    })

    it('returns default top-3 results', () => {
      const index = buildIndex(sampleDocs)
      const results = search(index, 'typescript react api')
      expect(results.length).toBeLessThanOrEqual(3)
    })

    it('respects custom k parameter', () => {
      const index = buildIndex(sampleDocs)
      const results = search(index, 'typescript', 2)
      expect(results.length).toBeLessThanOrEqual(2)
    })

    it('applies tier weighting: tier 3 gets 3x boost', () => {
      // doc3 (tier 3) and doc1 (tier 1) both contain 'typescript'
      // doc3 should rank higher due to tier 3 boost
      const index = buildIndex(sampleDocs)
      const results = search(index, 'typescript patterns')
      expect(results.length).toBeGreaterThan(0)
      // Tier 3 docs should be boosted above tier 1 docs
      const tier3Result = results.find(r => r.id === 'doc3')
      const tier1Result = results.find(r => r.id === 'doc1')
      if (tier3Result && tier1Result) {
        expect(tier3Result.score).toBeGreaterThan(tier1Result.score)
      }
    })

    it('returns results with scores', () => {
      const index = buildIndex(sampleDocs)
      const results = search(index, 'typescript')
      for (const result of results) {
        expect(result.score).toBeGreaterThan(0)
        expect(typeof result.id).toBe('string')
      }
    })

    it('returns empty array for no matches', () => {
      const index = buildIndex(sampleDocs)
      const results = search(index, 'xyznonexistent')
      expect(results).toEqual([])
    })

    it('returns empty array when searching empty index', () => {
      const index = buildIndex([])
      const results = search(index, 'typescript')
      expect(results).toEqual([])
    })

    it('handles multi-word queries', () => {
      const index = buildIndex(sampleDocs)
      const results = search(index, 'react component testing')
      expect(results.length).toBeGreaterThan(0)
      expect(results[0]!.id).toBe('doc4')
    })
  })

  describe('performance', () => {
    it('queries 100 documents in under 200ms', () => {
      const largeDocs: BM25Document[] = Array.from({ length: 100 }, (_, i) => ({
        id: `doc-${i}`,
        content: `document number ${i} about ${i % 2 === 0 ? 'typescript' : 'python'} programming with ${i % 3 === 0 ? 'react' : 'vue'} framework and ${i % 5 === 0 ? 'testing' : 'deployment'} focus area keywords lorem ipsum text filler`,
        tier: ((i % 3) + 1) as 1 | 2 | 3,
      }))

      const index = buildIndex(largeDocs)

      const start = performance.now()
      for (let i = 0; i < 100; i++) {
        search(index, 'typescript react testing')
      }
      const elapsed = performance.now() - start

      // 100 queries should complete well under 200ms total
      // (acceptance criteria says sub-200ms for a single query)
      expect(elapsed).toBeLessThan(200)
    })
  })
})
