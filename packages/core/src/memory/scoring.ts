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
  valence: number;
  quality: number;
  goalGated: number;
}

/** Parse a float setting with NaN guard, falling back to the default. */
function safeFloat(raw: string | null | undefined, fallback: number): number {
  const v = parseFloat(raw ?? String(fallback));
  return Number.isFinite(v) ? v : fallback;
}

export function getWeights(db: DatabaseSync): ScoringWeights {
  return {
    vector: safeFloat(getSetting(db, "scoring.vector_weight"), 0.45),
    fts: safeFloat(getSetting(db, "scoring.fts_weight"), 0.25),
    recency: safeFloat(getSetting(db, "scoring.recency_weight"), 0.20),
    frequency: safeFloat(getSetting(db, "scoring.frequency_weight"), 0.10),
    recencyDecay: safeFloat(getSetting(db, "scoring.recency_decay"), 0.05),
    graph: safeFloat(getSetting(db, "scoring.graph_weight"), 0.10),
    usefulness: safeFloat(getSetting(db, "scoring.usefulness_weight"), 0.05),
    valence: safeFloat(getSetting(db, "scoring.valence_weight"), 0.05),
    quality: safeFloat(getSetting(db, "scoring.quality_weight"), 0.10),
    goalGated: safeFloat(getSetting(db, "scoring.goal_gated_weight"), 0.15),
  };
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// --- SCORING SYSTEM START ---
// Everything between these markers is in-scope for sentinel:code-evolve.
export function recencyScore(
  createdAt: string,
  decayRate: number,
  importance?: number,
  quality?: number
): number {
  const now = Date.now();
  const created = new Date(createdAt + (createdAt.includes("Z") ? "" : "Z")).getTime();
  if (!Number.isFinite(created)) return 0;
  const daysSince = (now - created) / (1000 * 60 * 60 * 24);

  // Use quality as the dampening signal when available; fall back to importance.
  // High-quality memories decay slower: effective rate is reduced by up to 50%
  // quality=1.0 → multiplier=0.5 (half the decay rate)
  // quality=0.5 → multiplier=0.75
  // quality=0.0 or undefined → multiplier=1.0 (default rate)
  const signal = quality ?? importance ?? 0;
  const multiplier = 1 - signal * 0.5;

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
 * Uses absolute scale: saturates at 8 useful signals → score 1.0.
 * Memories with 0 useful_count score 0 (no penalty, just no boost).
 */
export function usefulnessScore(usefulCount: number): number {
  if (usefulCount <= 0) return 0;
  return Math.min(1.0, Math.log(1 + usefulCount) / Math.log(1 + 8));
}

/**
 * Valence score: emotionally significant memories (positive or negative)
 * are more retrievable, like somatic markers in human cognition.
 * Uses absolute value — both breakthroughs (+1) and failures (-1) score high.
 */
export function valenceScore(valence: number): number {
  return Math.abs(valence);
}

/**
 * Goal relevance score: memories related to active goals surface more readily.
 * Conway's "working self" — current goals shape what gets retrieved.
 */
export function goalRelevanceScore(
  memoryTags: string[],
  goalKeywords: Set<string>,
  memoryContent?: string
): number {
  if (goalKeywords.size === 0) return 0;

  // Direct goal linkage — highest signal
  if (memoryTags.includes("goal-progress")) return 1.0;
  if (memoryTags.includes("goal-progress-implicit")) return 0.7;

  // Tag overlap with goal-derived keywords
  let matchCount = 0;
  for (const tag of memoryTags) {
    if (goalKeywords.has(tag)) matchCount++;
  }
  if (matchCount > 0) {
    // Normalize: 3+ matching tags = full relevance
    return Math.min(1.0, matchCount / Math.min(goalKeywords.size, 3));
  }

  // Content-based matching (weaker signal than tags, max 0.5)
  if (memoryContent) {
    const contentLower = memoryContent.toLowerCase();
    let contentMatches = 0;
    for (const kw of goalKeywords) {
      if (contentLower.includes(kw)) contentMatches++;
    }
    if (contentMatches >= 2) {
      return Math.min(0.5, contentMatches / Math.min(goalKeywords.size, 5));
    }
  }

  return 0;
}

/**
 * Composite quality score for a memory. Used by importance adjustment
 * to make boost/decay decisions based on multiple signals, not just access count.
 *
 * Weighted: 0.30 importance + 0.25 usefulness + 0.15 access + 0.15 links + 0.15 freshness
 */
export function qualityScore(
  importance: number,
  usefulCount: number,
  accessCount: number,
  linkCount: number,
  ageDays: number
): number {
  // Usefulness: saturates at 5
  const usefulness = usefulCount > 0 ? Math.min(1.0, Math.log(1 + usefulCount) / Math.log(6)) : 0;
  // Access: saturates at 20
  const access = accessCount > 0 ? Math.min(1.0, Math.log(1 + accessCount) / Math.log(21)) : 0;
  // Links: saturates at 5
  const links = linkCount > 0 ? Math.min(1.0, linkCount / 5) : 0;
  // Freshness: exponential decay over 90 days (clamp age to non-negative)
  const freshness = Math.exp(-0.02 * Math.max(0, ageDays));

  const score =
    0.30 * importance +
    0.25 * usefulness +
    0.15 * access +
    0.15 * links +
    0.15 * freshness;
  return Number.isFinite(score) ? score : 0;
}

export function computeHybridScore(
  vectorScore: number,
  ftsScore: number,
  recency: number,
  frequency: number,
  weights: ScoringWeights
): number {
  // Freshness and popularity should strengthen relevant matches, not create them.
  // Gate secondary boosts by the stronger retrieval signal so weak semantic/FTS
  // matches do not outrank better evidence just because they are newer or popular.
  const relevanceGate = Math.max(0, Math.max(vectorScore, ftsScore));
  const secondaryBoostWeight =
    relevanceGate === 0 ? 0 : Math.min(1, 0.25 + relevanceGate * 0.75);

  return (
    weights.vector * vectorScore +
    weights.fts * ftsScore +
    secondaryBoostWeight * (
      weights.recency * recency +
      weights.frequency * frequency
    )
  );
}
/**
 * Tier-based retrieval boost. Higher-tier knowledge gets a scoring advantage.
 * Working memories are penalized in general search to avoid session noise.
 */
export function tierBoost(tier: string): number {
  switch (tier) {
    case "semantic": return 0.15;
    case "procedural": return 0.10;
    case "reference": return 0.05;
    case "working": return -0.10;
    default: return 0; // episodic = neutral
  }
}

// --- SCORING SYSTEM END ---

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
    const sorted = [...list.entries].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    for (let rank = 0; rank < sorted.length; rank++) {
      const entry = sorted[rank];
      const rrf = list.weight / (k + rank + 1); // rank+1 because ranks are 1-based
      scores.set(entry.id, (scores.get(entry.id) ?? 0) + rrf);
    }
  }

  return scores;
}
