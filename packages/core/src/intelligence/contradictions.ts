import type { DatabaseSync } from "node:sqlite";
import { ulid } from "ulid";
import { cosineSimilarity } from "../memory/scoring.js";
import type { MemoryRow } from "../memory/types.js";

export interface Contradiction {
  id: string;
  memory_a_id: string;
  memory_b_id: string;
  description: string;
  status: "pending" | "resolved" | "dismissed";
  resolution: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContradictionCandidate {
  memory_a_id: string;
  memory_b_id: string;
  similarity: number;
  reason: string;
}

// Negation words that may indicate contradictory statements
const NEGATION_PATTERNS = [
  /\bnot\b/i,
  /\bnever\b/i,
  /\bno longer\b/i,
  /\bdon'?t\b/i,
  /\bdoesn'?t\b/i,
  /\bwon'?t\b/i,
  /\bcan'?t\b/i,
  /\bisn'?t\b/i,
  /\baren'?t\b/i,
  /\bwasn'?t\b/i,
  /\bweren'?t\b/i,
  /\bstopped\b/i,
  /\bquit\b/i,
  /\bleft\b/i,
  /\babandoned\b/i,
  /\bremoved\b/i,
  /\bdeprecated\b/i,
  /\breplaced\b/i,
  /\bswitched from\b/i,
  /\bmigrated away\b/i,
];

// Value change patterns — "X is A" vs "X is B"
const VALUE_PATTERN = /\b(?:is|are|was|were|use|using|prefer|chose|switched to|moved to|now)\s+(.{3,40})\b/gi;

/**
 * Detect potential contradictions between semantically similar memories.
 * Looks for high similarity (same topic) combined with negation patterns
 * or value changes that suggest conflicting information.
 */
export function detectContradictions(
  db: DatabaseSync,
  options: { similarityThreshold?: number; maxMemories?: number } = {}
): ContradictionCandidate[] {
  const threshold = options.similarityThreshold ?? 0.7;
  const maxMemories = options.maxMemories ?? 300;

  // Get active memories with embeddings
  const rows = db
    .prepare(
      `SELECT id, content, embedding, created_at FROM memories
       WHERE is_active = 1 AND embedding IS NOT NULL
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(maxMemories) as unknown as MemoryRow[];

  const memories = rows
    .filter((r) => r.embedding)
    .map((r) => {
      const bytes = r.embedding as unknown as Uint8Array;
      return {
        id: r.id,
        content: r.content,
        created_at: r.created_at,
        embedding: new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
      };
    });

  // Get existing contradiction pairs to avoid duplicates
  const existingPairs = new Set<string>();
  const existingRows = db
    .prepare("SELECT memory_a_id, memory_b_id FROM contradictions")
    .all() as unknown as Array<{ memory_a_id: string; memory_b_id: string }>;
  for (const r of existingRows) {
    existingPairs.add(`${r.memory_a_id}:${r.memory_b_id}`);
    existingPairs.add(`${r.memory_b_id}:${r.memory_a_id}`);
  }

  const candidates: ContradictionCandidate[] = [];

  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const a = memories[i];
      const b = memories[j];

      // Skip existing pairs
      if (existingPairs.has(`${a.id}:${b.id}`)) continue;

      const sim = cosineSimilarity(a.embedding, b.embedding);
      if (sim < threshold) continue;

      // High similarity — check for contradictory signals
      const reason = findContradictionReason(a.content, b.content);
      if (reason) {
        candidates.push({
          memory_a_id: a.id,
          memory_b_id: b.id,
          similarity: sim,
          reason,
        });
      }
    }
  }

  return candidates.sort((a, b) => b.similarity - a.similarity);
}

function findContradictionReason(contentA: string, contentB: string): string | null {
  // Check if one has negation of the other's key claim
  const aNeg = NEGATION_PATTERNS.some((p) => p.test(contentA));
  const bNeg = NEGATION_PATTERNS.some((p) => p.test(contentB));

  if (aNeg !== bNeg) {
    return "One statement contains negation while the other affirms (possible contradiction)";
  }

  // Check for value changes — both mention the same subject with different values
  const aValues = extractValues(contentA);
  const bValues = extractValues(contentB);

  for (const [, aVal] of aValues) {
    for (const [, bVal] of bValues) {
      // Same pattern but different values
      if (aVal.toLowerCase() !== bVal.toLowerCase() && aVal.length > 3 && bVal.length > 3) {
        return `Possible value change: "${aVal.trim()}" vs "${bVal.trim()}"`;
      }
    }
  }

  return null;
}

function extractValues(text: string): Array<[string, string]> {
  const results: Array<[string, string]> = [];
  const pattern = new RegExp(VALUE_PATTERN.source, "gi");
  let match;
  while ((match = pattern.exec(text)) !== null) {
    results.push([match[0], match[1]]);
  }
  return results;
}

/**
 * Record a detected contradiction in the database.
 */
export function recordContradiction(
  db: DatabaseSync,
  candidate: ContradictionCandidate
): Contradiction {
  const id = ulid();
  const now = new Date().toISOString().replace("T", " ").replace("Z", "");

  db.prepare(
    `INSERT INTO contradictions (id, memory_a_id, memory_b_id, description, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)`
  ).run(id, candidate.memory_a_id, candidate.memory_b_id, candidate.reason, now, now);

  return {
    id,
    memory_a_id: candidate.memory_a_id,
    memory_b_id: candidate.memory_b_id,
    description: candidate.reason,
    status: "pending",
    resolution: null,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Get contradictions with optional status filter.
 */
export function getContradictions(
  db: DatabaseSync,
  status?: "pending" | "resolved" | "dismissed",
  limit = 50
): Contradiction[] {
  let sql = "SELECT * FROM contradictions";
  const params: (string | number)[] = [];

  if (status) {
    sql += " WHERE status = ?";
    params.push(status);
  }

  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(limit);

  return db.prepare(sql).all(...params) as unknown as Contradiction[];
}

/**
 * Update a contradiction's status and optional resolution.
 */
export function updateContradiction(
  db: DatabaseSync,
  id: string,
  update: { status?: "pending" | "resolved" | "dismissed"; resolution?: string }
): Contradiction | null {
  const existing = db
    .prepare("SELECT * FROM contradictions WHERE id = ?")
    .get(id) as unknown as Contradiction | undefined;

  if (!existing) return null;

  const now = new Date().toISOString().replace("T", " ").replace("Z", "");
  const sets: string[] = ["updated_at = ?"];
  const params: (string | number)[] = [now];

  if (update.status) {
    sets.push("status = ?");
    params.push(update.status);
  }
  if (update.resolution !== undefined) {
    sets.push("resolution = ?");
    params.push(update.resolution);
  }

  params.push(id);
  db.prepare(`UPDATE contradictions SET ${sets.join(", ")} WHERE id = ?`).run(...params);

  return db.prepare("SELECT * FROM contradictions WHERE id = ?").get(id) as unknown as Contradiction;
}
