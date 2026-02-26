import type { DatabaseSync } from "node:sqlite";
import { ulid } from "ulid";
import { cosineSimilarity } from "../memory/scoring.js";
import type { EmbeddingProvider } from "../embedding/types.js";
import type { MemoryRow } from "../memory/types.js";

export interface ConsolidationCluster {
  centroidId: string;
  memberIds: string[];
  avgSimilarity: number;
  topic: string;
}

export interface ConsolidationResult {
  clusters: ConsolidationCluster[];
  summariesCreated: number;
}

interface MemoryWithEmbedding {
  id: string;
  content: string;
  embedding: Float32Array;
  created_at: string;
  bucket?: string;
}

/**
 * Find clusters of semantically similar memories that could be consolidated.
 * Uses greedy agglomerative clustering with cosine similarity threshold.
 */
export function findClusters(
  db: DatabaseSync,
  options: {
    minSimilarity?: number;
    minClusterSize?: number;
    maxMemories?: number;
    timeBucket?: 'week' | 'month';
  } = {}
): ConsolidationCluster[] {
  const minSimilarity = options.minSimilarity ?? 0.80;
  const minClusterSize = options.minClusterSize ?? 2;
  const maxMemories = options.maxMemories ?? 500;

  // Build bucket column expression if time-constrained clustering is requested
  const bucketExpr = options.timeBucket === 'week'
    ? ", strftime('%Y-W%W', created_at) as bucket"
    : options.timeBucket === 'month'
      ? ", strftime('%Y-%m', created_at) as bucket"
      : '';

  // Get active memories with embeddings
  const rows = db
    .prepare(
      `SELECT id, content, embedding, created_at${bucketExpr} FROM memories
       WHERE is_active = 1 AND embedding IS NOT NULL AND parent_id IS NULL
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(maxMemories) as unknown as (MemoryRow & { bucket?: string })[];

  const memories: MemoryWithEmbedding[] = rows
    .filter((r) => r.embedding)
    .map((r) => {
      const bytes = r.embedding as unknown as Uint8Array;
      return {
        id: r.id,
        content: r.content,
        created_at: r.created_at,
        embedding: new Float32Array(new Uint8Array(bytes).buffer),
        bucket: r.bucket,
      };
    });

  if (memories.length < minClusterSize) return [];

  // Greedy clustering: pick unassigned memory, find all similar ones
  const assigned = new Set<string>();
  const clusters: ConsolidationCluster[] = [];

  for (const seed of memories) {
    if (assigned.has(seed.id)) continue;

    const members: MemoryWithEmbedding[] = [seed];
    let totalSimilarity = 0;
    let simCount = 0;

    for (const candidate of memories) {
      if (candidate.id === seed.id || assigned.has(candidate.id)) continue;

      // Skip candidates in different time buckets when time-constrained
      if (options.timeBucket && seed.bucket && candidate.bucket !== seed.bucket) continue;

      const sim = cosineSimilarity(seed.embedding, candidate.embedding);
      if (sim >= minSimilarity) {
        members.push(candidate);
        totalSimilarity += sim;
        simCount++;
      }
    }

    if (members.length >= minClusterSize) {
      for (const m of members) assigned.add(m.id);

      // Extract topic from first few words of the centroid content
      const topic = seed.content.slice(0, 80).replace(/\s+/g, " ").trim();

      clusters.push({
        centroidId: seed.id,
        memberIds: members.map((m) => m.id),
        avgSimilarity: simCount > 0 ? totalSimilarity / simCount : 1,
        topic: topic.length < seed.content.length ? topic + "..." : topic,
      });
    }
  }

  return clusters;
}

/**
 * Consolidate a cluster by creating a summary memory and recording the consolidation.
 * The source memories are archived and linked via parent_id and consolidations table.
 * Optionally embeds the summary and propagates tags from source memories.
 */
export async function consolidateCluster(
  db: DatabaseSync,
  cluster: ConsolidationCluster,
  summaryContent: string,
  embeddingProvider?: EmbeddingProvider
): Promise<string> {
  const summaryId = ulid();
  const consolidationId = ulid();
  const now = new Date().toISOString().replace("T", " ").replace("Z", "");

  // Embed the summary if provider available
  let embeddingBlob: Uint8Array | null = null;
  if (embeddingProvider) {
    try {
      const embedding = await embeddingProvider.embed(summaryContent);
      embeddingBlob = new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    } catch {
      // Non-critical — store without embedding
    }
  }

  // Collect tags from source memories, filtering out identity tags that
  // lose meaning when merged into consolidated summaries
  const CONSOLIDATION_TAG_BLOCKLIST = new Set([
    "skill",
    "prompt-amendment",
    "goal-progress-implicit",
    "goal-progress",
    "benchmark-artifact",
  ]);
  const tagSet = new Set<string>();
  if (cluster.memberIds.length > 0) {
    const placeholders = cluster.memberIds.map(() => "?").join(",");
    const tagRows = db
      .prepare(`SELECT DISTINCT tag FROM memory_tags WHERE memory_id IN (${placeholders})`)
      .all(...cluster.memberIds) as Array<{ tag: string }>;
    for (const t of tagRows) {
      if (!CONSOLIDATION_TAG_BLOCKLIST.has(t.tag)) tagSet.add(t.tag);
    }
  }

  db.exec("BEGIN");
  try {
    // Create summary memory with optional embedding
    db.prepare(
      `INSERT INTO memories (id, content, content_type, source, embedding, importance, metadata, created_at, updated_at)
       VALUES (?, ?, 'summary', 'consolidation', ?, 0.8, ?, ?, ?)`
    ).run(
      summaryId,
      summaryContent,
      embeddingBlob,
      JSON.stringify({
        strategy: "similarity",
        source_count: cluster.memberIds.length,
        source_ids: cluster.memberIds,
      }),
      now,
      now
    );

    // Propagate tags to summary memory
    if (tagSet.size > 0) {
      const insertTag = db.prepare(
        "INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)"
      );
      for (const tag of tagSet) {
        insertTag.run(summaryId, tag);
      }
    }

    // Record consolidation
    db.prepare(
      `INSERT INTO consolidations (id, summary_id, source_ids, strategy, memories_merged, created_at)
       VALUES (?, ?, ?, 'similarity', ?, ?)`
    ).run(
      consolidationId,
      summaryId,
      JSON.stringify(cluster.memberIds),
      cluster.memberIds.length,
      now
    );

    // Link source memories via parent_id and archive them (is_active = 0)
    // so they don't compete with their summary in search results
    const updateSource = db.prepare(
      "UPDATE memories SET parent_id = ?, is_active = 0 WHERE id = ?"
    );
    for (const memberId of cluster.memberIds) {
      updateSource.run(summaryId, memberId);
    }

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return summaryId;
}

/**
 * Extract specific, retrievable details from text content.
 * Pulls file paths, versions, code tokens, dates, and numbers-with-units.
 */
function extractSpecifics(text: string): string[] {
  const specifics = new Set<string>();

  // File paths (Unix and Windows style)
  const pathMatches = text.match(/(?:[A-Z]:)?(?:\/[\w.-]+){2,}(?:\.\w+)?/gi);
  if (pathMatches) for (const p of pathMatches) specifics.add(p);

  // Version numbers (v1.2.3, 1.0.0, etc.)
  const versionMatches = text.match(/v?\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?/g);
  if (versionMatches) for (const v of versionMatches) specifics.add(v);

  // Code-like identifiers (camelCase, snake_case functions/variables)
  const codeMatches = text.match(/\b[a-z][a-zA-Z0-9]*(?:[A-Z][a-zA-Z0-9]*)+\b/g);
  if (codeMatches) for (const c of codeMatches) specifics.add(c);

  // Backtick-quoted code spans
  const backtickMatches = text.match(/`[^`]+`/g);
  if (backtickMatches) for (const b of backtickMatches) specifics.add(b);

  return Array.from(specifics);
}

// Patterns for identifying key facts
const KEY_FACT_PATTERNS = [
  /\b\d{4}[-/]\d{2}[-/]\d{2}\b/,           // dates
  /\b\d+(\.\d+)?%/,                          // percentages
  /\$[\d,.]+/,                                // dollar amounts
  /\b\d+(\.\d+)?\s*(ms|seconds?|minutes?|hours?|days?|GB|MB|KB|k|M)\b/i, // metrics
  /\b(decided|decision|chose|chosen|selected|resolved)\b/i,  // decision words
  /\b(architecture|design|pattern|approach|strategy|schema|migration)\b/i, // architecture
  /\b(bug|fix|error|issue|problem|broken|resolved)\b/i,      // issues
  /\b(added|removed|created|deleted|updated|changed|migrated)\b/i, // actions
];

/**
 * Generate a basic summary from cluster member contents.
 * Extracts key facts (dates, metrics, decisions, architecture) and separates
 * them from general context. Includes topic tags in summary header.
 */
export function generateBasicSummary(
  db: DatabaseSync,
  memberIds: string[]
): string {
  // Fetch content with tags
  const rows = db
    .prepare(
      `SELECT m.id, m.content, m.created_at FROM memories m
       WHERE m.id IN (${memberIds.map(() => "?").join(",")})
       ORDER BY m.created_at ASC`
    )
    .all(...memberIds) as unknown as Array<{ id: string; content: string; created_at: string }>;

  if (rows.length === 0) return "";

  // Batch-fetch tags for all members
  const tagSet = new Set<string>();
  if (memberIds.length > 0) {
    const placeholders = memberIds.map(() => "?").join(",");
    const tagRows = db
      .prepare(`SELECT tag FROM memory_tags WHERE memory_id IN (${placeholders})`)
      .all(...memberIds) as Array<{ tag: string }>;
    for (const t of tagRows) tagSet.add(t.tag);
  }

  const earliest = rows[0].created_at;
  const latest = rows[rows.length - 1].created_at;

  // Extract key facts, specifics, and context from all memories
  const keyFacts = new Set<string>();
  const contextPoints = new Set<string>();
  const allSpecifics = new Set<string>();

  for (const row of rows) {
    // Collect specifics
    for (const s of extractSpecifics(row.content)) allSpecifics.add(s);

    // Split into sentences
    const sentences = row.content
      .split(/[.!?]\n|[.!?]\s/)
      .map((s) => s.trim())
      .filter((s) => s.length > 10);

    for (const sentence of sentences) {
      const isKeyFact = KEY_FACT_PATTERNS.some((p) => p.test(sentence));
      if (isKeyFact) {
        keyFacts.add(sentence);
      } else {
        contextPoints.add(sentence);
      }
    }
  }

  // Build summary with word budget (~500 words)
  const WORD_BUDGET = 500;
  let wordCount = 0;

  const topicHeader = tagSet.size > 0
    ? ` — Topics: ${Array.from(tagSet).slice(0, 5).join(", ")}`
    : "";

  // 1. Topic sentence
  let summary = `[Consolidated summary of ${rows.length} memories from ${earliest} to ${latest}${topicHeader}]`;
  wordCount += summary.split(/\s+/).length;

  // 2. Key facts section
  if (keyFacts.size > 0) {
    summary += "\n\nKey facts:\n";
    for (const fact of keyFacts) {
      const factWords = fact.split(/\s+/).length;
      if (wordCount + factWords > WORD_BUDGET) break;
      summary += `- ${fact}\n`;
      wordCount += factWords;
    }
  }

  // 3. Specifics section (file paths, versions, code)
  if (allSpecifics.size > 0 && wordCount < WORD_BUDGET) {
    const specificsArr = Array.from(allSpecifics).slice(0, 10);
    summary += "\nSpecifics:\n";
    summary += `- ${specificsArr.join(", ")}\n`;
    wordCount += specificsArr.length;
  }

  // 4. Context section (fill remaining budget)
  if (contextPoints.size > 0 && wordCount < WORD_BUDGET) {
    summary += "\nContext:\n";
    for (const ctx of contextPoints) {
      const ctxWords = ctx.split(/\s+/).length;
      if (wordCount + ctxWords > WORD_BUDGET) break;
      summary += `- ${ctx}\n`;
      wordCount += ctxWords;
    }
  }

  return summary.trimEnd();
}

/**
 * Extract proper nouns from text (capitalized words not at sentence start).
 */
function extractProperNouns(text: string): Set<string> {
  const nouns = new Set<string>();
  const sentences = text.split(/[.!?]\s+/);
  for (const sentence of sentences) {
    // Skip the first word of each sentence
    const words = sentence.split(/\s+/).slice(1);
    for (const word of words) {
      if (/^[A-Z][a-z]+/.test(word) && word.length >= 3) {
        nouns.add(word);
      }
    }
  }
  return nouns;
}

/**
 * Validate that a consolidation summary preserves enough detail from sources.
 * Used to gate auto-consolidation — rejects summaries that lose too much.
 */
export function validateSummary(
  summaryContent: string,
  sourceContents: string[]
): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];

  // Relax minimum length for small clusters (2 members)
  const minLength = sourceContents.length <= 2 ? 80 : 100;
  if (summaryContent.length < minLength) {
    reasons.push(`Summary too short (${summaryContent.length} chars, min ${minLength})`);
  }

  // Check proper noun preservation (>= 50%)
  const sourceNouns = new Set<string>();
  for (const src of sourceContents) {
    for (const noun of extractProperNouns(src)) sourceNouns.add(noun);
  }

  if (sourceNouns.size > 0) {
    const summaryLower = summaryContent.toLowerCase();
    let preserved = 0;
    for (const noun of sourceNouns) {
      if (summaryLower.includes(noun.toLowerCase())) preserved++;
    }
    const ratio = preserved / sourceNouns.size;
    if (ratio < 0.5) {
      reasons.push(
        `Only ${Math.round(ratio * 100)}% of proper nouns preserved (${preserved}/${sourceNouns.size}, min 50%)`
      );
    }
  }

  return { valid: reasons.length === 0, reasons };
}

