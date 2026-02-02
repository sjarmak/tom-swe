/**
 * BM25 search index and query engine for ToM memory tiers.
 * Zero external dependencies — implements Okapi BM25 from scratch.
 */

// --- Public types ---

export interface BM25Document {
  readonly id: string
  readonly content: string
  readonly tier: 1 | 2 | 3
}

export interface BM25SearchResult {
  readonly id: string
  readonly score: number
}

export interface BM25Index {
  readonly documentCount: number
  readonly avgDocLength: number
  readonly docs: ReadonlyArray<IndexedDoc>
  readonly idf: Readonly<Record<string, number>>
}

// --- Internal types ---

interface IndexedDoc {
  readonly id: string
  readonly tier: 1 | 2 | 3
  readonly length: number
  readonly termFreqs: Readonly<Record<string, number>>
}

// --- BM25 parameters ---

const K1 = 1.2
const B = 0.75

// Tier weighting: Tier 3 = 3x, Tier 2 = 2x, Tier 1 = 1x
const TIER_WEIGHTS: Readonly<Record<number, number>> = {
  1: 1,
  2: 2,
  3: 3,
}

// --- Tokenization ---

function tokenize(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter(token => token.length > 0)
}

function computeTermFreqs(tokens: readonly string[]): Record<string, number> {
  const freqs: Record<string, number> = {}
  for (const token of tokens) {
    freqs[token] = (freqs[token] ?? 0) + 1
  }
  return freqs
}

// --- Index building ---

export function buildIndex(documents: readonly BM25Document[]): BM25Index {
  if (documents.length === 0) {
    return { documentCount: 0, avgDocLength: 0, docs: [], idf: {} }
  }

  const indexedDocs: IndexedDoc[] = []
  const docFreqs: Record<string, number> = {}
  let totalLength = 0

  for (const doc of documents) {
    const tokens = tokenize(doc.content)
    const termFreqs = computeTermFreqs(tokens)

    indexedDocs.push({
      id: doc.id,
      tier: doc.tier,
      length: tokens.length,
      termFreqs,
    })

    totalLength += tokens.length

    // Count document frequency for each unique term
    for (const term of Object.keys(termFreqs)) {
      docFreqs[term] = (docFreqs[term] ?? 0) + 1
    }
  }

  const n = documents.length
  const avgDocLength = totalLength / n

  // Compute IDF for each term
  const idf: Record<string, number> = {}
  for (const [term, df] of Object.entries(docFreqs)) {
    // Standard BM25 IDF formula
    idf[term] = Math.log((n - df + 0.5) / (df + 0.5) + 1)
  }

  return {
    documentCount: n,
    avgDocLength,
    docs: indexedDocs,
    idf,
  }
}

// --- Search ---

export function search(
  index: BM25Index,
  query: string,
  k: number = 3,
): readonly BM25SearchResult[] {
  if (index.documentCount === 0) {
    return []
  }

  const queryTokens = tokenize(query)

  if (queryTokens.length === 0) {
    return []
  }

  const scored: BM25SearchResult[] = []

  for (const doc of index.docs) {
    let score = 0

    for (const token of queryTokens) {
      const tf = doc.termFreqs[token] ?? 0
      if (tf === 0) continue

      const idfValue = index.idf[token] ?? 0
      // BM25 term score
      const numerator = tf * (K1 + 1)
      const denominator = tf + K1 * (1 - B + B * (doc.length / index.avgDocLength))
      score += idfValue * (numerator / denominator)
    }

    if (score > 0) {
      // Apply tier weighting
      const tierWeight = TIER_WEIGHTS[doc.tier] ?? 1
      scored.push({
        id: doc.id,
        score: score * tierWeight,
      })
    }
  }

  // Sort descending by score, take top-k
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, k)
}
