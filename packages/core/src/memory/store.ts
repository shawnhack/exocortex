import type { DatabaseSync } from "node:sqlite";
import { ulid } from "ulid";
import { getEmbeddingProvider } from "../embedding/manager.js";
import { getSetting, safeJsonParse } from "../db/schema.js";
import { cosineSimilarity } from "./scoring.js";
import { splitIntoChunks } from "./chunking.js";
import { extractEntities, extractRelationships } from "../entities/extractor.js";
import { EntityStore } from "../entities/store.js";
import { autoGenerateTags } from "./auto-tags.js";
import { generateKeywords } from "./keywords.js";
import { getTagAliasMap, normalizeTags, getCanonicalMap, canonicalizeTags } from "./tag-normalization.js";
import { computeContentHashForDb } from "./content-hash.js";
import { getMetadataTags, inferIsMetadata } from "./metadata-classification.js";
import { incrementCounter } from "../observability/counters.js";
import { MemoryLinkStore } from "./links.js";
import type {
  Memory,
  MemoryRow,
  CreateMemoryInput,
  CreateMemoryResult,
  UpdateMemoryInput,
  MemoryStats,
} from "./types.js";

function rowToMemory(row: MemoryRow, tags?: string[]): Memory {
  const {
    content_hash: _contentHash,
    is_indexed: _isIndexed,
    is_metadata: isMetadata,
    ...rowData
  } = row;
  let embedding: Float32Array | null = null;
  if (row.embedding) {
    const bytes = row.embedding as unknown as Uint8Array;
    embedding = new Float32Array(new Uint8Array(bytes).buffer);
  }

  return {
    ...rowData,
    embedding,
    is_metadata: isMetadata === 1,
    is_active: rowData.is_active === 1,
    superseded_by: rowData.superseded_by ?? null,
    chunk_index: rowData.chunk_index ?? null,
    keywords: rowData.keywords ?? undefined,
    metadata: safeJsonParse<Record<string, unknown> | undefined>(rowData.metadata, undefined),
    tier: (rowData.tier as import("./types.js").MemoryTier) ?? "episodic",
    expires_at: rowData.expires_at ?? null,
    namespace: rowData.namespace ?? null,
    tags,
  };
}

/**
 * Strip `<private>...</private>` blocks from content before persisting.
 * Content between tags is never stored, embedded, or indexed.
 */
