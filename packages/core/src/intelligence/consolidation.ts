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
}

/**
 * Find clusters of semantically similar memories that could be consolidated.
 * Uses greedy agglomerative clustering with cosine similarity threshold.
 */
export function findClusters(
  db: DatabaseSync,
  options: { minSimilarity?: number; minClusterSize?: number; maxMemories?: number } = {}
): ConsolidationCluster[] {
  const minSimilarity = options.minSimilarity ?? 0.75;
  const minClusterSize = options.minClusterSize ?? 3;
  const maxMemories = options.maxMemories ?? 500;

  // Get active memories with embeddings
  const rows = db
    .prepare(
      `SELECT id, content, embedding, created_at FROM memories
       WHERE is_active = 1 AND embedding IS NOT NULL AND parent_id IS NULL
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(maxMemories) as unknown as MemoryRow[];

  const memories: MemoryWithEmbedding[] = rows
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

  // Collect tags from source memories
  const tagSet = new Set<string>();
  if (cluster.memberIds.length > 0) {
    const placeholders = cluster.memberIds.map(() => "?").join(",");
    const tagRows = db
      .prepare(`SELECT DISTINCT tag FROM memory_tags WHERE memory_id IN (${placeholders})`)
      .all(...cluster.memberIds) as Array<{ tag: string }>;
    for (const t of tagRows) tagSet.add(t.tag);
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

  // Extract key facts and general context from all memories
  const keyFacts = new Set<string>();
  const contextPoints = new Set<string>();

  for (const row of rows) {
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

  // Build summary
  const topicHeader = tagSet.size > 0
    ? ` — Topics: ${Array.from(tagSet).slice(0, 5).join(", ")}`
    : "";

  let summary = `[Consolidated summary of ${rows.length} memories from ${earliest} to ${latest}${topicHeader}]`;

  if (keyFacts.size > 0) {
    summary += "\n\nKey facts:\n";
    summary += Array.from(keyFacts)
      .slice(0, 8)
      .map((f) => `- ${f}`)
      .join("\n");
  }

  if (contextPoints.size > 0) {
    summary += "\n\nContext:\n";
    summary += Array.from(contextPoints)
      .slice(0, 5)
      .map((c) => `- ${c}`)
      .join("\n");
  }

  return summary;
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
