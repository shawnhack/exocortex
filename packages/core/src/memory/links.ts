import type { DatabaseSync } from "node:sqlite";

export type LinkType =
  | "related"
  | "elaborates"
  | "contradicts"
  | "supersedes"
  | "supports"
  | "derived_from";

export interface MemoryLink {
  source_id: string;
  target_id: string;
  link_type: LinkType;
  strength: number;
  created_at: string;
}

export interface LinkedMemoryRef {
  id: string;
  linked_from: string;
  link_type: LinkType;
  strength: number;
}

export class MemoryLinkStore {
  constructor(private db: DatabaseSync) {}

  link(
    sourceId: string,
    targetId: string,
    linkType: LinkType = "related",
    strength: number = 0.5
  ): void {
    this.db
      .prepare(
        `INSERT INTO memory_links (source_id, target_id, link_type, strength)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(source_id, target_id) DO UPDATE SET
         link_type = excluded.link_type,
         strength = excluded.strength`
      )
      .run(sourceId, targetId, linkType, strength);
  }

  unlink(sourceId: string, targetId: string): boolean {
    const result = this.db
      .prepare(
        "DELETE FROM memory_links WHERE source_id = ? AND target_id = ?"
      )
      .run(sourceId, targetId);
    return result.changes > 0;
  }

  getLinks(memoryId: string): MemoryLink[] {
    return this.db
      .prepare(
        `SELECT source_id, target_id, link_type, strength, created_at
       FROM memory_links
       WHERE source_id = ? OR target_id = ?
       ORDER BY strength DESC`
      )
      .all(memoryId, memoryId) as unknown as MemoryLink[];
  }

  /**
   * Get all directly-linked memory IDs for a set of seed IDs (1-hop).
   * Returns only IDs not already in the seed set.
   */
  getLinkedIds(memoryIds: string[]): string[] {
    if (memoryIds.length === 0) return [];
    const placeholders = memoryIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT DISTINCT target_id AS id FROM memory_links WHERE source_id IN (${placeholders})
       UNION
       SELECT DISTINCT source_id AS id FROM memory_links WHERE target_id IN (${placeholders})`
      )
      .all(...memoryIds, ...memoryIds) as unknown as Array<{ id: string }>;

    const seedSet = new Set(memoryIds);
    return rows.map((r) => r.id).filter((id) => !seedSet.has(id));
  }

  /**
   * Get linked memory references with provenance (which seed linked, link type, strength).
   * Used by context-graph to annotate results.
   */
  getLinkedRefs(seedIds: string[]): LinkedMemoryRef[] {
    if (seedIds.length === 0) return [];
    const placeholders = seedIds.map(() => "?").join(", ");

    // Outgoing links: seed → target
    const outgoing = this.db
      .prepare(
        `SELECT target_id AS id, source_id AS linked_from, link_type, strength
       FROM memory_links
       WHERE source_id IN (${placeholders})
       ORDER BY strength DESC`
      )
      .all(...seedIds) as unknown as LinkedMemoryRef[];

    // Incoming links: source → seed (reverse direction)
    const incoming = this.db
      .prepare(
        `SELECT source_id AS id, target_id AS linked_from, link_type, strength
       FROM memory_links
       WHERE target_id IN (${placeholders})
       ORDER BY strength DESC`
      )
      .all(...seedIds) as unknown as LinkedMemoryRef[];

    // Merge and deduplicate, keeping highest strength per linked ID
    const seedSet = new Set(seedIds);
    const refMap = new Map<string, LinkedMemoryRef>();

    for (const ref of [...outgoing, ...incoming]) {
      if (seedSet.has(ref.id)) continue;
      const existing = refMap.get(ref.id);
      if (!existing || ref.strength > existing.strength) {
        refMap.set(ref.id, ref);
      }
    }

    return Array.from(refMap.values()).sort(
      (a, b) => b.strength - a.strength
    );
  }
}