export function stripPrivateContent(text: string): string {
  const stripped = text.replace(/<private>[\s\S]*?<\/private>/gi, "");
  // Collapse runs of 3+ newlines to 2, trim
  return stripped.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Validate that memory content meets minimum quality thresholds.
 * Call this at the API/MCP boundary before passing to MemoryStore.create().
 * Throws if content is too short (< 120 chars) unless exempted.
 */
export function validateStorageGate(
  content: string,
  opts?: {
    content_type?: string;
    parent_id?: string;
    is_metadata?: boolean;
    benchmark?: boolean;
    tags?: string[];
  }
): void {
  const MIN_CONTENT_LENGTH = 120;
  const isExempt =
    opts?.content_type === "conversation" ||
    !!opts?.parent_id ||
    opts?.is_metadata === true ||
    opts?.benchmark === true ||
    (opts?.tags ?? []).some((t) =>
      ["goal-progress", "goal-progress-implicit", "prompt-amendment", "outcome"].includes(t)
    );
  if (content.length < MIN_CONTENT_LENGTH && !isExempt) {
    throw new Error(
      `Memory content too short (${content.length} chars, min ${MIN_CONTENT_LENGTH}). Short memories rarely provide retrieval value.`
    );
  }

  // Quality gate for consolidation/summary content — reject garbage patterns
  if (opts?.content_type === "summary") {
    const garbage = detectConsolidationGarbage(content);
    if (garbage.length > 0) {
      throw new Error(
        `Consolidation quality gate failed: ${garbage.join("; ")}`
      );
    }
  }
}

/** Detect garbage patterns in consolidation/summary content */
function detectConsolidationGarbage(content: string): string[] {
  const issues: string[] = [];

  // Nested consolidation markers
  const nestedCount = (content.match(/\[Consolidated summary of/gi) || []).length;
  if (nestedCount > 0) {
    issues.push(`Contains "[Consolidated summary of" header (${nestedCount}x) — summaries must be prose`);
  }

  // Raw memory IDs leaked into content
  const idLeaks = (content.match(/\b01[A-Z0-9]{24,}\b/g) || []).length;
  if (idLeaks > 2) {
    issues.push(`Contains ${idLeaks} raw memory IDs — internal IDs should not appear in summaries`);
  }

  // Summary-of-summaries nesting (multiple date range headers)
  const dateRangeHeaders = (content.match(/\d+ sources, \d{4}-\d{2}-\d{2}/g) || []).length;
  if (dateRangeHeaders > 1) {
    issues.push(`Contains ${dateRangeHeaders} date-range headers — indicates nested summary-of-summaries`);
  }

  return issues;
}

type MemoryAttribution = {
  provider: string | null;
  model_id: string | null;
  model_name: string | null;
  agent: string | null;
  session_id: string | null;
  conversation_id: string | null;
};

function normalizedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function metadataString(
  metadata: Record<string, unknown> | undefined,
  key: string
): string | null {
  if (!metadata) return null;
  return normalizedString(metadata[key]);
}

function resolveCreateAttribution(input: CreateMemoryInput): MemoryAttribution {
  return {
    provider:
      normalizedString(input.provider) ??
      metadataString(input.metadata, "provider"),
    model_id:
      normalizedString(input.model_id) ??
      metadataString(input.metadata, "model_id"),
    model_name:
      normalizedString(input.model_name) ??
      metadataString(input.metadata, "model_name") ??
      metadataString(input.metadata, "model"),
    agent:
      normalizedString(input.agent) ??
      metadataString(input.metadata, "agent"),
    session_id:
      normalizedString(input.session_id) ??
      metadataString(input.metadata, "session_id"),
    conversation_id:
      normalizedString(input.conversation_id) ??
      metadataString(input.metadata, "conversation_id"),
  };
}

function resolveUpdateAttribution(
  input: UpdateMemoryInput,
  mergedMetadata: Record<string, unknown>
): Partial<MemoryAttribution> {
  const hasMeta = input.metadata !== undefined;
  const hasOwn = (key: string): boolean =>
    hasMeta && Object.prototype.hasOwnProperty.call(input.metadata, key);

  const updates: Partial<MemoryAttribution> = {};

  if (input.provider !== undefined) {
    updates.provider = normalizedString(input.provider);
  } else if (hasOwn("provider")) {
    updates.provider = metadataString(mergedMetadata, "provider");
  }

  if (input.model_id !== undefined) {
    updates.model_id = normalizedString(input.model_id);
  } else if (hasOwn("model_id")) {
    updates.model_id = metadataString(mergedMetadata, "model_id");
  }

  if (input.model_name !== undefined) {
    updates.model_name = normalizedString(input.model_name);
  } else if (hasOwn("model_name") || hasOwn("model")) {
    updates.model_name =
      metadataString(mergedMetadata, "model_name") ??
      metadataString(mergedMetadata, "model");
  }

  if (input.agent !== undefined) {
    updates.agent = normalizedString(input.agent);
  } else if (hasOwn("agent")) {
    updates.agent = metadataString(mergedMetadata, "agent");
  }

  if (input.session_id !== undefined) {
    updates.session_id = normalizedString(input.session_id);
  } else if (hasOwn("session_id")) {
    updates.session_id = metadataString(mergedMetadata, "session_id");
  }

  if (input.conversation_id !== undefined) {
    updates.conversation_id = normalizedString(input.conversation_id);
  } else if (hasOwn("conversation_id")) {
    updates.conversation_id = metadataString(mergedMetadata, "conversation_id");
  }

  return updates;
}

export class MemoryStore {
  constructor(private db: DatabaseSync) {}

  async create(input: CreateMemoryInput): Promise<CreateMemoryResult> {
    const id = ulid();
    const now = new Date().toISOString().replace("T", " ").replace("Z", "");
    const aliasMap = getTagAliasMap(this.db);
    const skipInsertOnDedup = getSetting(this.db, "dedup.skip_insert_on_match") !== "false";

    // Strip <private> blocks before any processing
    const content = stripPrivateContent(input.content);
    if (content.length === 0) {
      throw new Error("Memory content is empty after stripping private blocks");
    }

    const isBenchmark = input.benchmark === true;
    const canonicalMap = getCanonicalMap(this.db);
    const normalizedTags = canonicalizeTags(normalizeTags(input.tags, aliasMap), canonicalMap).tags;
    if (isBenchmark && !normalizedTags.includes("benchmark-artifact")) {
      normalizedTags.push("benchmark-artifact");
    }

    const parsedBenchImportance = parseFloat(getSetting(this.db, "benchmark.default_importance") ?? "0.15");
    const defaultImportance = isBenchmark
      ? (Number.isFinite(parsedBenchImportance) ? parsedBenchImportance : 0.15)
      : 0.5;

    const metadata = { ...(input.metadata ?? {}) };
    if (isBenchmark && metadata.mode === undefined) {
      metadata.mode = "benchmark";
    }

    input = {
      ...input,
      content,
      tags: normalizedTags,
      importance: input.importance ?? defaultImportance,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
    const attribution = resolveCreateAttribution(input);

    const metadataTags = getMetadataTags(this.db, aliasMap);
    const inferredIsMetadata = inferIsMetadata({
      explicit: input.is_metadata,
      benchmark: isBenchmark,
      tags: input.tags,
      metadata: input.metadata,
      metadataTags,
    });
    input = {
      ...input,
      is_metadata: inferredIsMetadata,
    };

    if (isBenchmark) {
      incrementCounter(this.db, "memory.benchmark_writes");
    }

    const contentHash = computeContentHashForDb(this.db, input.content);
    const benchmarkIndexed = isBenchmark
      ? getSetting(this.db, "benchmark.indexed") === "true"
      : true;
    const benchmarkChunkingEnabled = isBenchmark
      ? getSetting(this.db, "benchmark.chunking") === "true"
      : true;

    let hashDedupId: string | null = null;
    if (!input.parent_id) {
      hashDedupId = this.findHashDedupCandidate(input, contentHash);
      if (hashDedupId && skipInsertOnDedup) {
        return this.skipDuplicateInsert(
          hashDedupId,
          input,
          now,
          1.0,
          "hash"
        );
      }
    }

    // Check if chunking is needed
    const chunkingEnabled = getSetting(this.db, "chunking.enabled") !== "false";
    const maxLength = parseInt(getSetting(this.db, "chunking.max_length") ?? "1500", 10);
    const targetSize = parseInt(getSetting(this.db, "chunking.target_size") ?? "500", 10);
    const shouldChunk =
      chunkingEnabled &&
      benchmarkChunkingEnabled &&
      !input.parent_id &&
      input.content.length > maxLength;

    // Generate embedding (or fallback to no embedding for benchmark artifacts)
    let embeddingBlob: Uint8Array | null = null;
    let embeddingFloat: Float32Array | null = null;
    if (benchmarkIndexed) {
      try {
        const provider = await getEmbeddingProvider();
        const embedding = await provider.embed(input.content);
        embeddingFloat = embedding;
        embeddingBlob = new Uint8Array(
          embedding.buffer,
          embedding.byteOffset,
          embedding.byteLength
        );
      } catch (err) {
        // Embedding may fail on first run while model downloads; store without
        console.error(`[exocortex] Embedding failed, storing memory without vector index: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Opt-in semantic dedup: check for near-duplicates before inserting
    if (input.deduplicate && embeddingFloat && !input.parent_id) {
      const nearDup = this.findNearDuplicate(input, embeddingFloat);
      if (nearDup) {
        const existingMemory = await this.getById(nearDup.existing_id);
        if (existingMemory) {
          incrementCounter(this.db, "memory.dedup_near_duplicate");
          return {
            memory: existingMemory,
            superseded_id: nearDup.existing_id,
            dedup_similarity: nearDup.similarity,
            dedup_action: "near_duplicate",
          };
        }
      }
    }

    if (shouldChunk) {
      let memory: Memory;
      try {
        memory = await this.createWithChunks(
          id,
          input,
          attribution,
          now,
          maxLength,
          targetSize,
          contentHash,
          benchmarkIndexed,
          inferredIsMetadata,
          hashDedupId ?? undefined
        );
      } catch (err) {
        if (this.isHashUniquenessConflict(err) && !input.parent_id) {
          const existingId = this.findHashDedupCandidate(input, contentHash);
          if (existingId) {
            return this.skipDuplicateInsert(
              existingId,
              input,
              now,
              1.0,
              "constraint"
            );
          }
        }
        throw err;
      }
      const result: CreateMemoryResult = { memory };
      if (hashDedupId && !skipInsertOnDedup) {
        incrementCounter(this.db, "memory.dedup_superseded");
        incrementCounter(this.db, "memory.dedup_superseded.hash");
        result.superseded_id = hashDedupId;
        result.dedup_similarity = 1.0;
        result.dedup_action = "superseded";
      }
      return result;
    }

    // Dedup check: find semantically similar existing memory.
    // Actual supersede update happens inside the insert transaction so
    // dedup cannot deactivate data if the insert later fails.
    let dedupInfo: { superseded_id: string; similarity: number; action?: "merge" } | null =
      hashDedupId && !skipInsertOnDedup
        ? { superseded_id: hashDedupId, similarity: 1.0 }
        : null;
    if (!dedupInfo && embeddingFloat && !input.parent_id) {
      try {
        dedupInfo = this.findDedupCandidate(input, embeddingFloat);
      } catch {
        // Dedup is non-critical
      }
    }
    if (dedupInfo && skipInsertOnDedup) {
      return this.skipDuplicateInsert(
        dedupInfo.superseded_id,
        input,
        now,
        dedupInfo.similarity,
        dedupInfo.similarity >= 0.999 ? "hash" : "semantic"
      );
    }

    // Merge mode: append new content to existing memory instead of creating a new one
    if (dedupInfo && dedupInfo.action === "merge") {
      return this.mergeIntoExisting(dedupInfo.superseded_id, input, now, dedupInfo.similarity);
    }

    const insertMemory = this.db.prepare(`
      INSERT INTO memories (id, content, content_type, source, source_uri, provider, model_id, model_name, agent, session_id, conversation_id, embedding, content_hash, is_indexed, is_metadata, importance, valence, parent_id, metadata, tier, expires_at, namespace, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertTag = this.db.prepare(
      "INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)"
    );

    this.db.exec("BEGIN");
    try {
      if (dedupInfo) {
        const dedupUpdate = this.db.prepare(
          "UPDATE memories SET is_active = 0, superseded_by = ?, updated_at = ? WHERE id = ? AND is_active = 1"
        );
        const dedupResult = dedupUpdate.run(
          id,
          now,
          dedupInfo.superseded_id
        ) as { changes: number };
        if (dedupResult.changes === 0) {
          dedupInfo = null;
        }
      }

      insertMemory.run(
        id,
        input.content,
        input.content_type ?? "text",
        input.source ?? "manual",
        input.source_uri ?? null,
        attribution.provider,
        attribution.model_id,
        attribution.model_name,
        attribution.agent,
        attribution.session_id,
        attribution.conversation_id,
        embeddingBlob,
        contentHash,
        benchmarkIndexed ? 1 : 0,
        input.is_metadata ? 1 : 0,
        input.importance ?? defaultImportance,
        input.valence ?? 0,
        input.parent_id ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        input.tier ?? (input.parent_id ? "reference" : "episodic"),
        input.tier === "working" && !input.expires_at
          ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
          : (input.expires_at ?? null),
        input.namespace ?? null,
        now,
        now
      );

      if (input.tags) {
        for (const tag of input.tags) {
          insertTag.run(id, tag);
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Ignore nested rollback errors
      }
      if (
        this.isHashUniquenessConflict(err) &&
        !input.parent_id
      ) {
        const existingId = this.findHashDedupCandidate(input, contentHash);
        if (existingId) {
          return this.skipDuplicateInsert(
            existingId,
            input,
            now,
            1.0,
            "constraint"
          );
        }
      }
      throw err;
    }

    // Benchmark artifacts intentionally skip expensive extraction and indexing extras.
    if (!isBenchmark) {
      // Auto-extract and link entities + relationships
      try {
        const extracted = extractEntities(input.content).filter(e => e.confidence >= 0.5);
        if (extracted.length > 0) {
          const entityStore = new EntityStore(this.db);
          const entityIdMap = new Map<string, string>();

          for (const entity of extracted) {
            let existing = entityStore.getByName(entity.name);
            if (!existing) {
              existing = entityStore.create({ name: entity.name, type: entity.type });
            } else if (existing.type === "concept" && entity.type !== "concept" && entity.confidence >= 0.85) {
              // Upgrade stale "concept" type to a more specific auto-categorized type
              entityStore.update(existing.id, { type: entity.type });
              existing = { ...existing, type: entity.type };
            }
            entityStore.linkMemory(existing.id, id, entity.confidence);
            entityIdMap.set(entity.name.toLowerCase(), existing.id);
          }

          // Extract and store relationships between entities
          const relationships = extractRelationships(input.content, extracted);
          for (const rel of relationships) {
            const sourceId = entityIdMap.get(rel.source.toLowerCase());
            const targetId = entityIdMap.get(rel.target.toLowerCase());
            if (sourceId && targetId) {
              entityStore.addRelationship(sourceId, targetId, rel.relationship, rel.confidence, id, rel.context);
            }
          }
        }
      } catch (err) {
        console.error(`[exocortex] Entity extraction failed: ${err instanceof Error ? err.message : err}`);
      }

      // Auto-generate tags
      try {
        const autoTaggingEnabled = getSetting(this.db, "auto_tagging.enabled") !== "false";
        if (autoTaggingEnabled) {
          const autoTags = canonicalizeTags(normalizeTags(autoGenerateTags(input.content), aliasMap), canonicalMap).tags;
          if (autoTags.length > 0) {
            const existingTags = new Set(input.tags ?? []);
            const newTags = autoTags.filter((t) => !existingTags.has(t));
            if (newTags.length > 0) {
              const insertAutoTag = this.db.prepare(
                "INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)"
              );
              for (const tag of newTags) {
                insertAutoTag.run(id, tag);
              }
            }
          }
        }
      } catch (err) {
        console.error(`[exocortex] Auto-tagging failed: ${err instanceof Error ? err.message : err}`);
      }

      // Generate keywords from content, tags, and entity names
      try {
        const allTags = this.db
          .prepare("SELECT tag FROM memory_tags WHERE memory_id = ?")
          .all(id) as Array<{ tag: string }>;
        const tagNames = allTags.map((t) => t.tag);

        const entityRows = this.db
          .prepare(
            "SELECT e.name FROM entities e INNER JOIN memory_entities me ON e.id = me.entity_id WHERE me.memory_id = ?"
          )
          .all(id) as Array<{ name: string }>;
        const entityNames = entityRows.map((e) => e.name);

        const keywords = generateKeywords(input.content, tagNames, entityNames);
        if (keywords.length > 0) {
          this.db
            .prepare("UPDATE memories SET keywords = ? WHERE id = ?")
            .run(keywords, id);
        }
      } catch (err) {
        console.error(`[exocortex] Keyword generation failed: ${err instanceof Error ? err.message : err}`);
      }

      // Extract and store structured facts (SPO triples)
      try {
        const { extractFacts: extractFactsFn, storeFacts: storeFactsFn } = await import("./facts.js");
        const facts = extractFactsFn(input.content);
        if (facts.length > 0) {
          storeFactsFn(this.db, id, facts);
        }
      } catch (err) {
        console.error(`[exocortex] Fact extraction failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Compute initial quality_score (freshness=1.0, access=0, useful=0, links=0)
    try {
      const initialQuality = 0.30 * (input.importance ?? 0.5) + 0.15;
      this.db
        .prepare("UPDATE memories SET quality_score = ? WHERE id = ?")
        .run(Math.round(initialQuality * 1000) / 1000, id);
    } catch {
      // Non-critical — quality_score can be backfilled later
    }

    const memory = await this.getById(id) as Memory;
    const result: CreateMemoryResult = { memory };
    if (dedupInfo) {
      incrementCounter(this.db, "memory.dedup_superseded");
      if (dedupInfo.similarity >= 0.999) {
        incrementCounter(this.db, "memory.dedup_superseded.hash");
      } else {
        incrementCounter(this.db, "memory.dedup_superseded.semantic");
      }
      result.superseded_id = dedupInfo.superseded_id;
      result.dedup_similarity = dedupInfo.similarity;
      result.dedup_action = "superseded";
    }
    return result;
  }

  private isHashUniquenessConflict(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message;
    return (
      msg.includes("SQLITE_CONSTRAINT_UNIQUE") &&
      (
        msg.includes("uq_memories_active_root_hash_type") ||
        msg.includes("memories.content_type, memories.content_hash")
      )
    );
  }

  private findHashDedupCandidate(
    input: CreateMemoryInput,
    contentHash: string
  ): string | null {
    const hashDedupEnabled = getSetting(this.db, "dedup.hash_enabled") !== "false";
    if (!hashDedupEnabled) return null;
    if (!contentHash) return null;

    const contentType = input.content_type ?? "text";
    const namespace = input.namespace ?? null;
    const row = this.db
      .prepare(
        `SELECT id
         FROM memories
         WHERE is_active = 1
           AND parent_id IS NULL
           AND content_type = ?
           AND content_hash = ?
           AND namespace IS ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(contentType, contentHash, namespace) as { id: string } | undefined;

    return row?.id ?? null;
  }

  private async skipDuplicateInsert(
    existingId: string,
    input: CreateMemoryInput,
    now: string,
    similarity: number,
    reason: "hash" | "semantic" | "constraint"
  ): Promise<CreateMemoryResult> {
    const insertTag = this.db.prepare(
      "INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)"
    );

    this.db.exec("BEGIN");
    try {
      if (input.tags && input.tags.length > 0) {
        for (const tag of input.tags) {
          insertTag.run(existingId, tag);
        }
      }

      if (input.importance !== undefined) {
        this.db
          .prepare(
            `UPDATE memories
             SET importance = CASE WHEN importance < ? THEN ? ELSE importance END
             WHERE id = ?`
          )
          .run(input.importance, input.importance, existingId);
      }

      if (input.is_metadata) {
        this.db
          .prepare(
            "UPDATE memories SET is_metadata = 1, updated_at = ? WHERE id = ? AND is_metadata = 0"
          )
          .run(now, existingId);
      }

      const existingRow = this.db
        .prepare(
          "SELECT metadata, provider, model_id, model_name, agent, session_id, conversation_id FROM memories WHERE id = ?"
        )
        .get(existingId) as
        | {
            metadata: string | null;
            provider: string | null;
            model_id: string | null;
            model_name: string | null;
            agent: string | null;
            session_id: string | null;
            conversation_id: string | null;
          }
        | undefined;
      const currentMeta: Record<string, unknown> = safeJsonParse<Record<string, unknown>>(existingRow?.metadata ?? null, {});
      const mergedMeta =
        input.metadata && Object.keys(input.metadata).length > 0
          ? { ...currentMeta, ...input.metadata }
          : currentMeta;
      const attributionUpdates = resolveUpdateAttribution(
        {
          provider: input.provider,
          model_id: input.model_id,
          model_name: input.model_name,
          agent: input.agent,
          session_id: input.session_id,
          conversation_id: input.conversation_id,
          metadata: input.metadata,
        },
        mergedMeta
      );

      const shouldWriteMetadata =
        input.metadata && Object.keys(input.metadata).length > 0;
      const shouldWriteAttribution = Object.keys(attributionUpdates).length > 0;

      if (shouldWriteMetadata || shouldWriteAttribution) {
        this.db
          .prepare(
            "UPDATE memories SET metadata = ?, provider = ?, model_id = ?, model_name = ?, agent = ?, session_id = ?, conversation_id = ?, updated_at = ? WHERE id = ?"
          )
          .run(
            JSON.stringify(mergedMeta),
            attributionUpdates.provider ?? existingRow?.provider ?? null,
            attributionUpdates.model_id ?? existingRow?.model_id ?? null,
            attributionUpdates.model_name ?? existingRow?.model_name ?? null,
            attributionUpdates.agent ?? existingRow?.agent ?? null,
            attributionUpdates.session_id ?? existingRow?.session_id ?? null,
            attributionUpdates.conversation_id ??
              existingRow?.conversation_id ??
              null,
            now,
            existingId
          );
      } else {
        this.db
          .prepare("UPDATE memories SET updated_at = ? WHERE id = ?")
          .run(now, existingId);
      }

      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    const existing = await this.getById(existingId);
    if (!existing) {
      throw new Error(`Dedup candidate ${existingId} disappeared during update`);
    }

    incrementCounter(this.db, "memory.dedup_skipped");
    incrementCounter(this.db, `memory.dedup_skipped.${reason}`);

    return {
      memory: existing,
      superseded_id: existingId,
      dedup_similarity: similarity,
      dedup_action: "skipped",
    };
  }

  /**
   * Find a semantically similar existing memory candidate for superseding.
   * Returns dedup info when a candidate is found; caller performs the
   * supersede update transactionally with the new insert.
   */
  private findDedupCandidate(
    input: CreateMemoryInput,
    newEmbedding: Float32Array
  ): { superseded_id: string; similarity: number; action?: "merge" } | null {
    const dedupEnabled = getSetting(this.db, "dedup.enabled") !== "false";
    if (!dedupEnabled) return null;

    // Skip semantic dedup for memories with exempt tags (e.g. sentinel reports)
    // Hash dedup still catches exact duplicates upstream
    if (input.tags && input.tags.length > 0) {
      const exemptRaw = getSetting(this.db, "dedup.exempt_tags") ?? "[]";
      const exemptTags: string[] = safeJsonParse<string[]>(exemptRaw, []);
      if (exemptTags.length > 0) {
        const exemptSet = new Set(exemptTags.map((t) => t.toLowerCase().trim()));
        const hasExempt = input.tags.some((t) => exemptSet.has(t.toLowerCase().trim()));
        if (hasExempt) return null;
      }
    }

    // Skip dedup for very short content — too likely to get false positives
    if (input.content.length < 50) return null;

    const threshold = parseFloat(
      getSetting(this.db, "dedup.similarity_threshold") ?? "0.85"
    );
    const candidatePool = parseInt(
      getSetting(this.db, "dedup.candidate_pool") ?? "200",
      10
    );

    // Scan recent active non-chunk memories of same content_type and namespace
    const contentType = input.content_type ?? "text";
    const namespace = input.namespace ?? null;
    const candidates = this.db
      .prepare(
        `SELECT id, embedding FROM memories
         WHERE is_active = 1
           AND embedding IS NOT NULL
           AND parent_id IS NULL
           AND content_type = ?
           AND namespace IS ?
         ORDER BY created_at DESC LIMIT ?`
      )
      .all(contentType, namespace, candidatePool) as unknown as Array<{ id: string; embedding: Uint8Array }>;

    for (const candidate of candidates) {
      const bytes = candidate.embedding as unknown as Uint8Array;
      const candidateEmbedding = new Float32Array(new Uint8Array(bytes).buffer);
      const similarity = cosineSimilarity(newEmbedding, candidateEmbedding);

      if (similarity >= threshold) {
        // Check tag overlap if tags are provided
        if (input.tags && input.tags.length > 0) {
          const existingTags = this.db
            .prepare("SELECT tag FROM memory_tags WHERE memory_id = ?")
            .all(candidate.id) as Array<{ tag: string }>;
          const existingTagSet = new Set(existingTags.map((t) => t.tag));
          const hasOverlap = input.tags.some((t) =>
            existingTagSet.has(t.toLowerCase().trim())
          );
          if (!hasOverlap) continue;
        }

        return { superseded_id: candidate.id, similarity };
      }

      // Merge mode: check if similarity is in the merge range (below threshold but above merge threshold)
      const mergeEnabled = getSetting(this.db, "dedup.merge_enabled") === "true";
      if (mergeEnabled) {
        const mergeThreshold = parseFloat(
          getSetting(this.db, "dedup.merge_threshold") ?? "0.75"
        );
        if (similarity >= mergeThreshold && similarity < threshold) {
          // Check tag overlap
          if (input.tags && input.tags.length > 0) {
            const existingTags = this.db
              .prepare("SELECT tag FROM memory_tags WHERE memory_id = ?")
              .all(candidate.id) as Array<{ tag: string }>;
            const existingTagSet = new Set(existingTags.map((t) => t.tag));
            const hasOverlap = input.tags.some((t) =>
              existingTagSet.has(t.toLowerCase().trim())
            );
            if (!hasOverlap) continue;
          }
          return { superseded_id: candidate.id, similarity, action: "merge" as const };
        }
      }
    }

    return null;
  }

  /**
   * Opt-in semantic dedup: find an existing memory that covers the same content.
   * Returns match info if similarity > 0.85 AND word overlap > 60%.
   * Unlike findDedupCandidate, this does NOT supersede — it returns the existing
   * memory so the caller can decide whether to update or skip.
   */
  private findNearDuplicate(
    input: CreateMemoryInput,
    newEmbedding: Float32Array
  ): { existing_id: string; similarity: number } | null {
    if (input.content.length < 50) return null;

    const NEAR_DEDUP_THRESHOLD = 0.85;
    const WORD_OVERLAP_THRESHOLD = 0.60;

    // Build namespace filter
    const namespace = input.namespace ?? null;

    // Query recent active memories, optionally filtered by namespace
    const candidates = namespace
      ? this.db
          .prepare(
            `SELECT id, content, embedding FROM memories
             WHERE is_active = 1
               AND embedding IS NOT NULL
               AND parent_id IS NULL
               AND namespace = ?
             ORDER BY created_at DESC LIMIT 200`
          )
          .all(namespace) as unknown as Array<{ id: string; content: string; embedding: Uint8Array }>
      : this.db
          .prepare(
            `SELECT id, content, embedding FROM memories
             WHERE is_active = 1
               AND embedding IS NOT NULL
               AND parent_id IS NULL
             ORDER BY created_at DESC LIMIT 200`
          )
          .all() as unknown as Array<{ id: string; content: string; embedding: Uint8Array }>;

    // Top 3 by cosine similarity
    const scored: Array<{ id: string; content: string; similarity: number }> = [];
    for (const c of candidates) {
      const bytes = c.embedding as unknown as Uint8Array;
      const cEmb = new Float32Array(new Uint8Array(bytes).buffer);
      const sim = cosineSimilarity(newEmbedding, cEmb);
      if (sim >= NEAR_DEDUP_THRESHOLD) {
        scored.push({ id: c.id, content: c.content, similarity: sim });
      }
    }
    scored.sort((a, b) => b.similarity - a.similarity);
    const top3 = scored.slice(0, 3);

    // Check word overlap for top candidates
    const newWords = new Set(
      input.content.toLowerCase().split(/\s+/).filter((w) => w.length >= 3)
    );

    for (const candidate of top3) {
      const existingWords = new Set(
        candidate.content.toLowerCase().split(/\s+/).filter((w) => w.length >= 3)
      );
      let overlap = 0;
      for (const w of newWords) {
        if (existingWords.has(w)) overlap++;
      }
      const overlapRatio = overlap / Math.max(newWords.size, 1);
      if (overlapRatio > WORD_OVERLAP_THRESHOLD) {
        return { existing_id: candidate.id, similarity: candidate.similarity };
      }
    }

    return null;
  }

  /**
   * Create a long memory as parent + chunks with individual embeddings.
   * Parent stores full content with NO embedding; chunks have embeddings.
   */
  private async createWithChunks(
    parentId: string,
    input: CreateMemoryInput,
    attribution: MemoryAttribution,
    now: string,
    _maxLength: number,
    targetSize: number,
    contentHash: string,
    isIndexed: boolean,
    isMetadata: boolean,
    supersedeExistingId?: string
  ): Promise<Memory> {
    // Private content already stripped in create(), but defensive check for direct calls
    const content = stripPrivateContent(input.content);
    if (content.length === 0) {
      throw new Error("Memory content is empty after stripping private blocks");
    }
    input = { ...input, content };

    const chunks = splitIntoChunks(input.content, { targetSize });

    // Insert parent (no embedding)
    const insertMemory = this.db.prepare(`
      INSERT INTO memories (id, content, content_type, source, source_uri, provider, model_id, model_name, agent, session_id, conversation_id, embedding, content_hash, is_indexed, is_metadata, importance, valence, parent_id, metadata, tier, expires_at, namespace, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertTag = this.db.prepare(
      "INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)"
    );

    this.db.exec("BEGIN");
    try {
      if (supersedeExistingId) {
        this.db
          .prepare(
            "UPDATE memories SET is_active = 0, superseded_by = ?, updated_at = ? WHERE id = ? AND is_active = 1"
          )
          .run(parentId, now, supersedeExistingId);
      }

      insertMemory.run(
        parentId,
        input.content,
        input.content_type ?? "text",
        input.source ?? "manual",
        input.source_uri ?? null,
        attribution.provider,
        attribution.model_id,
        attribution.model_name,
        attribution.agent,
        attribution.session_id,
        attribution.conversation_id,
        null, // No embedding for parent
        contentHash,
        isIndexed ? 1 : 0,
        isMetadata ? 1 : 0,
        input.importance ?? 0.5,
        input.valence ?? 0,
        input.parent_id ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        input.tier ?? "episodic",
        input.expires_at ?? null,
        input.namespace ?? null,
        now,
        now
      );

      if (input.tags) {
        for (const tag of input.tags) {
          insertTag.run(parentId, tag);
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    // Insert chunks with individual embeddings
    const insertChunk = this.db.prepare(`
      INSERT INTO memories (id, content, content_type, source, source_uri, provider, model_id, model_name, agent, session_id, conversation_id, embedding, content_hash, is_indexed, is_metadata, importance, valence, parent_id, chunk_index, metadata, tier, expires_at, namespace, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const provider = isIndexed ? await getEmbeddingProvider().catch(() => null) : null;
    for (let i = 0; i < chunks.length; i++) {
      const chunkId = ulid();
      let chunkEmbeddingBlob: Uint8Array | null = null;

      if (provider) {
        try {
          const embedding = await provider.embed(chunks[i]);
          chunkEmbeddingBlob = new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);
        } catch {
          // Skip embedding for this chunk
        }
      }

      this.db.exec("BEGIN");
      try {
        insertChunk.run(
          chunkId,
          chunks[i],
          input.content_type ?? "text",
          input.source ?? "manual",
          input.source_uri ?? null,
          attribution.provider,
          attribution.model_id,
          attribution.model_name,
          attribution.agent,
          attribution.session_id,
          attribution.conversation_id,
          chunkEmbeddingBlob,
          computeContentHashForDb(this.db, chunks[i]),
          isIndexed ? 1 : 0,
          isMetadata ? 1 : 0,
          input.importance ?? 0.5,
          input.valence ?? 0,
          parentId,
          i,
          input.metadata ? JSON.stringify(input.metadata) : null,
          input.tier ?? "episodic",
          input.expires_at ?? null,
          input.namespace ?? null,
          now,
          now
        );

        // Copy tags to chunks so tag filtering works
        if (input.tags) {
          for (const tag of input.tags) {
            insertTag.run(chunkId, tag);
          }
        }
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    }

    if (isIndexed) {
      // Entity extraction runs on full content, linked to parent
      try {
        const extracted = extractEntities(input.content).filter(e => e.confidence >= 0.5);
        if (extracted.length > 0) {
          const entityStore = new EntityStore(this.db);
          const entityIdMap = new Map<string, string>();

          for (const entity of extracted) {
            let existing = entityStore.getByName(entity.name);
            if (!existing) {
              existing = entityStore.create({ name: entity.name, type: entity.type });
            } else if (existing.type === "concept" && entity.type !== "concept" && entity.confidence >= 0.85) {
              entityStore.update(existing.id, { type: entity.type });
              existing = { ...existing, type: entity.type };
            }
            entityStore.linkMemory(existing.id, parentId, entity.confidence);
            entityIdMap.set(entity.name.toLowerCase(), existing.id);
          }

          const relationships = extractRelationships(input.content, extracted);
          for (const rel of relationships) {
            const sourceId = entityIdMap.get(rel.source.toLowerCase());
            const targetId = entityIdMap.get(rel.target.toLowerCase());
            if (sourceId && targetId) {
              entityStore.addRelationship(sourceId, targetId, rel.relationship, rel.confidence, parentId, rel.context);
            }
          }
        }
      } catch {
        // Entity extraction is non-critical
      }

      // Auto-generate tags for parent and chunks
      try {
        const autoTaggingEnabled = getSetting(this.db, "auto_tagging.enabled") !== "false";
        if (autoTaggingEnabled) {
          const aliasMap = getTagAliasMap(this.db);
          const chunkCanonicalMap = getCanonicalMap(this.db);
          const autoTags = canonicalizeTags(normalizeTags(autoGenerateTags(input.content), aliasMap), chunkCanonicalMap).tags;
          if (autoTags.length > 0) {
            const existingTags = new Set(input.tags ?? []);
            const newTags = autoTags.filter((t) => !existingTags.has(t));
            if (newTags.length > 0) {
              const insertAutoTag = this.db.prepare(
                "INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)"
              );
              // Add auto-tags to parent
              for (const tag of newTags) {
                insertAutoTag.run(parentId, tag);
              }
              // Add auto-tags to chunks so tag filtering works
              const chunkRows = this.db
                .prepare("SELECT id FROM memories WHERE parent_id = ?")
                .all(parentId) as Array<{ id: string }>;
              for (const chunk of chunkRows) {
                for (const tag of newTags) {
                  insertAutoTag.run(chunk.id, tag);
                }
              }
            }
          }
        }
      } catch {
        // Auto-tagging is non-critical
      }

      // Generate keywords for parent
      try {
        const allTags = this.db
          .prepare("SELECT tag FROM memory_tags WHERE memory_id = ?")
          .all(parentId) as Array<{ tag: string }>;
        const tagNames = allTags.map((t) => t.tag);

        const entityRows = this.db
          .prepare(
            "SELECT e.name FROM entities e INNER JOIN memory_entities me ON e.id = me.entity_id WHERE me.memory_id = ?"
          )
          .all(parentId) as Array<{ name: string }>;
        const entityNames = entityRows.map((e) => e.name);

        const keywords = generateKeywords(input.content, tagNames, entityNames);
        if (keywords.length > 0) {
          this.db
            .prepare("UPDATE memories SET keywords = ? WHERE id = ?")
            .run(keywords, parentId);
        }
      } catch {
        // Non-critical
      }
    }

    return this.getById(parentId) as Promise<Memory>;
  }

  async getById(id: string): Promise<Memory | null> {
    const row = this.db
      .prepare("SELECT * FROM memories WHERE id = ?")
      .get(id) as MemoryRow | undefined;

    if (!row) return null;

    const tags = this.db
      .prepare("SELECT tag FROM memory_tags WHERE memory_id = ?")
      .all(id) as Array<{ tag: string }>;

    return rowToMemory(
      row,
      tags.map((t) => t.tag)
    );
  }

  async getByIds(ids: string[]): Promise<Memory[]> {
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
      .all(...ids) as unknown as MemoryRow[];

    if (rows.length === 0) return [];

    const tagRows = this.db
      .prepare(`SELECT memory_id, tag FROM memory_tags WHERE memory_id IN (${placeholders})`)
      .all(...ids) as Array<{ memory_id: string; tag: string }>;

    const tagMap = new Map<string, string[]>();
    for (const { memory_id, tag } of tagRows) {
      const arr = tagMap.get(memory_id);
      if (arr) arr.push(tag);
      else tagMap.set(memory_id, [tag]);
    }

    const memoryMap = new Map<string, Memory>();
    for (const row of rows) {
      memoryMap.set(row.id, rowToMemory(row, tagMap.get(row.id) ?? []));
    }

    return ids
      .map((id) => memoryMap.get(id))
      .filter((m): m is Memory => Boolean(m));
  }

  async update(id: string, input: UpdateMemoryInput): Promise<Memory | null> {
    const existing = await this.getById(id);
    if (!existing) return null;
    const aliasMap = getTagAliasMap(this.db);
    const canonicalMap = getCanonicalMap(this.db);
    const metadataTags = getMetadataTags(this.db, aliasMap);
    const normalizedTagUpdate =
      input.tags !== undefined ? canonicalizeTags(normalizeTags(input.tags, aliasMap), canonicalMap).tags : undefined;
    let mergedMetadata: Record<string, unknown> = existing.metadata
      ? { ...existing.metadata }
      : {};
    const rowState = this.db
      .prepare("SELECT is_indexed FROM memories WHERE id = ?")
      .get(id) as { is_indexed: number } | undefined;
    const isIndexed = (rowState?.is_indexed ?? 1) === 1;

    const now = new Date().toISOString().replace("T", " ").replace("Z", "");
    const sets: string[] = ["updated_at = ?"];
    const params: (string | number | Uint8Array | null)[] = [now];
    let replaceChunksContent: string | null = null;
    let shouldReplaceChunks = false;
    let shouldDeleteExistingChunks = false;

    if (input.content !== undefined) {
      const stripped = stripPrivateContent(input.content);
      if (stripped.length === 0) {
        throw new Error("Memory content is empty after stripping private blocks");
      }
      sets.push("content = ?");
      params.push(stripped);
      sets.push("content_hash = ?");
      params.push(computeContentHashForDb(this.db, stripped));

      const hasChildren = Boolean(
        this.db
          .prepare("SELECT 1 FROM memories WHERE parent_id = ? LIMIT 1")
          .get(id)
      );
      const isChunkParent = existing.parent_id === null && hasChildren;

      if (isChunkParent) {
        shouldDeleteExistingChunks = true;

        const chunkingEnabled = getSetting(this.db, "chunking.enabled") !== "false";
        const maxLength = parseInt(
          getSetting(this.db, "chunking.max_length") ?? "1500",
          10
        );

        if (chunkingEnabled && stripped.length > maxLength) {
          shouldReplaceChunks = true;
          replaceChunksContent = stripped;
          // Parent rows in chunked mode keep no embedding.
          sets.push("embedding = ?");
          params.push(null);
        } else {
          // Dechunk: short content should live only on parent.
          if (isIndexed) {
            try {
              const provider = await getEmbeddingProvider();
              const embedding = await provider.embed(stripped);
              sets.push("embedding = ?");
              params.push(
                new Uint8Array(
                  embedding.buffer,
                  embedding.byteOffset,
                  embedding.byteLength
                )
              );
            } catch {
              // Skip re-embedding on failure
            }
          }
        }
      } else {
        // Re-embed on content change
        if (isIndexed) {
          try {
            const provider = await getEmbeddingProvider();
            const embedding = await provider.embed(stripped);
            sets.push("embedding = ?");
            params.push(
              new Uint8Array(
                embedding.buffer,
                embedding.byteOffset,
                embedding.byteLength
              )
            );
          } catch {
            // Skip re-embedding on failure
          }
        }
      }
    }

    if (input.content_type !== undefined) {
      sets.push("content_type = ?");
      params.push(input.content_type);
    }

    if (input.source_uri !== undefined) {
      sets.push("source_uri = ?");
      params.push(input.source_uri);
    }

    if (input.importance !== undefined) {
      sets.push("importance = ?");
      params.push(input.importance);
    }

    if (input.valence !== undefined) {
      sets.push("valence = ?");
      params.push(input.valence);
    }

    if (input.is_active !== undefined) {
      sets.push("is_active = ?");
      params.push(input.is_active ? 1 : 0);
    }

    if (input.expires_at !== undefined) {
      sets.push("expires_at = ?");
      params.push(input.expires_at);
    }

    if (input.namespace !== undefined) {
      sets.push("namespace = ?");
      params.push(input.namespace);
    }

    if (input.metadata !== undefined) {
      // Merge with existing metadata: new keys added, null values delete keys
      for (const [k, v] of Object.entries(input.metadata)) {
        if (v === null) {
          delete mergedMetadata[k];
        } else {
          mergedMetadata[k] = v;
        }
      }
      sets.push("metadata = ?");
      params.push(
        Object.keys(mergedMetadata).length > 0
          ? JSON.stringify(mergedMetadata)
          : null
      );
    }

    const attributionUpdates = resolveUpdateAttribution(input, mergedMetadata);
    if (attributionUpdates.provider !== undefined) {
      sets.push("provider = ?");
      params.push(attributionUpdates.provider);
    }
    if (attributionUpdates.model_id !== undefined) {
      sets.push("model_id = ?");
      params.push(attributionUpdates.model_id);
    }
    if (attributionUpdates.model_name !== undefined) {
      sets.push("model_name = ?");
      params.push(attributionUpdates.model_name);
    }
    if (attributionUpdates.agent !== undefined) {
      sets.push("agent = ?");
      params.push(attributionUpdates.agent);
    }
    if (attributionUpdates.session_id !== undefined) {
      sets.push("session_id = ?");
      params.push(attributionUpdates.session_id);
    }
    if (attributionUpdates.conversation_id !== undefined) {
      sets.push("conversation_id = ?");
      params.push(attributionUpdates.conversation_id);
    }

    if (input.tier !== undefined) {
      sets.push("tier = ?");
      params.push(input.tier);
    }

    const shouldRecomputeMetadataFlag =
      input.is_metadata !== undefined ||
      normalizedTagUpdate !== undefined ||
      input.metadata !== undefined;
    if (shouldRecomputeMetadataFlag) {
      const inferredMetadata = inferIsMetadata({
        explicit: input.is_metadata,
        tags: normalizedTagUpdate ?? existing.tags ?? [],
        metadata: mergedMetadata,
        metadataTags,
      });
      sets.push("is_metadata = ?");
      params.push(inferredMetadata ? 1 : 0);
    }

    params.push(id);

    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`)
        .run(...params);

      if (input.tags !== undefined) {
        this.db
          .prepare("DELETE FROM memory_tags WHERE memory_id = ?")
          .run(id);
        const insertTag = this.db.prepare(
          "INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)"
        );
        for (const tag of normalizedTagUpdate ?? []) {
          insertTag.run(id, tag);
        }
      }

      if (shouldDeleteExistingChunks) {
        this.db
          .prepare("DELETE FROM memories WHERE parent_id = ?")
          .run(id);
      }

      if (shouldReplaceChunks && replaceChunksContent !== null) {
        const targetSize = parseInt(
          getSetting(this.db, "chunking.target_size") ?? "500",
          10
        );
        const chunks = splitIntoChunks(replaceChunksContent, { targetSize });
        const parentRow = this.db
          .prepare(
            "SELECT content_type, source, source_uri, provider, model_id, model_name, agent, session_id, conversation_id, importance, valence, metadata, is_indexed, is_metadata, tier FROM memories WHERE id = ?"
          )
          .get(id) as
          | {
              content_type: string;
              source: string;
              source_uri: string | null;
              provider: string | null;
              model_id: string | null;
              model_name: string | null;
              agent: string | null;
              session_id: string | null;
              conversation_id: string | null;
              importance: number;
              valence: number;
              metadata: string | null;
              is_indexed: number;
              is_metadata: number;
              tier: string;
            }
          | undefined;

        if (parentRow) {
          const parentTags = this.db
            .prepare("SELECT tag FROM memory_tags WHERE memory_id = ?")
            .all(id) as Array<{ tag: string }>;

          const insertChunk = this.db.prepare(`
            INSERT INTO memories (id, content, content_type, source, source_uri, provider, model_id, model_name, agent, session_id, conversation_id, embedding, content_hash, is_indexed, is_metadata, importance, valence, parent_id, chunk_index, metadata, tier, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          const insertTag = this.db.prepare(
            "INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)"
          );

          for (let i = 0; i < chunks.length; i++) {
            const chunkId = ulid();
            let chunkEmbeddingBlob: Uint8Array | null = null;

            if (parentRow.is_indexed === 1) {
              try {
                const provider = await getEmbeddingProvider();
                const embedding = await provider.embed(chunks[i]);
                chunkEmbeddingBlob = new Uint8Array(
                  embedding.buffer,
                  embedding.byteOffset,
                  embedding.byteLength
                );
              } catch {
                // Keep chunk even if embedding generation fails.
              }
            }

            insertChunk.run(
              chunkId,
              chunks[i],
              parentRow.content_type,
              parentRow.source,
              parentRow.source_uri,
              parentRow.provider,
              parentRow.model_id,
              parentRow.model_name,
              parentRow.agent,
              parentRow.session_id,
              parentRow.conversation_id,
              chunkEmbeddingBlob,
              computeContentHashForDb(this.db, chunks[i]),
              parentRow.is_indexed,
              parentRow.is_metadata,
              parentRow.importance,
              parentRow.valence,
              id,
              i,
              parentRow.metadata,
              parentRow.tier ?? "episodic",
              now,
              now
            );

            for (const tag of parentTags) {
              insertTag.run(chunkId, tag.tag);
            }
          }
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    // Regenerate keywords on content or tag change
    if (input.content !== undefined || input.tags !== undefined) {
      try {
        const current = this.db
          .prepare("SELECT content FROM memories WHERE id = ?")
          .get(id) as { content: string } | undefined;
        if (current) {
          const allTags = this.db
            .prepare("SELECT tag FROM memory_tags WHERE memory_id = ?")
            .all(id) as Array<{ tag: string }>;
          const tagNames = allTags.map((t) => t.tag);

          const entityRows = this.db
            .prepare(
              "SELECT e.name FROM entities e INNER JOIN memory_entities me ON e.id = me.entity_id WHERE me.memory_id = ?"
            )
            .all(id) as Array<{ name: string }>;
          const entityNames = entityRows.map((e) => e.name);

          const keywords = generateKeywords(current.content, tagNames, entityNames);
          this.db
            .prepare("UPDATE memories SET keywords = ? WHERE id = ?")
            .run(keywords || null, id);
        }
      } catch {
        // Non-critical
      }
    }

    return this.getById(id);
  }

  async delete(id: string): Promise<boolean> {
    const existing = this.db
      .prepare("SELECT id FROM memories WHERE id = ?")
      .get(id) as { id: string } | undefined;
    if (!existing) return false;

    this.db.exec("BEGIN");
    try {
      // Explicitly delete child chunks first. parent_id uses ON DELETE SET NULL
      // in existing schemas, so parent delete alone would orphan chunks.
      this.db
        .prepare("DELETE FROM memories WHERE parent_id = ?")
        .run(id);
      this.db
        .prepare("DELETE FROM memories WHERE id = ?")
        .run(id);
      this.db.exec("COMMIT");
      return true;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async getArchived(limit = 20, offset = 0): Promise<Memory[]> {
    const rows = this.db
      .prepare("SELECT * FROM memories WHERE is_active = 0 ORDER BY updated_at DESC LIMIT ? OFFSET ?")
      .all(limit, offset) as unknown as MemoryRow[];

    return Promise.all(
      rows.map(async (row) => {
        const tags = this.db
          .prepare("SELECT tag FROM memory_tags WHERE memory_id = ?")
          .all(row.id) as Array<{ tag: string }>;
        return rowToMemory(row, tags.map((t) => t.tag));
      })
    );
  }

  async restore(id: string): Promise<boolean> {
    const now = new Date().toISOString().replace("T", " ").replace("Z", "");
    const result = this.db
      .prepare("UPDATE memories SET is_active = 1, superseded_by = NULL, updated_at = ? WHERE id = ? AND is_active = 0")
      .run(now, id);
    return (result as { changes: number }).changes > 0;
  }

  async getRecent(limit = 20, offset = 0, tags?: string[], namespace?: string): Promise<Memory[]> {
    let sql: string;
    let params: (string | number)[];
    const normalizedTags = normalizeTags(tags, getTagAliasMap(this.db));

    const nsCondition = namespace ? " AND m.namespace = ?" : "";
    const nsConditionNoAlias = namespace ? " AND namespace = ?" : "";
    const nsParams: string[] = namespace ? [namespace] : [];

    if (normalizedTags.length > 0) {
      const placeholders = normalizedTags.map(() => "?").join(", ");
      sql = `SELECT DISTINCT m.* FROM memories m INNER JOIN memory_tags mt ON m.id = mt.memory_id AND mt.tag IN (${placeholders}) WHERE m.is_active = 1${nsCondition} ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?`;
      params = [...normalizedTags, ...nsParams, limit, offset];
    } else {
      sql = `SELECT * FROM memories m WHERE m.is_active = 1${nsCondition} ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?`;
      params = [...nsParams, limit, offset];
    }

    const rows = this.db.prepare(sql).all(...params) as unknown as MemoryRow[];

    return Promise.all(
      rows.map(async (row) => {
        const rowTags = this.db
          .prepare("SELECT tag FROM memory_tags WHERE memory_id = ?")
          .all(row.id) as Array<{ tag: string }>;
        return rowToMemory(
          row,
          rowTags.map((t) => t.tag)
        );
      })
    );
  }

  async recordAccess(memoryId: string, query?: string): Promise<void> {
    const now = new Date().toISOString().replace("T", " ").replace("Z", "");

    // Read reinforcement settings
    const rawAccessBoost = parseFloat(getSetting(this.db, "reinforcement.access_boost") ?? "0.01");
    const accessBoost = Number.isFinite(rawAccessBoost) ? rawAccessBoost : 0.01;
    const rawLinkBoost = parseFloat(getSetting(this.db, "reinforcement.link_boost") ?? "0.005");
    const linkBoost = Number.isFinite(rawLinkBoost) ? rawLinkBoost : 0.005;

    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?"
        )
        .run(now, memoryId);

      // Read-triggered reinforcement: bump importance for accessed memory
      if (accessBoost > 0) {
        this.db
          .prepare(
            "UPDATE memories SET importance = MIN(importance + ?, 0.95) WHERE id = ? AND importance < 0.9"
          )
          .run(accessBoost, memoryId);
      }

      // Reinforce 1-hop linked memories at a lower rate
      if (linkBoost > 0) {
        const linkStore = new MemoryLinkStore(this.db);
        const linkedIds = linkStore.getLinkedIds([memoryId]);
        if (linkedIds.length > 0) {
          const placeholders = linkedIds.map(() => "?").join(", ");
          this.db
            .prepare(
              `UPDATE memories SET importance = MIN(importance + ?, 0.85) WHERE id IN (${placeholders}) AND importance < 0.8`
            )
            .run(linkBoost, ...linkedIds);
        }
      }

      this.db
        .prepare(
          "INSERT INTO access_log (memory_id, query, accessed_at) VALUES (?, ?, ?)"
        )
        .run(memoryId, query ?? null, now);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  incrementUsefulCount(id: string): void {
    this.db
      .prepare("UPDATE memories SET useful_count = useful_count + 1 WHERE id = ?")
      .run(id);
  }

  private async mergeIntoExisting(
    existingId: string,
    input: CreateMemoryInput,
    now: string,
    similarity: number
  ): Promise<CreateMemoryResult> {
    const existing = await this.getById(existingId);
    if (!existing) {
      throw new Error(`Merge target ${existingId} not found`);
    }

    const mergedContent = `${existing.content}\n\n---\n\n${input.content}`;
    const contentHash = computeContentHashForDb(this.db, mergedContent);

    // Re-embed the merged content
    let embeddingBlob: Uint8Array | null = null;
    try {
      const provider = await getEmbeddingProvider();
      const embedding = await provider.embed(mergedContent);
      embeddingBlob = new Uint8Array(
        embedding.buffer,
        embedding.byteOffset,
        embedding.byteLength
      );
    } catch {
      // Skip re-embedding on failure
    }

    this.db.exec("BEGIN");
    try {
      const sets = [
        "content = ?",
        "content_hash = ?",
        "updated_at = ?",
      ];
      const params: (string | number | Uint8Array | null)[] = [
        mergedContent,
        contentHash,
        now,
      ];

      if (embeddingBlob) {
        sets.push("embedding = ?");
        params.push(embeddingBlob);
      }

      // Take the higher importance
      if (input.importance !== undefined && input.importance > existing.importance) {
        sets.push("importance = ?");
        params.push(input.importance);
      }

      params.push(existingId);
      this.db
        .prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`)
        .run(...params);

      // Merge tags
      if (input.tags && input.tags.length > 0) {
        const insertTag = this.db.prepare(
          "INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)"
        );
        for (const tag of input.tags) {
          insertTag.run(existingId, tag);
        }
      }

      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    incrementCounter(this.db, "memory.dedup_merged");

    const updated = await this.getById(existingId);
    if (!updated) {
      throw new Error(`Merged memory ${existingId} disappeared`);
    }

    return {
      memory: updated,
      superseded_id: existingId,
      dedup_similarity: similarity,
      dedup_action: "merged",
    };
  }

  bulkAddTags(ids: string[], tags: string[]): void {
    if (ids.length === 0 || tags.length === 0) return;
    const aliasMap = getTagAliasMap(this.db);
    const canonicalMap = getCanonicalMap(this.db);
    const normalizedTags = canonicalizeTags(normalizeTags(tags, aliasMap), canonicalMap).tags;
    const insertTag = this.db.prepare(
      "INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)"
    );
    const now = new Date().toISOString().replace("T", " ").replace("Z", "");
    const updateTime = this.db.prepare(
      "UPDATE memories SET updated_at = ? WHERE id = ?"
    );

    this.db.exec("BEGIN");
    try {
      for (const id of ids) {
        for (const tag of normalizedTags) {
          insertTag.run(id, tag);
        }
        updateTime.run(now, id);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  bulkRemoveTags(ids: string[], tags: string[]): void {
    if (ids.length === 0 || tags.length === 0) return;
    const aliasMap = getTagAliasMap(this.db);
    const normalizedTags = normalizeTags(tags, aliasMap);
    const now = new Date().toISOString().replace("T", " ").replace("Z", "");
    const updateTime = this.db.prepare(
      "UPDATE memories SET updated_at = ? WHERE id = ?"
    );

    this.db.exec("BEGIN");
    try {
      for (const id of ids) {
        for (const tag of normalizedTags) {
          this.db
            .prepare("DELETE FROM memory_tags WHERE memory_id = ? AND tag = ?")
            .run(id, tag);
        }
        updateTime.run(now, id);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  bulkUpdateImportance(ids: string[], importance: number): void {
    if (ids.length === 0) return;
    const now = new Date().toISOString().replace("T", " ").replace("Z", "");
    const update = this.db.prepare(
      "UPDATE memories SET importance = ?, updated_at = ? WHERE id = ?"
    );

    this.db.exec("BEGIN");
    try {
      for (const id of ids) {
        update.run(importance, now, id);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async getDiff(since: string, limit = 50, namespace?: string): Promise<{
    created: Memory[];
    updated: Memory[];
    archived: Memory[];
  }> {
    const nsFilter = namespace ? " AND namespace = ?" : "";
    const nsParams: string[] = namespace ? [namespace] : [];

    const createdRows = this.db
      .prepare(
        `SELECT * FROM memories WHERE created_at > ? AND is_active = 1${nsFilter} ORDER BY created_at DESC LIMIT ?`
      )
      .all(since, ...nsParams, limit) as unknown as MemoryRow[];

    const updatedRows = this.db
      .prepare(
        `SELECT * FROM memories WHERE updated_at > ? AND created_at <= ? AND is_active = 1${nsFilter} ORDER BY updated_at DESC LIMIT ?`
      )
      .all(since, since, ...nsParams, limit) as unknown as MemoryRow[];

    const archivedRows = this.db
      .prepare(
        `SELECT * FROM memories WHERE updated_at > ? AND is_active = 0 AND created_at <= ?${nsFilter} ORDER BY updated_at DESC LIMIT ?`
      )
      .all(since, since, ...nsParams, limit) as unknown as MemoryRow[];

    const allIds = [
      ...createdRows.map((r) => r.id),
      ...updatedRows.map((r) => r.id),
      ...archivedRows.map((r) => r.id),
    ];

    let tagMap = new Map<string, string[]>();
    if (allIds.length > 0) {
      const placeholders = allIds.map(() => "?").join(", ");
      const tagRows = this.db
        .prepare(`SELECT memory_id, tag FROM memory_tags WHERE memory_id IN (${placeholders})`)
        .all(...allIds) as Array<{ memory_id: string; tag: string }>;
      for (const t of tagRows) {
        const arr = tagMap.get(t.memory_id);
        if (arr) arr.push(t.tag);
        else tagMap.set(t.memory_id, [t.tag]);
      }
    }

    const toMemory = (row: MemoryRow) => rowToMemory(row, tagMap.get(row.id) ?? []);

    return {
      created: createdRows.map(toMemory),
      updated: updatedRows.map(toMemory),
      archived: archivedRows.map(toMemory),
    };
  }

  async getStats(): Promise<MemoryStats> {
    const total = this.db
      .prepare("SELECT COUNT(*) as count FROM memories")
      .get() as { count: number };

    const active = this.db
      .prepare("SELECT COUNT(*) as count FROM memories WHERE is_active = 1")
      .get() as { count: number };

    const byType = this.db
      .prepare(
        "SELECT content_type, COUNT(*) as count FROM memories GROUP BY content_type"
      )
      .all() as Array<{ content_type: string; count: number }>;

    const bySource = this.db
      .prepare(
        "SELECT source, COUNT(*) as count FROM memories GROUP BY source"
      )
      .all() as Array<{ source: string; count: number }>;

    const byTier = this.db
      .prepare(
        "SELECT tier, COUNT(*) as count FROM memories WHERE is_active = 1 GROUP BY tier"
      )
      .all() as Array<{ tier: string; count: number }>;

    const entityCount = this.db
      .prepare("SELECT COUNT(*) as count FROM entities")
      .get() as { count: number };

    const tagCount = this.db
      .prepare("SELECT COUNT(DISTINCT tag) as count FROM memory_tags")
      .get() as { count: number };

    const oldest = this.db
      .prepare(
        "SELECT created_at FROM memories ORDER BY created_at ASC LIMIT 1"
      )
      .get() as { created_at: string } | undefined;

    const newest = this.db
      .prepare(
        "SELECT created_at FROM memories ORDER BY created_at DESC LIMIT 1"
      )
      .get() as { created_at: string } | undefined;

    return {
      total_memories: total.count,
      active_memories: active.count,
      by_content_type: Object.fromEntries(
        byType.map((r) => [r.content_type, r.count])
      ),
      by_source: Object.fromEntries(
        bySource.map((r) => [r.source, r.count])
      ),
      by_tier: Object.fromEntries(
        byTier.map((r) => [r.tier, r.count])
      ),
      total_entities: entityCount.count,
      total_tags: tagCount.count,
      oldest_memory: oldest?.created_at ?? null,
      newest_memory: newest?.created_at ?? null,
    };
  }
}
