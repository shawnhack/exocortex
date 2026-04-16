import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ulid } from "ulid";
import { cosineSimilarity } from "../memory/scoring.js";
import type { EmbeddingProvider } from "../embedding/types.js";
import type { MemoryRow } from "../memory/types.js";
import { detectCommunities } from "../entities/graph.js";
import type { Community } from "../entities/graph.js";
import { getSetting, setSetting } from "../db/schema.js";
import { buildProvenance, mergeProvenance, extractProvenance, aggregateTrust } from "../security/provenance.js";
import type { ProvenanceRecord } from "../security/provenance.js";

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

export interface CommunityAwareResult {
  /** Clusters after applying community-boundary splitting */
  clusters: ConsolidationCluster[];
  /** Memory IDs identified as bridges (connecting communities) and boosted */
  bridgeMemoryIds: string[];
  /** Number of clusters that were split due to community boundaries */
  clustersSplit: number;
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
 *
 * When `communityAware` is true, clusters are post-processed to respect
 * entity graph community boundaries: clusters spanning multiple communities
 * are split, and bridge memories (high betweenness) get importance boosts.
 */
export function findClusters(
  db: DatabaseSync,
  options: {
    minSimilarity?: number;
    minClusterSize?: number;
    maxMemories?: number;
    timeBucket?: 'week' | 'month';
    communityAware?: boolean;
  } = {}
): ConsolidationCluster[] {
  const minSimilarity = options.minSimilarity ?? 0.80;
  const minClusterSize = options.minClusterSize ?? 2;
  const maxMemories = options.maxMemories ?? 2000;

  // Build bucket column expression if time-constrained clustering is requested
  const bucketExpr = options.timeBucket === 'week'
    ? ", strftime('%Y-W%W', created_at) as bucket"
    : options.timeBucket === 'month'
      ? ", strftime('%Y-%m', created_at) as bucket"
      : '';

  // Get active memories with embeddings (skip immutable source documents)
  const rows = db
    .prepare(
      `SELECT id, content, embedding, created_at${bucketExpr} FROM memories
       WHERE is_active = 1 AND embedding IS NOT NULL AND parent_id IS NULL
         AND (metadata IS NULL OR json_extract(metadata, '$.immutable') IS NOT 1)
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

  // Apply community-aware filtering if requested
  if (options.communityAware && clusters.length > 0) {
    const result = applyCommunityAwareFiltering(db, clusters, minClusterSize);
    return result.clusters;
  }

  return clusters;
}

/**
 * Build a map from memory ID to set of community IDs the memory belongs to.
 * A memory belongs to a community if it is linked (via memory_entities) to an
 * entity that is a member of that community.
 */
function buildMemoryCommunityMap(
  db: DatabaseSync,
  memoryIds: string[],
  communities: Community[]
): Map<string, Set<number>> {
  if (memoryIds.length === 0 || communities.length === 0) {
    return new Map();
  }

  // Build entity → community map
  const entityToCommunity = new Map<string, number>();
  for (const community of communities) {
    for (const member of community.members) {
      entityToCommunity.set(member.entityId, community.id);
    }
  }

  // Query memory → entity links for the given memories
  const placeholders = memoryIds.map(() => "?").join(",");
  const links = db
    .prepare(
      `SELECT memory_id, entity_id FROM memory_entities
       WHERE memory_id IN (${placeholders})`
    )
    .all(...memoryIds) as Array<{ memory_id: string; entity_id: string }>;

  // Build memory → communities map
  const memoryCommunities = new Map<string, Set<number>>();
  for (const link of links) {
    const communityId = entityToCommunity.get(link.entity_id);
    if (communityId === undefined) continue;

    let comSet = memoryCommunities.get(link.memory_id);
    if (!comSet) {
      comSet = new Set();
      memoryCommunities.set(link.memory_id, comSet);
    }
    comSet.add(communityId);
  }

  return memoryCommunities;
}

/**
 * Apply community-aware filtering to consolidation clusters.
 *
 * 1. Detects entity graph communities via label propagation
 * 2. Splits clusters that span multiple communities at community boundaries
 * 3. Identifies bridge memories (belonging to 2+ communities) and boosts
 *    their importance to 0.8+ so they survive decay/consolidation
 *
 * Bridge memories are disproportionately valuable because they connect
 * different knowledge domains (e.g., linking "trading" to "architecture").
 */
export function applyCommunityAwareFiltering(
  db: DatabaseSync,
  clusters: ConsolidationCluster[],
  minClusterSize: number = 2,
  dryRun: boolean = false
): CommunityAwareResult {
  const communities = detectCommunities(db);

  // If no communities detected, return clusters unchanged
  if (communities.length === 0) {
    return { clusters, bridgeMemoryIds: [], clustersSplit: 0 };
  }

  // Collect all memory IDs across all clusters
  const allMemoryIds = new Set<string>();
  for (const cluster of clusters) {
    for (const id of cluster.memberIds) {
      allMemoryIds.add(id);
    }
  }

  // Build memory → community mapping
  const memoryCommunities = buildMemoryCommunityMap(
    db,
    Array.from(allMemoryIds),
    communities
  );

  // Identify bridge memories (belong to 2+ communities) and boost importance
  const bridgeMemoryIds: string[] = [];
  const bridgeSet = new Set<string>();

  for (const [memoryId, communityIds] of memoryCommunities) {
    if (communityIds.size >= 2) {
      bridgeMemoryIds.push(memoryId);
      bridgeSet.add(memoryId);
    }
  }

  // Boost importance of bridge memories to at least 0.8 (skip during dry-run)
  if (bridgeMemoryIds.length > 0 && !dryRun) {
    const boostStmt = db.prepare(
      "UPDATE memories SET importance = MAX(importance, 0.8) WHERE id = ? AND importance < 0.8"
    );
    for (const id of bridgeMemoryIds) {
      boostStmt.run(id);
    }
  }

  // Split clusters at community boundaries
  const resultClusters: ConsolidationCluster[] = [];
  let clustersSplit = 0;

  for (const cluster of clusters) {
    // Remove bridge memories from the cluster — they should be preserved, not merged
    const nonBridgeMembers = cluster.memberIds.filter((id) => !bridgeSet.has(id));

    // Group remaining members by their primary community
    // (primary = most frequent community among the memory's entities)
    const byCommunity = new Map<number | -1, string[]>();

    for (const memoryId of nonBridgeMembers) {
      const memComms = memoryCommunities.get(memoryId);
      // Memories with no entity links get community -1 (unassigned)
      const primaryCommunity = memComms && memComms.size > 0
        ? memComms.values().next().value!
        : -1;

      let group = byCommunity.get(primaryCommunity);
      if (!group) {
        group = [];
        byCommunity.set(primaryCommunity, group);
      }
      group.push(memoryId);
    }

    // If all members are in the same community (or unassigned), keep cluster as-is
    // but with bridge memories removed
    if (byCommunity.size <= 1) {
      const memberIds = nonBridgeMembers;
      if (memberIds.length >= minClusterSize) {
        resultClusters.push({
          centroidId: memberIds.includes(cluster.centroidId) ? cluster.centroidId : memberIds[0],
          memberIds,
          avgSimilarity: cluster.avgSimilarity,
          topic: cluster.topic,
        });
      }
      continue;
    }

    // Split: create sub-clusters per community
    clustersSplit++;

    // Batch-fetch centroid content for all sub-clusters (avoids N+1 queries)
    const centroidIds: string[] = [];
    for (const [, memberIds] of byCommunity) {
      if (memberIds.length < minClusterSize) continue;
      centroidIds.push(
        memberIds.includes(cluster.centroidId) ? cluster.centroidId : memberIds[0]
      );
    }
    const centroidContentMap = new Map<string, string>();
    if (centroidIds.length > 0) {
      const placeholders = centroidIds.map(() => "?").join(",");
      const rows = db
        .prepare(`SELECT id, content FROM memories WHERE id IN (${placeholders})`)
        .all(...centroidIds) as Array<{ id: string; content: string }>;
      for (const row of rows) {
        centroidContentMap.set(row.id, row.content);
      }
    }

    for (const [, memberIds] of byCommunity) {
      if (memberIds.length < minClusterSize) continue;

      const centroidId = memberIds.includes(cluster.centroidId)
        ? cluster.centroidId
        : memberIds[0];

      const topicContent = centroidContentMap.get(centroidId) ?? cluster.topic;
      const topic = topicContent.slice(0, 80).replace(/\s+/g, " ").trim();

      resultClusters.push({
        centroidId,
        memberIds,
        avgSimilarity: cluster.avgSimilarity,
        topic: topic.length < topicContent.length ? topic + "..." : topic,
      });
    }
  }

  return {
    clusters: resultClusters,
    bridgeMemoryIds,
    clustersSplit,
  };
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

  // Embed the summary if provider available.
  // Critical: if a provider is given but embedding fails, ABORT the consolidation.
  // Without an embedding the summary is invisible to vector search, but the
  // source memories would be archived anyway — silently making the consolidated
  // knowledge unfindable. Better to fail loudly and retry on the next run.
  // (No provider passed = caller explicitly opted out of embedding; that's fine.)
  let embeddingBlob: Uint8Array | null = null;
  if (embeddingProvider) {
    const embedding = await embeddingProvider.embed(summaryContent);
    embeddingBlob = new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  }

  // Collect tags from source memories, filtering out identity tags that
  // lose meaning when merged into consolidated summaries
  const CONSOLIDATION_TAG_BLOCKLIST = new Set([
    "skill",
    "prompt-amendment",
    "goal-progress-implicit",
    "goal-progress",
    "benchmark-artifact",
    "decision",
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

  // Use SAVEPOINT for nesting safety — consolidateCluster may be called
  // inside an outer transaction (e.g., from autoConsolidate or sentinel jobs)
  const savepointName = `consolidate_${summaryId.slice(0, 8)}`;
  db.exec(`SAVEPOINT ${savepointName}`);
  try {
    // Check for duplicate summary content before creating
    const contentHash = createHash("sha256")
      .update(summaryContent.toLowerCase().replace(/\s+/g, " ").trim())
      .digest("hex");
    const existingDupe = db
      .prepare("SELECT id FROM memories WHERE content_hash = ? AND is_active = 1 LIMIT 1")
      .get(contentHash) as { id: string } | undefined;
    if (existingDupe) {
      db.exec(`ROLLBACK TO ${savepointName}`);
      db.exec(`RELEASE ${savepointName}`);
      return existingDupe.id;
    }

    // Build provenance chain from source memories
    const sourceProvenances: Array<"internal" | "verified" | "external" | "untrusted"> = [];
    const derivedFrom: string[] = [...cluster.memberIds];
    let maxSourceDepth = -1;
    for (const memberId of cluster.memberIds) {
      const row = db
        .prepare("SELECT metadata FROM memories WHERE id = ?")
        .get(memberId) as { metadata: string | null } | undefined;
      if (row?.metadata) {
        try {
          const meta = JSON.parse(row.metadata);
          const prov = extractProvenance(meta);
          if (prov?.source_trust) sourceProvenances.push(prov.source_trust);
          if (prov && prov.derivation_depth > maxSourceDepth) {
            maxSourceDepth = prov.derivation_depth;
          }
        } catch { /* skip malformed metadata */ }
      }
    }

    const provenance = buildProvenance({
      derivedFrom,
      trust: sourceProvenances.length > 0 ? aggregateTrust(sourceProvenances) : "internal",
      // Consolidation depth = max source depth + 1 (or 0 if no sources have provenance)
      parentProvenance: maxSourceDepth >= 0 ? {
        derivation_depth: maxSourceDepth,
        source_trust: "internal" as const,
      } as ProvenanceRecord : undefined,
    });

    const metadata = mergeProvenance(
      {
        strategy: "similarity",
        source_count: cluster.memberIds.length,
        source_ids: cluster.memberIds,
        origin_pipeline: "consolidation",
      },
      provenance,
    );

    // Create summary memory with optional embedding
    db.prepare(
      `INSERT INTO memories (id, content, content_hash, content_type, source, embedding, importance, metadata, created_at, updated_at)
       VALUES (?, ?, ?, 'summary', 'consolidation', ?, 0.8, ?, ?, ?)`
    ).run(
      summaryId,
      summaryContent,
      contentHash,
      embeddingBlob,
      JSON.stringify(metadata),
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
    // so they don't compete with their summary in search results.
    // Also set superseded_by so search demotion (80% penalty) applies if archived memories are queried.
    const updateSource = db.prepare(
      "UPDATE memories SET parent_id = ?, superseded_by = ?, is_active = 0 WHERE id = ?"
    );
    for (const memberId of cluster.memberIds) {
      updateSource.run(summaryId, summaryId, memberId);
    }

    db.exec(`RELEASE ${savepointName}`);
  } catch (err) {
    db.exec(`ROLLBACK TO ${savepointName}`);
    db.exec(`RELEASE ${savepointName}`);
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

  const tags = Array.from(tagSet).slice(0, 5);
  const dateRange = earliest === latest ? earliest.split(' ')[0] : `${earliest.split(' ')[0]} to ${latest.split(' ')[0]}`;

  // 1. Topic header — readable prose, not mechanical metadata
  const topicLabel = tags.length > 0 ? tags.join(', ') : 'various topics';
  let summary = `${topicLabel} (${rows.length} sources, ${dateRange})`;
  wordCount += summary.split(/\s+/).length;

  // 2. Key facts — lead with a prose paragraph, then bullets for remaining
  const factArray = Array.from(keyFacts);
  if (factArray.length > 0) {
    // First 3 key facts as a prose paragraph (avoids >85% bullet rejection)
    const proseFacts = factArray.slice(0, 3);
    const bulletFacts = factArray.slice(3);
    const prosePara = proseFacts.join('. ') + '.';
    const proseWords = prosePara.split(/\s+/).length;
    if (wordCount + proseWords <= WORD_BUDGET) {
      summary += "\n\n" + prosePara;
      wordCount += proseWords;
    }

    // Remaining key facts as bullets
    if (bulletFacts.length > 0) {
      summary += "\n\n";
      for (const fact of bulletFacts) {
        const factWords = fact.split(/\s+/).length;
        if (wordCount + factWords > WORD_BUDGET) break;
        summary += `- ${fact}\n`;
        wordCount += factWords;
      }
    }
  }

  // 3. Context — fill remaining budget with non-key-fact sentences as bullets
  if (contextPoints.size > 0 && wordCount < WORD_BUDGET) {
    if (factArray.length > 0) summary += "\n";
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
 * Used to gate both agent-driven and auto-consolidation — rejects summaries
 * that lose too much information or exhibit known garbage patterns.
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

  // Reject known garbage patterns — mechanical headers, nested summaries, raw spillover
  if (/^\[Consolidated summary of \d+ memories/i.test(summaryContent)) {
    reasons.push('Mechanical header detected — summary must be prose, not "[Consolidated summary of...]"');
  }
  // Catch nested/embedded consolidation markers anywhere in the text (not just start)
  const nestedCount = (summaryContent.match(/\[Consolidated summary of/gi) || []).length;
  if (nestedCount > 0 && !reasons.some(r => r.includes('Mechanical header'))) {
    reasons.push(`Nested consolidation marker found (${nestedCount} occurrences) — indicates summary-of-summaries`);
  }
  // Reject summaries with raw memory ID spillover (e.g. "01KJ38S9VJ...")
  const idSpillover = (summaryContent.match(/\b01[A-Z0-9]{24,}\b/g) || []).length;
  if (idSpillover > 2) {
    reasons.push(`Raw memory IDs found in summary (${idSpillover}) — internal IDs should not leak into prose`);
  }
  // Reject summaries that are just metadata (dates, counts, tags with no substance)
  if (/^\s*\d+ sources|^\s*\d+ memories/i.test(summaryContent) && summaryContent.length < 200) {
    reasons.push('Summary appears to be metadata-only — needs substantive content');
  }

  // Reject summaries that are mostly extracted specifics / bullet lists with no prose
  // Relax for small clusters (2 members) where structured output is natural
  const lines = summaryContent.split('\n').filter(l => l.trim().length > 0);
  const bulletLines = lines.filter(l => /^\s*[-*•]/.test(l));
  const bulletThreshold = sourceContents.length <= 2 ? 0.95 : 0.85;
  if (lines.length >= 5 && bulletLines.length / lines.length > bulletThreshold) {
    reasons.push(`Summary is ${Math.round(bulletLines.length / lines.length * 100)}% bullet points — needs more synthesis`);
  }

  // Reject summaries shorter than 20% of source material (too much lost)
  const sourceLength = sourceContents.reduce((sum, s) => sum + s.length, 0);
  if (sourceLength > 500 && summaryContent.length < sourceLength * 0.1) {
    reasons.push(`Summary is only ${Math.round(summaryContent.length / sourceLength * 100)}% of source length — too much information lost`);
  }

  // Check proper noun preservation — adaptive threshold based on noun count.
  // With many unique nouns (>30), a concise summary can't mention them all.
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
    const minRatio = sourceNouns.size > 60 ? 0.15 : sourceNouns.size > 30 ? 0.25 : 0.5;
    if (ratio < minRatio) {
      reasons.push(
        `Only ${Math.round(ratio * 100)}% of proper nouns preserved (${preserved}/${sourceNouns.size}, min ${Math.round(minRatio * 100)}%)`
      );
    }
  }

  return { valid: reasons.length === 0, reasons };
}

// --- LLM-powered consolidation summaries ---

export interface LLMSummarizer {
  /** Generate a consolidated summary from multiple memory contents */
  summarize(contents: string[], topic: string): Promise<string>;
}

/**
 * Generate an LLM-powered consolidation summary using a cheap model (Haiku-tier).
 * Falls back to basic summary if the LLM call fails or is unavailable.
 */
export async function generateLLMSummary(
  db: DatabaseSync,
  memberIds: string[],
  summarizer: LLMSummarizer,
  topic: string,
): Promise<string> {
  const rows = db
    .prepare(
      `SELECT content FROM memories WHERE id IN (${memberIds.map(() => "?").join(",")})
       ORDER BY created_at ASC`
    )
    .all(...memberIds) as Array<{ content: string }>;

  const contents = rows.map(r => r.content);
  if (contents.length === 0) return "";

  // Match validateSummary's threshold: 80 for 2-member clusters, 100 for larger
  const minLength = memberIds.length <= 2 ? 80 : 100;

  try {
    const summary = await summarizer.summarize(contents, topic);
    if (summary && summary.length >= minLength) return summary;
  } catch {
    console.warn("[exocortex] AI summarizer failed, falling back to basic summary");
  }

  return generateBasicSummary(db, memberIds);
}

// --- Auto-consolidation ---

/**
 * Persistent cooldown for clusters that fail quality validation.
 * Stored in DB settings as JSON to survive process restarts.
 * Uses exponential backoff: 1h → 2h → 4h → ... → 7d (capped).
 */
const SETTINGS_KEY = "consolidation.failed_cooldowns";
const MAX_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface CooldownEntry { until: number; attempts: number }

function clusterKey(memberIds: string[]): string {
  return [...memberIds].sort().join(",");
}

function loadCooldowns(db: DatabaseSync): Record<string, CooldownEntry> {
  const raw = getSetting(db, SETTINGS_KEY);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function saveCooldowns(db: DatabaseSync, cooldowns: Record<string, CooldownEntry>): void {
  // Prune expired entries before saving
  const now = Date.now();
  const pruned: Record<string, CooldownEntry> = {};
  for (const [k, v] of Object.entries(cooldowns)) {
    if (v.until > now) pruned[k] = v;
  }
  setSetting(db, SETTINGS_KEY, JSON.stringify(pruned));
}

function isClusterOnCooldown(db: DatabaseSync, memberIds: string[]): boolean {
  const key = clusterKey(memberIds);
  const cooldowns = loadCooldowns(db);
  const entry = cooldowns[key];
  if (!entry) return false;
  return Date.now() < entry.until;
}

function recordClusterFailure(db: DatabaseSync, memberIds: string[]): void {
  const key = clusterKey(memberIds);
  const cooldowns = loadCooldowns(db);
  const entry = cooldowns[key];
  const attempts = (entry?.attempts ?? 0) + 1;
  const cooldownMs = Math.min(60 * 60 * 1000 * Math.pow(2, attempts - 1), MAX_COOLDOWN_MS);
  cooldowns[key] = { until: Date.now() + cooldownMs, attempts };
  saveCooldowns(db, cooldowns);
}

export interface AutoConsolidateResult {
  clustersFound: number;
  clustersConsolidated: number;
  memoriesMerged: number;
  summaryIds: string[];
}

/**
 * Automatically consolidate the top N clusters.
 * When an LLM summarizer is provided, uses it for higher-quality summaries.
 * Falls back to generateBasicSummary (no LLM needed) otherwise.
 */
export async function autoConsolidate(
  db: DatabaseSync,
  embeddingProvider?: EmbeddingProvider,
  opts?: {
    maxClusters?: number;
    minSimilarity?: number;
    minClusterSize?: number;
    summarizer?: LLMSummarizer;
  }
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
    // Skip clusters on cooldown from previous validation failures
    if (isClusterOnCooldown(db, cluster.memberIds)) continue;

    const summary = opts?.summarizer
      ? await generateLLMSummary(db, cluster.memberIds, opts.summarizer, cluster.topic)
      : generateBasicSummary(db, cluster.memberIds);
    if (!summary) continue;

    // Validate summary quality before consolidating
    const sourceContents = db
      .prepare(
        `SELECT content FROM memories WHERE id IN (${cluster.memberIds.map(() => "?").join(",")})`
      )
      .all(...cluster.memberIds) as Array<{ content: string }>;
    const validation = validateSummary(summary, sourceContents.map((r) => r.content));
    if (!validation.valid) {
      recordClusterFailure(db, cluster.memberIds);
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
