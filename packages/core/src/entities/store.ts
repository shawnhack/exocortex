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

function rowToEntity(row: EntityRow): Entity {
  return {
    ...row,
    aliases: JSON.parse(row.aliases),
    metadata: JSON.parse(row.metadata),
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

    return this.getById(id)!;
  }

  getById(id: string): Entity | null {
    const row = this.db
      .prepare("SELECT * FROM entities WHERE id = ?")
      .get(id) as unknown as EntityRow | undefined;
    return row ? rowToEntity(row) : null;
  }

  getByName(name: string): Entity | null {
    const row = this.db
      .prepare("SELECT * FROM entities WHERE name = ? COLLATE NOCASE")
      .get(name) as unknown as EntityRow | undefined;
    return row ? rowToEntity(row) : null;
  }

  list(type?: EntityType): Entity[] {
    let sql = "SELECT * FROM entities";
    const params: string[] = [];
    if (type) {
      sql += " WHERE type = ?";
      params.push(type);
    }
    sql += " ORDER BY name ASC";
    const rows = this.db.prepare(sql).all(...params) as unknown as EntityRow[];
    return rows.map(rowToEntity);
  }

  update(
    id: string,
    input: Partial<Pick<Entity, "name" | "type" | "aliases" | "metadata">>
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
