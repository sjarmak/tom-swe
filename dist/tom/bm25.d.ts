/**
 * BM25 search index and query engine for ToM memory tiers.
 * Zero external dependencies — implements Okapi BM25 from scratch.
 */
export interface BM25Document {
    readonly id: string;
    readonly content: string;
    readonly tier: 1 | 2 | 3;
}
export interface BM25SearchResult {
    readonly id: string;
    readonly score: number;
}
export interface BM25Index {
    readonly documentCount: number;
    readonly avgDocLength: number;
    readonly docs: ReadonlyArray<IndexedDoc>;
    readonly idf: Readonly<Record<string, number>>;
}
interface IndexedDoc {
    readonly id: string;
    readonly tier: 1 | 2 | 3;
    readonly length: number;
    readonly termFreqs: Readonly<Record<string, number>>;
}
export declare function buildIndex(documents: readonly BM25Document[]): BM25Index;
export declare function search(index: BM25Index, query: string, k?: number): readonly BM25SearchResult[];
export {};
//# sourceMappingURL=bm25.d.ts.map