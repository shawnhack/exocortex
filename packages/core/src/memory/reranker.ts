import type { DatabaseSync } from "node:sqlite";
import { getSetting } from "../db/schema.js";

/**
 * LLM-based re-ranking for search results (inspired by qmd).
 *
 * After hybrid retrieval produces a scored candidate list, the re-ranker
 * asks a cheap LLM to score each result's relevance to the query.
 * This catches cases where algorithmic scoring misranks results due to
 * vocabulary mismatch or missing context.
 */

export interface RerankerProvider {
  /**
   * Score each candidate's relevance to the query.
   * Returns scores in the same order as candidates, each 0-1.
   */
  rerank(query: string, candidates: string[]): Promise<number[]>;
}

export interface RerankedResult {
  index: number;
  rerankScore: number;
}

/**
 * Re-rank search results using an LLM provider.
 * Only processes the top N results (default 10) to control cost.
 * Returns indices sorted by re-rank score descending.
 */
export async function rerankResults(
  query: string,
  contents: string[],
  provider: RerankerProvider,
  maxCandidates = 10,
): Promise<RerankedResult[]> {
  const toRerank = contents.slice(0, maxCandidates);
  if (toRerank.length === 0) return [];

  // Truncate long content for the LLM call (save tokens)
  const truncated = toRerank.map(c => c.length > 500 ? c.slice(0, 500) + "..." : c);

  const scores = await provider.rerank(query, truncated);

  const results: RerankedResult[] = scores.map((score, i) => ({
    index: i,
    rerankScore: score,
  }));

  results.sort((a, b) => b.rerankScore - a.rerankScore);
  return results;
}

/**
 * Check if LLM re-ranking is enabled in settings.
 */
export function isRerankEnabled(db: DatabaseSync): boolean {
  return getSetting(db, "search.rerank_enabled") === "true";
}

/**
 * Get the max candidates setting for re-ranking.
 */
export function getRerankLimit(db: DatabaseSync): number {
  const raw = getSetting(db, "search.rerank_max_candidates");
  const parsed = parseInt(raw ?? "10", 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, 50)) : 10;
}
