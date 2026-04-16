import type { DatabaseSync } from "node:sqlite";
import { ulid } from "ulid";
import type { Entity, EntityType, CreateEntityInput, EntityRelationship } from "./types.js";
import { safeJsonParse } from "../db/schema.js";

interface EntityRow {
  id: string;
  name: string;
  type: EntityType;
  aliases: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

function rowToEntity(row: EntityRow, tags: string[] = []): Entity {
  return {
    ...row,
    aliases: safeJsonParse<string[]>(row.aliases, []),
    metadata: safeJsonParse<Record<string, unknown>>(row.metadata, {}),
    tags,
  };
}

export class EntityStore {
  // Cached prepared statements for hot-path queries
  private stmtGetById: ReturnType<DatabaseSync["prepare"]>;
  private stmtGetByName: ReturnType<DatabaseSync["prepare"]>;
  private stmtGetTags: ReturnType<DatabaseSync["prepare"]>;
  private stmtGetMemories: ReturnType<DatabaseSync["prepare"]>;
  private stmtLinkMemory: ReturnType<DatabaseSync["prepare"]>;

  constructor(private db: DatabaseSync) {
    this.stmtGetById = db.prepare("SELECT * FROM entities WHERE id = ?");
    this.stmtGetByName = db.prepare("SELECT * FROM entities WHERE name = ? COLLATE NOCASE");
    this.stmtGetTags = db.prepare("SELECT tag FROM entity_tags WHERE entity_id = ?");
    this.stmtGetMemories = db.prepare("SELECT memory_id FROM memory_entities WHERE entity_id = ? ORDER BY relevance DESC");
    this.stmtLinkMemory = db.prepare("INSERT OR REPLACE INTO memory_entities (memory_id, entity_id, relevance) VALUES (?, ?, ?)");
  }

  create(input: CreateEntityInput): Entity {
    const id = ulid();
    const now = new Date().toISOString().replace("T", " ").replace("Z", "");

    try {
      this.db
        .prepare(
          "INSERT INTO entities (id, name, type, aliases, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          id,
          input.name,
          input.type ?? "concept",
          JSON.stringify(input.aliases ?? []),
          JSON.stringify(input.metadata ?? {}),
          now,
          now
        );
    } catch (err: unknown) {
      // Handle race condition: entity was created by another concurrent operation
      if (err instanceof Error && err.message.includes("UNIQUE constraint")) {
        const existing = this.getByName(input.name);
        if (existing) return existing;
      }
      throw err;
    }

    if (input.tags && input.tags.length > 0) {
      const insertTag = this.db.prepare(
        "INSERT OR IGNORE INTO entity_tags (entity_id, tag) VALUES (?, ?)"
      );
      for (const tag of input.tags) {
        insertTag.run(id, tag);
      }
    }

    const created = this.getById(id);
    if (!created) throw new Error(`Entity ${id} was inserted but could not be read back`);
    return created;
  }

  getById(id: string): Entity | null {
    const row = this.stmtGetById.get(id) as unknown as EntityRow | undefined;
    if (!row) return null;
    const tags = (this.stmtGetTags.all(id) as Array<{ tag: string }>).map((t) => t.tag);
    return rowToEntity(row, tags);
  }

  getByName(name: string): Entity | null {
    const row = this.stmtGetByName.get(name) as unknown as EntityRow | undefined;
    if (!row) return null;
    const tags = (this.stmtGetTags.all(row.id) as Array<{ tag: string }>).map((t) => t.tag);
    return rowToEntity(row, tags);
  }

  list(options?: EntityType | { type?: EntityType; tags?: string[] }): Entity[] {
    // Support legacy call signature: list("person")
    const opts = typeof options === "string" ? { type: options } : (options ?? {});

    let sql = "SELECT DISTINCT e.* FROM entities e";
    const conditions: string[] = [];
    const params: string[] = [];

    if (opts.tags && opts.tags.length > 0) {
      sql += " INNER JOIN entity_tags et ON e.id = et.entity_id";
      conditions.push(`et.tag IN (${opts.tags.map(() => "?").join(", ")})`);
      params.push(...opts.tags);
    }
    if (opts.type) {
      conditions.push("e.type = ?");
      params.push(opts.type);
    }
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }
    sql += " ORDER BY e.name ASC";
    const rows = this.db.prepare(sql).all(...params) as unknown as EntityRow[];

    // Batch-fetch tags for all results (reuse cached statement)
    return rows.map((row) => {
      const tags = (this.stmtGetTags.all(row.id) as Array<{ tag: string }>).map((t) => t.tag);
      return rowToEntity(row, tags);
    });
  }

