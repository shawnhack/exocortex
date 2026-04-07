/**
 * Retrieval Benchmark — measure memory system recall and precision.
 *
 * Generates test queries from existing memories, then measures whether
 * the search system can retrieve the correct memory. This gives a
 * LongMemEval-style R@K metric for the exocortex retrieval pipeline.
 */

import type { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BenchmarkResult {
  /** Recall@5 — fraction of queries where the correct memory was in top 5 */
  recallAt5: number;
  /** Recall@10 */
  recallAt10: number;
  /** Mean Reciprocal Rank — average of 1/rank for each query */
  mrr: number;
  /** Total queries run */
  totalQueries: number;
  /** Individual query results */
  queries: QueryResult[];
  /** Time taken in ms */
  durationMs: number;
}

export interface QueryResult {
  query: string;
  targetId: string;
  /** Rank at which the target was found (0 = not found) */
  rank: number;
  /** Whether target was found in top 5 */
  foundAt5: boolean;
  /** Whether target was found in top 10 */
  foundAt10: boolean;
}

export interface BenchmarkOptions {
  /** Number of queries to generate (default 50) */
  numQueries?: number;
  /** Maximum results to check per query (default 10) */
  maxResults?: number;
  /** Filter to specific namespace */
  namespace?: string;
  /** Minimum memory importance to use as test target */
  minImportance?: number;
}

// ---------------------------------------------------------------------------
// Query generation — create test queries from existing memories
// ---------------------------------------------------------------------------

interface MemoryCandidate {
  id: string;
  content: string;
  importance: number;
  namespace: string | null;
  tags: string;
  embedding: Buffer | null;
}

/**
 * Generate a search query from a memory's content.
 * Extracts a natural-language question or key phrase that should find this memory.
 */
function generateQuery(memory: MemoryCandidate): string {
  const content = memory.content;
  const lines = content.split("\n").filter((l) => l.trim().length > 15);

  // Strategy 1: Use key phrases from the first substantive line
  const firstLine = lines.find((l) => {
    const t = l.trim();
    return !t.startsWith("#") && !t.startsWith("*") && !t.startsWith("-") && t.length > 20;
  });

  if (firstLine) {
    // Extract 3-6 word key phrase from the middle of the line
    const words = firstLine.trim().split(/\s+/);
    if (words.length > 6) {
      const start = Math.floor(words.length / 4);
      return words.slice(start, start + 5).join(" ");
    }
    return firstLine.trim().slice(0, 60);
  }

  // Strategy 2: Use tags as the query
  if (memory.tags) {
    const tags = memory.tags.split(",").filter(Boolean).slice(0, 3);
    return tags.join(" ");
  }

  // Strategy 3: First 40 chars
  return content.slice(0, 40).trim();
}

// ---------------------------------------------------------------------------
// Search function — uses the same pipeline as memory_search
// ---------------------------------------------------------------------------

function searchMemories(
  db: DatabaseSync,
  query: string,
  limit: number
): Array<{ id: string; score: number }> {
  // FTS search
  const ftsResults = db
    .prepare(
      `SELECT m.id, rank as score
       FROM memories_fts fts
       INNER JOIN memories m ON fts.rowid = m.rowid
       WHERE memories_fts MATCH ?
         AND m.is_active = 1
         AND m.parent_id IS NULL
       ORDER BY rank
       LIMIT ?`
    )
    .all(escapeFtsQuery(query), limit * 2) as unknown as Array<{ id: string; score: number }>;

  // Semantic search (if query embedding can be computed)
  // For benchmark purposes, we use FTS + keyword overlap as proxy
  // since we can't generate embeddings inline without the model

  // Simple keyword overlap scoring as supplementary signal
  const keywords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 3 && /^[a-z]+$/.test(w));
  const keywordResults: Array<{ id: string; score: number }> = [];

  if (keywords.length > 0) {
    // Use parameterized LIKE queries joined with UNION to avoid SQL injection
    for (const keyword of keywords.slice(0, 5)) {
      const rows = db
        .prepare(
          `SELECT m.id, m.importance as score FROM memories m
           WHERE m.is_active = 1 AND m.parent_id IS NULL
           AND m.content LIKE ?
           ORDER BY m.importance DESC
           LIMIT ?`
        )
        .all(`%${keyword}%`, limit) as unknown as Array<{ id: string; score: number }>;
      keywordResults.push(...rows);
    }
  }

  // Merge results via simple RRF
  const scores = new Map<string, number>();
  const k = 60; // RRF constant

  ftsResults.forEach((r, i) => {
    scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (k + i + 1));
  });
  keywordResults.forEach((r, i) => {
    scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (k + i + 1));
  });

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function escapeFtsQuery(query: string): string {
  // Remove FTS special characters and quote individual terms
  const words = query
    .replace(/['"*(){}[\]^~\\:]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && /^[a-zA-Z]/.test(w));
  if (words.length === 0) return '"memory"';
  return words.map((w) => `"${w}"`).join(" OR ");
}

// ---------------------------------------------------------------------------
// Main benchmark runner
// ---------------------------------------------------------------------------

export function runBenchmark(
  db: DatabaseSync,
  options: BenchmarkOptions = {}
): BenchmarkResult {
  const {
    numQueries = 50,
    maxResults = 10,
    namespace,
    minImportance = 0.4,
  } = options;

  const startTime = Date.now();

  // Select random high-importance memories as test targets
  const params: unknown[] = [minImportance];
  let nsClause = "";
  if (namespace) {
    nsClause = "AND m.namespace = ?";
    params.push(namespace);
  }
  params.push(numQueries);

  const candidates = db
    .prepare(
      `SELECT m.id, m.content, m.importance, m.namespace,
              COALESCE((SELECT GROUP_CONCAT(t.tag) FROM memory_tags t WHERE t.memory_id = m.id), '') as tags,
              m.embedding
       FROM memories m
       WHERE m.is_active = 1
         AND m.parent_id IS NULL
         AND length(m.content) > 100
         AND m.importance >= ?
         ${nsClause}
       ORDER BY RANDOM()
       LIMIT ?`
    )
    .all(...(params as string[])) as unknown as MemoryCandidate[];

  // Run queries
  const queryResults: QueryResult[] = [];

  for (const candidate of candidates) {
    const query = generateQuery(candidate);
    const results = searchMemories(db, query, maxResults);

    const rank = results.findIndex((r) => r.id === candidate.id) + 1; // 1-indexed, 0 = not found

    queryResults.push({
      query,
      targetId: candidate.id,
      rank: rank,
      foundAt5: rank > 0 && rank <= 5,
      foundAt10: rank > 0 && rank <= 10,
    });
  }

  // Compute metrics
  const foundAt5 = queryResults.filter((q) => q.foundAt5).length;
  const foundAt10 = queryResults.filter((q) => q.foundAt10).length;
  const total = queryResults.length;

  const mrr = total > 0
    ? queryResults.reduce((sum, q) => sum + (q.rank > 0 ? 1 / q.rank : 0), 0) / total
    : 0;

  return {
    recallAt5: total > 0 ? Math.round((foundAt5 / total) * 1000) / 10 : 0,
    recallAt10: total > 0 ? Math.round((foundAt10 / total) * 1000) / 10 : 0,
    mrr: Math.round(mrr * 1000) / 1000,
    totalQueries: total,
    queries: queryResults,
    durationMs: Date.now() - startTime,
  };
}
