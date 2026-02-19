import type { DatabaseSync } from "node:sqlite";
import { EntityStore } from "../entities/store.js";

export interface DensifyOptions {
  dryRun?: boolean;
  minCoOccurrences?: number; // default 2
  limit?: number; // default 500
}

export interface DensifyResult {
  pairsAnalyzed: number;
  relationshipsCreated: number;
  dry_run: boolean;
}

/**
 * Densify the entity graph by creating "co_occurs" relationships
 * between entities that share memories but have no existing relationship.
 */
export function densifyEntityGraph(
  db: DatabaseSync,
  opts?: DensifyOptions
): DensifyResult {
  const dryRun = opts?.dryRun ?? false;
  const minCoOccurrences = opts?.minCoOccurrences ?? 2;
  const limit = opts?.limit ?? 500;

  // Find entity pairs sharing memories with no existing relationship
  const pairs = db
    .prepare(
      `SELECT me1.entity_id AS a, me2.entity_id AS b,
              COUNT(DISTINCT me1.memory_id) AS shared,
              MIN(me1.memory_id) AS first_memory
       FROM memory_entities me1
       JOIN memory_entities me2 ON me1.memory_id = me2.memory_id AND me1.entity_id < me2.entity_id
       WHERE NOT EXISTS (
         SELECT 1 FROM entity_relationships er
         WHERE (er.source_entity_id = me1.entity_id AND er.target_entity_id = me2.entity_id)
            OR (er.source_entity_id = me2.entity_id AND er.target_entity_id = me1.entity_id)
       )
       GROUP BY me1.entity_id, me2.entity_id
       HAVING shared >= ?
       ORDER BY shared DESC LIMIT ?`
    )
    .all(minCoOccurrences, limit) as Array<{
    a: string;
    b: string;
    shared: number;
    first_memory: string;
  }>;

  let relationshipsCreated = 0;

  if (!dryRun && pairs.length > 0) {
    const entityStore = new EntityStore(db);

    for (const pair of pairs) {
      const confidence = Math.min(0.9, 0.3 + (pair.shared / 10) * 0.6);
      entityStore.addRelationship(
        pair.a,
        pair.b,
        "co_occurs",
        confidence,
        pair.first_memory
      );
      relationshipsCreated++;
    }
  } else if (dryRun) {
    relationshipsCreated = pairs.length;
  }

  return {
    pairsAnalyzed: pairs.length,
    relationshipsCreated,
    dry_run: dryRun,
  };
}