  update(
    id: string,
    input: Partial<Pick<Entity, "name" | "type" | "aliases" | "metadata" | "tags">>
  ): Entity | null {
    const existing = this.getById(id);
    if (!existing) return null;

    const now = new Date().toISOString().replace("T", " ").replace("Z", "");
    const sets: string[] = ["updated_at = ?"];
    const params: (string | number)[] = [now];

    if (input.name !== undefined) {
      sets.push("name = ?");
      params.push(input.name);
    }
    if (input.type !== undefined) {
      sets.push("type = ?");
      params.push(input.type);
    }
    if (input.aliases !== undefined) {
      sets.push("aliases = ?");
      params.push(JSON.stringify(input.aliases));
    }
    if (input.metadata !== undefined) {
      sets.push("metadata = ?");
      params.push(JSON.stringify(input.metadata));
    }

    params.push(id);
    this.db
      .prepare(`UPDATE entities SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);

    if (input.tags !== undefined) {
      this.db.prepare("DELETE FROM entity_tags WHERE entity_id = ?").run(id);
      const insertTag = this.db.prepare(
        "INSERT OR IGNORE INTO entity_tags (entity_id, tag) VALUES (?, ?)"
      );
      for (const tag of input.tags) {
        insertTag.run(id, tag);
      }
    }

    return this.getById(id);
  }

  delete(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM entities WHERE id = ?")
      .run(id);
    return (result as { changes: number }).changes > 0;
  }

  getMemoriesForEntity(entityId: string): string[] {
    const rows = this.stmtGetMemories.all(entityId) as unknown as Array<{ memory_id: string }>;
    return rows.map((r) => r.memory_id);
  }

  linkMemory(entityId: string, memoryId: string, relevance = 1.0): void {
    this.stmtLinkMemory.run(memoryId, entityId, relevance);
  }

  addRelationship(
    sourceId: string,
    targetId: string,
    relationship: string,
    confidence = 0.7,
    memoryId?: string,
    context?: string
  ): void {
    // Deduplicate by source+target+relationship
    const existing = this.db
      .prepare(
        "SELECT id FROM entity_relationships WHERE source_entity_id = ? AND target_entity_id = ? AND relationship = ?"
      )
      .get(sourceId, targetId, relationship) as { id: string } | undefined;

    if (existing) return;

    const id = ulid();
    const now = new Date().toISOString().replace("T", " ").replace("Z", "");
    this.db
      .prepare(
        "INSERT INTO entity_relationships (id, source_entity_id, target_entity_id, relationship, confidence, memory_id, context, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(id, sourceId, targetId, relationship, confidence, memoryId ?? null, context ?? null, now);
  }

  getRelationships(entityId: string): EntityRelationship[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM entity_relationships
         WHERE source_entity_id = ? OR target_entity_id = ?
         ORDER BY created_at DESC`
      )
      .all(entityId, entityId) as unknown as EntityRelationship[];
    return rows;
  }

  listTags(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT tag FROM entity_tags ORDER BY tag")
      .all() as Array<{ tag: string }>;
    return rows.map((r) => r.tag);
  }

  /**
   * Prune orphan entities that have fewer than `minLinks` active memory links.
   * Deletion cascades via FK to memory_entities, entity_tags, entity_relationships.
   */
  pruneOrphans(minLinks = 2): { pruned: number; names: string[] } {
    const candidates = this.db.prepare(`
      SELECT e.id, e.name, COUNT(CASE WHEN m.is_active = 1 THEN 1 END) as active_links
      FROM entities e
      LEFT JOIN memory_entities me ON e.id = me.entity_id
      LEFT JOIN memories m ON me.memory_id = m.id
      GROUP BY e.id
      HAVING active_links < ?
    `).all(minLinks) as unknown as Array<{ id: string; name: string; active_links: number }>;

    if (candidates.length === 0) return { pruned: 0, names: [] };

    const names: string[] = [];
    const deleteStmt = this.db.prepare("DELETE FROM entities WHERE id = ?");

    for (const c of candidates) {
      deleteStmt.run(c.id);
      names.push(c.name);
    }

    return { pruned: names.length, names };
  }

  getRelatedEntities(entityId: string): Array<{ entity: Entity; relationship: string; direction: "outgoing" | "incoming"; context: string | null }> {
    // Single JOIN replaces N+1 (1 query for relationships + N for related entities).
    // Hot path: called by expandQuery() during every search and by memory_entities
    // tool per row (50 entities x 3 rels = 150 round-trips → 1).
    // Tags are fetched in a separate batch query, then attached.
    const rows = this.db.prepare(`
      SELECT
        r.relationship,
        r.context,
        CASE WHEN r.source_entity_id = ? THEN 'outgoing' ELSE 'incoming' END as direction,
        e.id, e.name, e.type, e.aliases, e.metadata, e.created_at, e.updated_at
      FROM entity_relationships r
      INNER JOIN entities e ON e.id = CASE WHEN r.source_entity_id = ? THEN r.target_entity_id ELSE r.source_entity_id END
      WHERE r.source_entity_id = ? OR r.target_entity_id = ?
    `).all(entityId, entityId, entityId, entityId) as unknown as Array<EntityRow & {
      relationship: string;
      context: string | null;
      direction: "outgoing" | "incoming";
    }>;

    if (rows.length === 0) return [];

    // Batch-fetch tags for all related entities in one query
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    const tagRows = this.db
      .prepare(`SELECT entity_id, tag FROM entity_tags WHERE entity_id IN (${placeholders})`)
      .all(...ids) as Array<{ entity_id: string; tag: string }>;
    const tagMap = new Map<string, string[]>();
    for (const { entity_id, tag } of tagRows) {
      const arr = tagMap.get(entity_id);
      if (arr) arr.push(tag);
      else tagMap.set(entity_id, [tag]);
    }

    return rows.map((row) => ({
      entity: rowToEntity(
        {
          id: row.id,
          name: row.name,
          type: row.type,
          aliases: row.aliases,
          metadata: row.metadata,
          created_at: row.created_at,
          updated_at: row.updated_at,
        },
        tagMap.get(row.id) ?? []
      ),
      relationship: row.relationship,
      direction: row.direction,
      context: row.context,
    }));
  }
}
