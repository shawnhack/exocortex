import type { DatabaseSync } from "node:sqlite";
import { ulid } from "ulid";
import { getEmbeddingProvider } from "../embedding/manager.js";
import { getSetting } from "../db/schema.js";
import { cosineSimilarity } from "./scoring.js";
import { splitIntoChunks } from "./chunking.js";
import { extractEntities, extractRelationships } from "../entities/extractor.js";
import { EntityStore } from "../entities/store.js";
import { autoGenerateTags } from "./auto-tags.js";
import { generateKeywords } from "./keywords.js";
import type {
  Memory,
  MemoryRow,
  CreateMemoryInput,
  CreateMemoryResult,
  UpdateMemoryInput,
  MemoryStats,
} from "./types.js";

function rowToMemory(row: MemoryRow, tags?: string[]): Memory {
  let embedding: Float32Array | null = null;
  if (row.embedding) {
    const bytes = row.embedding as unknown as Uint8Array;
    embedding = new Float32Array(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength / 4
    );
  }

  return {
    ...row,
    embedding,
    is_active: row.is_active === 1,
    superseded_by: row.superseded_by ?? null,
    chunk_index: row.chunk_index ?? null,
    keywords: row.keywords ?? undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
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

export class MemoryStore {
  constructor(private db: DatabaseSync) {}

  async create(input: CreateMemoryInput): Promise<CreateMemoryResult> {
    const id = ulid();
    const now = new Date().toISOString().replace("T", " ").replace("Z", "");

    // Strip <private> blocks before any processing
    const content = stripPrivateContent(input.content);
    if (content.length === 0) {
      throw new Error("Memory content is empty after stripping private blocks");
    }
    input = { ...input, content };

    // Check if chunking is needed
    const chunkingEnabled = getSetting(this.db, "chunking.enabled") !== "false";
    const maxLength = parseInt(getSetting(this.db, "chunking.max_length") ?? "1500", 10);
    const targetSize = parseInt(getSetting(this.db, "chunking.target_size") ?? "500", 10);

    if (chunkingEnabled && !input.parent_id && input.content.length > maxLength) {
      const memory = await this.createWithChunks(id, input, now, maxLength, targetSize);
      return { memory };
    }

    // Generate embedding
    let embeddingBlob: Uint8Array | null = null;
    let embeddingFloat: Float32Array | null = null;
    try {
      const provider = await getEmbeddingProvider();
      const embedding = await provider.embed(input.content);
      embeddingFloat = embedding;
      embeddingBlob = new Uint8Array(embedding.buffer);
    } catch {
      // Embedding may fail on first run while model downloads; store without
    }

    // Dedup check: find and supersede semantically similar memory
    let dedupInfo: { superseded_id: string; similarity: number } | null = null;
    if (embeddingFloat && !input.parent_id) {
      try {
        dedupInfo = this.findAndSupersede(id, input, embeddingFloat);
      } catch {
        // Dedup is non-critical
      }
    }

    const insertMemory = this.db.prepare(`
      INSERT INTO memories (id, content, content_type, source, source_uri, embedding, importance, parent_id, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertTag = this.db.prepare(
      "INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)"
    );

    this.db.exec("BEGIN");
    try {
      insertMemory.run(
        id,
        input.content,
        input.content_type ?? "text",
        input.source ?? "manual",
        input.source_uri ?? null,
        embeddingBlob,
        input.importance ?? 0.5,
        input.parent_id ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        now,
        now
      );

      if (input.tags) {
        for (const tag of input.tags) {
          insertTag.run(id, tag.toLowerCase().trim());
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    // Auto-extract and link entities + relationships
    try {
      const extracted = extractEntities(input.content);
      if (extracted.length > 0) {
        const entityStore = new EntityStore(this.db);
        const entityIdMap = new Map<string, string>();

        for (const entity of extracted) {
          let existing = entityStore.getByName(entity.name);
          if (!existing) {
            existing = entityStore.create({ name: entity.name, type: entity.type });
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
    } catch {
      // Entity extraction is non-critical — don't fail memory creation
    }

    // Auto-generate tags
    try {
      const autoTaggingEnabled = getSetting(this.db, "auto_tagging.enabled") !== "false";
      if (autoTaggingEnabled) {
        const autoTags = autoGenerateTags(input.content);
        if (autoTags.length > 0) {
          const existingTags = new Set((input.tags ?? []).map((t) => t.toLowerCase().trim()));
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
    } catch {
      // Auto-tagging is non-critical — don't fail memory creation
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
    } catch {
      // Keyword generation is non-critical
    }

    const memory = await this.getById(id) as Memory;
    const result: CreateMemoryResult = { memory };
    if (dedupInfo) {
      result.superseded_id = dedupInfo.superseded_id;
      result.dedup_similarity = dedupInfo.similarity;
    }
    return result;
  }

  /**
   * Find and supersede a semantically similar existing memory.
   * Marks the old memory as inactive with superseded_by pointing to the new ID.
   * Returns dedup info if a memory was superseded.
   */
  private findAndSupersede(
    newId: string,
    input: CreateMemoryInput,
    newEmbedding: Float32Array
  ): { superseded_id: string; similarity: number } | null {
    const dedupEnabled = getSetting(this.db, "dedup.enabled") !== "false";
    if (!dedupEnabled) return null;

    // Skip dedup for very short content — too likely to get false positives
    if (input.content.length < 50) return null;

    const threshold = parseFloat(
      getSetting(this.db, "dedup.similarity_threshold") ?? "0.85"
    );
    const candidatePool = parseInt(
      getSetting(this.db, "dedup.candidate_pool") ?? "200",
      10
    );

    // Scan recent active non-chunk memories of same content_type
    const contentType = input.content_type ?? "text";
    const candidates = this.db
      .prepare(
        `SELECT id, embedding FROM memories
         WHERE is_active = 1
           AND embedding IS NOT NULL
           AND parent_id IS NULL
           AND content_type = ?
         ORDER BY created_at DESC LIMIT ?`
      )
      .all(contentType, candidatePool) as unknown as Array<{ id: string; embedding: Uint8Array }>;

    for (const candidate of candidates) {
      const bytes = candidate.embedding as unknown as Uint8Array;
      const candidateEmbedding = new Float32Array(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength / 4
      );
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

        // Supersede: deactivate old memory
        const now = new Date().toISOString().replace("T", " ").replace("Z", "");
        this.db
          .prepare(
            "UPDATE memories SET is_active = 0, superseded_by = ?, updated_at = ? WHERE id = ?"
          )
          .run(newId, now, candidate.id);
        return { superseded_id: candidate.id, similarity };
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
    now: string,
    _maxLength: number,
    targetSize: number
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
      INSERT INTO memories (id, content, content_type, source, source_uri, embedding, importance, parent_id, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertTag = this.db.prepare(
      "INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)"
    );

    this.db.exec("BEGIN");
    try {
      insertMemory.run(
        parentId,
        input.content,
        input.content_type ?? "text",
        input.source ?? "manual",
        input.source_uri ?? null,
        null, // No embedding for parent
        input.importance ?? 0.5,
        input.parent_id ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        now,
        now
      );

      if (input.tags) {
        for (const tag of input.tags) {
          insertTag.run(parentId, tag.toLowerCase().trim());
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    // Insert chunks with individual embeddings
    const insertChunk = this.db.prepare(`
      INSERT INTO memories (id, content, content_type, source, source_uri, embedding, importance, parent_id, chunk_index, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (let i = 0; i < chunks.length; i++) {
      const chunkId = ulid();
      let chunkEmbeddingBlob: Uint8Array | null = null;

      try {
        const provider = await getEmbeddingProvider();
        const embedding = await provider.embed(chunks[i]);
        chunkEmbeddingBlob = new Uint8Array(embedding.buffer);
      } catch {
        // Skip embedding for this chunk
      }

      this.db.exec("BEGIN");
      try {
        insertChunk.run(
          chunkId,
          chunks[i],
          input.content_type ?? "text",
          input.source ?? "manual",
          input.source_uri ?? null,
          chunkEmbeddingBlob,
          input.importance ?? 0.5,
          parentId,
          i,
          input.metadata ? JSON.stringify(input.metadata) : null,
          now,
          now
        );

        // Copy tags to chunks so tag filtering works
        if (input.tags) {
          for (const tag of input.tags) {
            insertTag.run(chunkId, tag.toLowerCase().trim());
          }
        }
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    }

    // Entity extraction runs on full content, linked to parent
    try {
      const extracted = extractEntities(input.content);
      if (extracted.length > 0) {
        const entityStore = new EntityStore(this.db);
        const entityIdMap = new Map<string, string>();

        for (const entity of extracted) {
          let existing = entityStore.getByName(entity.name);
          if (!existing) {
            existing = entityStore.create({ name: entity.name, type: entity.type });
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
        const autoTags = autoGenerateTags(input.content);
        if (autoTags.length > 0) {
          const existingTags = new Set((input.tags ?? []).map((t) => t.toLowerCase().trim()));
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

    const now = new Date().toISOString().replace("T", " ").replace("Z", "");
    const sets: string[] = ["updated_at = ?"];
    const params: (string | number | Uint8Array | null)[] = [now];

    if (input.content !== undefined) {
      const stripped = stripPrivateContent(input.content);
      if (stripped.length === 0) {
        throw new Error("Memory content is empty after stripping private blocks");
      }
      sets.push("content = ?");
      params.push(stripped);

      // Re-embed on content change
      try {
        const provider = await getEmbeddingProvider();
        const embedding = await provider.embed(stripped);
        sets.push("embedding = ?");
        params.push(new Uint8Array(embedding.buffer));
      } catch {
        // Skip re-embedding on failure
      }
    }

    if (input.content_type !== undefined) {
      sets.push("content_type = ?");
      params.push(input.content_type);
    }

    if (input.importance !== undefined) {
      sets.push("importance = ?");
      params.push(input.importance);
    }

    if (input.is_active !== undefined) {
      sets.push("is_active = ?");
      params.push(input.is_active ? 1 : 0);
    }

    if (input.metadata !== undefined) {
      // Merge with existing metadata: new keys added, null values delete keys
      const existingRow = this.db
        .prepare("SELECT metadata FROM memories WHERE id = ?")
        .get(id) as { metadata: string | null } | undefined;
      const existing: Record<string, unknown> = existingRow?.metadata
        ? JSON.parse(existingRow.metadata)
        : {};
      for (const [k, v] of Object.entries(input.metadata)) {
        if (v === null) {
          delete existing[k];
        } else {
          existing[k] = v;
        }
      }
      sets.push("metadata = ?");
      params.push(Object.keys(existing).length > 0 ? JSON.stringify(existing) : null);
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
        for (const tag of input.tags) {
          insertTag.run(id, tag.toLowerCase().trim());
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
    const result = this.db
      .prepare("DELETE FROM memories WHERE id = ?")
      .run(id);
    return (result as { changes: number }).changes > 0;
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

  async getRecent(limit = 20, offset = 0, tags?: string[]): Promise<Memory[]> {
    let sql: string;
    let params: (string | number)[];

    if (tags && tags.length > 0) {
      const placeholders = tags.map(() => "?").join(", ");
      sql = `SELECT DISTINCT m.* FROM memories m INNER JOIN memory_tags mt ON m.id = mt.memory_id AND mt.tag IN (${placeholders}) WHERE m.is_active = 1 ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?`;
      params = [...tags.map((t) => t.toLowerCase().trim()), limit, offset];
    } else {
      sql = "SELECT * FROM memories WHERE is_active = 1 ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?";
      params = [limit, offset];
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

    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?"
        )
        .run(now, memoryId);

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
      total_entities: entityCount.count,
      total_tags: tagCount.count,
      oldest_memory: oldest?.created_at ?? null,
      newest_memory: newest?.created_at ?? null,
    };
  }
}
