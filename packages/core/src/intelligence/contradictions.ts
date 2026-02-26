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

// Negation patterns for sentence-level contradiction detection
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
  /\babandoned\b/i,
  /\bswitched from\b/i,
  /\bmigrated away\b/i,
];

// Value change patterns — "X is A" vs "X is B"
const VALUE_PATTERN = /\b(?:is|are|was|were|use|using|prefer|chose|switched to|moved to|now)\s+(.{5,40})\b/gi;

// Max sentences to check per memory (focus on opening claims)
const CLAIM_SENTENCES_LIMIT = 10;

// Minimum word overlap between sentences to consider them about the same subject
const SUBJECT_OVERLAP_THRESHOLD = 0.3;

// Stopwords excluded from word overlap calculation
const OVERLAP_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "it", "that", "this", "was", "are",
  "be", "has", "had", "have", "not", "no", "can", "will", "do", "did",
  "should", "would", "could", "may", "might", "we", "you", "he", "she",
  "they", "its", "our", "my", "your", "all", "each", "some", "than",
  "too", "very", "just", "also", "been", "being", "into", "out", "so",
  "then", "there", "these", "those", "when", "where", "which", "while",
  "who", "how", "what", "new", "use", "used", "using", "one", "two",
]);

/**
 * Detect potential contradictions between semantically similar memories.
 * Looks for high similarity (same topic) combined with negation patterns
 * or value changes that suggest conflicting information.
 */
export function detectContradictions(
  db: DatabaseSync,
  options: { similarityThreshold?: number; maxMemories?: number } = {}
): ContradictionCandidate[] {
  const threshold = options.similarityThreshold ?? 0.82;
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
        embedding: new Float32Array(new Uint8Array(bytes).buffer),
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

      // High similarity — sentence-level contradiction analysis
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
  // Skip consolidated summaries — meta-memories that reference many topics
  if (
    contentA.startsWith("[Consolidated") ||
    contentB.startsWith("[Consolidated")
  ) {
    return null;
  }

  const sentencesA = extractSentences(contentA).slice(0, CLAIM_SENTENCES_LIMIT);
  const sentencesB = extractSentences(contentB).slice(0, CLAIM_SENTENCES_LIMIT);

  if (sentencesA.length === 0 || sentencesB.length === 0) return null;

  // Sentence-level negation contradiction: one sentence affirms, the other
  // negates, and both are about the same subject (high word overlap)
  for (const sA of sentencesA) {
    const aNeg = NEGATION_PATTERNS.some((p) => p.test(sA));
    for (const sB of sentencesB) {
      const bNeg = NEGATION_PATTERNS.some((p) => p.test(sB));
      if (aNeg === bNeg) continue;

      if (wordOverlap(sA, sB) < SUBJECT_OVERLAP_THRESHOLD) continue;

      const affSentence = aNeg ? sB : sA;
      const negSentence = aNeg ? sA : sB;
      return `negation conflict: "${truncSentence(affSentence)}" vs "${truncSentence(negSentence)}"`;
    }
  }

  // Value changes on the same subject — require sentence overlap
  for (const sA of sentencesA) {
    const aVals = extractValues(sA);
    if (aVals.length === 0) continue;

    for (const sB of sentencesB) {
      if (wordOverlap(sA, sB) < SUBJECT_OVERLAP_THRESHOLD) continue;

      const bVals = extractValues(sB);
      for (const [, aV] of aVals) {
        for (const [, bV] of bVals) {
          if (
            aV.toLowerCase() !== bV.toLowerCase() &&
            aV.length >= 5 &&
            bV.length >= 5
          ) {
            return `value change: "${aV.trim()}" vs "${bV.trim()}"`;
          }
        }
      }
    }
  }

  return null;
}

/**
 * Split text into sentence-like chunks for pairwise comparison.
 * Handles markdown bullets, headers, and regular prose.
 */
function extractSentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => {
      // Further split long lines on sentence boundaries
      if (line.length > 200) {
        return line.split(/(?<=[.!?])\s+/);
      }
      return [line];
    })
    .map((s) => s.replace(/^[\s\-*>#]+/, "").trim())
    .filter((s) => s.length >= 10 && s.length <= 500);
}

/**
 * Compute word overlap between two sentences (Jaccard-like).
 * Returns ratio of shared content words to the smaller set size.
 */
function wordOverlap(a: string, b: string): number {
  const wordsA = new Set(
    a
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length >= 3 && !OVERLAP_STOPWORDS.has(w))
  );
  const wordsB = new Set(
    b
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length >= 3 && !OVERLAP_STOPWORDS.has(w))
  );

  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let shared = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) shared++;
  }

  return shared / Math.min(wordsA.size, wordsB.size);
}

function truncSentence(s: string): string {
  const clean = s.replace(/\n/g, " ").trim();
  if (clean.length <= 80) return clean;
  return clean.substring(0, 77) + "...";
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
export interface AutoDismissResult {
  dismissed: number;
  reasons: Record<string, number>;
}

/**
 * Auto-dismiss low-signal contradictions in bulk.
 * Identifies false positives from deleted sources, consolidation artifacts,
 * low-quality pairs, and trivial version/date changes.
 */
export function autoDismissContradictions(
  db: DatabaseSync,
  opts: { dryRun?: boolean } = {}
): AutoDismissResult {
  const pending = db
    .prepare(
      `SELECT c.id, c.memory_a_id, c.memory_b_id, c.description
       FROM contradictions c
       WHERE c.status = 'pending'`
    )
    .all() as unknown as Array<{
    id: string;
    memory_a_id: string;
    memory_b_id: string;
    description: string;
  }>;

  const reasons: Record<string, number> = {};
  let dismissed = 0;

  for (const c of pending) {
    const memA = db
      .prepare("SELECT id, content, is_active, quality_score FROM memories WHERE id = ?")
      .get(c.memory_a_id) as
      | { id: string; content: string; is_active: number; quality_score: number | null }
      | undefined;
    const memB = db
      .prepare("SELECT id, content, is_active, quality_score FROM memories WHERE id = ?")
      .get(c.memory_b_id) as
      | { id: string; content: string; is_active: number; quality_score: number | null }
      | undefined;

    let reason: string | null = null;

    // 1. Deleted source — either memory is gone or inactive
    if (!memA || !memB || memA.is_active === 0 || memB.is_active === 0) {
      reason = "deleted_source";
    }

    // 2. Consolidation artifact
    if (!reason && memA && memB) {
      if (memA.content.startsWith("[Consolidated") || memB.content.startsWith("[Consolidated")) {
        reason = "consolidation_artifact";
      }
    }

    // 3. Low quality — both below 0.20
    if (!reason && memA && memB) {
      const qA = memA.quality_score ?? 1;
      const qB = memB.quality_score ?? 1;
      if (qA < 0.20 && qB < 0.20) {
        reason = "low_quality";
      }
    }

    // 4. Version/date value change
    if (!reason && c.description.startsWith("value change:")) {
      const VERSION_OR_DATE = /^\d+\.\d+|\d{4}-\d{2}/;
      const match = c.description.match(/value change:\s*"([^"]+)"\s*vs\s*"([^"]+)"/);
      if (match) {
        const [, valA, valB] = match;
        if (VERSION_OR_DATE.test(valA.trim()) && VERSION_OR_DATE.test(valB.trim())) {
          reason = "version_date_change";
        }
      }
    }

    if (reason) {
      if (!opts.dryRun) {
        updateContradiction(db, c.id, {
          status: "dismissed",
          resolution: `auto-dismissed: ${reason}`,
        });
      }
      reasons[reason] = (reasons[reason] ?? 0) + 1;
      dismissed++;
    }
  }

  return { dismissed, reasons };
}

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