// --- Auto-consolidation (no LLM needed) ---

export interface AutoConsolidateResult {
  clustersFound: number;
  clustersConsolidated: number;
  memoriesMerged: number;
  summaryIds: string[];
}

/**
 * Automatically consolidate the top N clusters using basic summary generation.
 * Uses a higher similarity threshold (0.85) than manual consolidation to be conservative.
 * No LLM needed — uses generateBasicSummary for summaries.
 */
export async function autoConsolidate(
  db: DatabaseSync,
  embeddingProvider?: EmbeddingProvider,
  opts?: { maxClusters?: number; minSimilarity?: number; minClusterSize?: number }
): Promise<AutoConsolidateResult> {
  const maxClusters = opts?.maxClusters ?? 5;
  const minSimilarity = opts?.minSimilarity ?? 0.80;
  const minClusterSize = opts?.minClusterSize ?? 2;

  const clusters = findClusters(db, { minSimilarity, minClusterSize });

  if (clusters.length === 0) {
    return { clustersFound: 0, clustersConsolidated: 0, memoriesMerged: 0, summaryIds: [] };
  }

  const toProcess = clusters.slice(0, maxClusters);
  const summaryIds: string[] = [];
  let memoriesMerged = 0;

  for (const cluster of toProcess) {
    const summary = generateBasicSummary(db, cluster.memberIds);
    if (!summary) continue;

    // Validate summary quality before consolidating
    const sourceContents = db
      .prepare(
        `SELECT content FROM memories WHERE id IN (${cluster.memberIds.map(() => "?").join(",")})`
      )
      .all(...cluster.memberIds) as Array<{ content: string }>;
    const validation = validateSummary(summary, sourceContents.map((r) => r.content));
    if (!validation.valid) {
      console.warn(
        `[consolidation] Skipping cluster (${cluster.memberIds.length} members): ${validation.reasons.join("; ")}`
      );
      continue;
    }

    const summaryId = await consolidateCluster(db, cluster, summary, embeddingProvider);
    summaryIds.push(summaryId);
    memoriesMerged += cluster.memberIds.length;
  }

  return {
    clustersFound: clusters.length,
    clustersConsolidated: summaryIds.length,
    memoriesMerged,
    summaryIds,
  };
}

/**
 * Get consolidation history.
 */
export function getConsolidations(
  db: DatabaseSync,
  limit = 20
): Array<{
  id: string;
  summary_id: string;
  source_ids: string[];
  strategy: string;
  memories_merged: number;
  created_at: string;
}> {
  const rows = db
    .prepare("SELECT * FROM consolidations ORDER BY created_at DESC LIMIT ?")
    .all(limit) as unknown as Array<{
    id: string;
    summary_id: string;
    source_ids: string;
    strategy: string;
    memories_merged: number;
    created_at: string;
  }>;

  return rows.map((r) => ({
    ...r,
    source_ids: JSON.parse(r.source_ids),
  }));
}
