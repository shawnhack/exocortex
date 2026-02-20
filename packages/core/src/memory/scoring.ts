import type { DatabaseSync } from "node:sqlite";
import { getSetting } from "../db/schema.js";

export interface ScoringWeights {
  vector: number;
  fts: number;
  recency: number;
  frequency: number;
  recencyDecay: number;
  graph: number;
  usefulness: number;
}

export function getWeights(db: DatabaseSync): ScoringWeights {
  return {
    vector: parseFloat(getSetting(db, "scoring.vector_weight") ?? "0.45"),
    fts: parseFloat(getSetting(db, "scoring.fts_weight") ?? "0.25"),
    recency: parseFloat(getSetting(db, "scoring.recency_weight") ?? "0.20"),
    frequency: parseFloat(getSetting(db, "scoring.frequency_weight") ?? "0.10"),
    recencyDecay: parseFloat(getSetting(db, "scoring.recency_decay") ?? "0.05"),
    graph: parseFloat(getSetting(db, "scoring.graph_weight") ?? "0.10"),
    usefulness: parseFloat(getSetting(db, "scoring.usefulness_weight") ?? "0.05"),
  };
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function recencyScore(
  createdAt: string,
  decayRate: number,
  importance?: number
): number {
  const now = Date.now();
  const created = new Date(createdAt + "Z").getTime();
  const daysSince = (now - created) / (1000 * 60 * 60 * 24);

  // High-importance memories decay slower: effective rate is reduced by up to 50%
  // importance=1.0 → multiplier=0.5 (half the decay rate)
  // importance=0.5 → multiplier=0.75
  // importance=0.0 or undefined → multiplier=1.0 (default rate)
  const imp = importance ?? 0;
  const multiplier = 1 - imp * 0.5;

  return Math.exp(-decayRate * multiplier * daysSince);
}

export function frequencyScore(
  accessCount: number,
  maxAccessCount: number
): number {
  if (maxAccessCount <= 0) return 0;
  return Math.log(1 + accessCount) / Math.log(1 + maxAccessCount);
}

/**
 * Usefulness score based on confirmed-useful retrievals.
 * Uses absolute scale: saturates at 5 useful signals → score 1.0.
 * Memories with 0 useful_count score 0 (no penalty, just no boost).
 */
export function usefulnessScore(usefulCount: number): number {
  if (usefulCount <= 0) return 0;
  return Math.min(1.0, Math.log(1 + usefulCount) / Math.log(1 + 5));
}

export function computeHybridScore(
  vectorScore: number,
  ftsScore: number,
  recency: number,
  frequency: number,
  weights: ScoringWeights
): number {
  return (
    weights.vector * vectorScore +
    weights.fts * ftsScore +
    weights.recency * recency +
    weights.frequency * frequency
  );
}

// --- Reciprocal Rank Fusion ---

export interface RRFConfig {
  k: number;       // rank smoothing constant (default 60)
  enabled: boolean; // whether to use RRF (default true)
}

export function getRRFConfig(db: DatabaseSync): RRFConfig {
  return {
    enabled: (getSetting(db, "scoring.use_rrf") ?? "true") === "true",
    k: parseInt(getSetting(db, "scoring.rrf_k") ?? "60", 10),
  };
}

export function reciprocalRankFusion(
  rankedLists: Array<{ entries: Array<{ id: string; score: number }>; weight: number }>,
  k: number
): Map<string, number> {
  const scores = new Map<string, number>();

  for (const list of rankedLists) {
    // Sort descending by score to get ranks
    const sorted = [...list.entries].sort((a, b) => b.score - a.score);
    for (let rank = 0; rank < sorted.length; rank++) {
      const entry = sorted[rank];
      const rrf = list.weight / (k + rank + 1); // rank+1 because ranks are 1-based
      scores.set(entry.id, (scores.get(entry.id) ?? 0) + rrf);
    }
  }

  return scores;
}
