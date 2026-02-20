import type { DatabaseSync } from "node:sqlite";
import { ulid } from "ulid";
import type { Entity, EntityType, CreateEntityInput, EntityRelationship } from "./types.js";

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
    aliases: JSON.parse(row.aliases),
    metadata: JSON.parse(row.metadata),
    tags,
  };
}

export class EntityStore {
  constructor(private db: DatabaseSync) {}

  create(input: CreateEntityInput): Entity {
    const id = ulid();
    const now = new Date().toISOString().replace("T", " ").replace("Z", "");

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

    if (input.tags && input.tags.length > 0) {
      const insertTag = this.db.prepare(
        "INSERT OR IGNORE INTO entity_tags (entity_id, tag) VALUES (?, ?)"
      );
      for (const tag of input.tags) {
        insertTag.run(id, tag);
      }
    }

    return this.getById(id)!;
  }

  getById(id: string): Entity | null {
    const row = this.db
      .prepare("SELECT * FROM entities WHERE id = ?")
      .get(id) as unknown as EntityRow | undefined;
    if (!row) return null;
    const tags = (this.db.prepare("SELECT tag FROM entity_tags WHERE entity_id = ?").all(id) as Array<{ tag: string }>).map((t) => t.tag);
    return rowToEntity(row, tags);
  }

  getByName(name: string): Entity | null {
    const row = this.db
      .prepare("SELECT * FROM entities WHERE name = ? COLLATE NOCASE")
      .get(name) as unknown as EntityRow | undefined;
    if (!row) return null;
    const tags = (this.db.prepare("SELECT tag FROM entity_tags WHERE entity_id = ?").all(row.id) as Array<{ tag: string }>).map((t) => t.tag);
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

    // Batch-fetch tags for all results
    const tagStmt = this.db.prepare("SELECT tag FROM entity_tags WHERE entity_id = ?");
    return rows.map((row) => {
      const tags = (tagStmt.all(row.id) as Array<{ tag: string }>).map((t) => t.tag);
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
    const rows = this.db
      .prepare(
        "SELECT memory_id FROM memory_entities WHERE entity_id = ? ORDER BY relevance DESC"
      )
      .all(entityId) as unknown as Array<{ memory_id: string }>;
    return rows.map((r) => r.memory_id);
  }

  linkMemory(entityId: string, memoryId: string, relevance = 1.0): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO memory_entities (entity_id, memory_id, relevance) VALUES (?, ?, ?)"
      )
      .run(entityId, memoryId, relevance);
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

  getRelatedEntities(entityId: string): Array<{ entity: Entity; relationship: string; direction: "outgoing" | "incoming"; context: string | null }> {
    const rels = this.getRelationships(entityId);
    const results: Array<{ entity: Entity; relationship: string; direction: "outgoing" | "incoming"; context: string | null }> = [];

    for (const rel of rels) {
      if (rel.source_entity_id === entityId) {
        const target = this.getById(rel.target_entity_id);
        if (target) {
          results.push({ entity: target, relationship: rel.relationship, direction: "outgoing", context: rel.context });
        }
      } else {
        const source = this.getById(rel.source_entity_id);
        if (source) {
          results.push({ entity: source, relationship: rel.relationship, direction: "incoming", context: rel.context });
        }
      }
    }

    return results;
  }
}
