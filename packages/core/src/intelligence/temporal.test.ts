import { describe, it, expect, beforeEach } from "vitest";
import { getDbForTesting } from "../db/connection.js";
import { initializeSchema } from "../db/schema.js";
import {
  getMemoryLineage,
  getDecisionTimeline,
  getTimeline,
  getTemporalStats,
} from "./temporal.js";
import type { DatabaseSync } from "node:sqlite";

const now = () => new Date().toISOString().replace("T", " ").replace("Z", "");

function insertMemory(
  db: DatabaseSync,
  id: string,
  content: string,
  opts: { superseded_by?: string; parent_id?: string; source_uri?: string; created_at?: string } = {}
) {
  const ts = opts.created_at ?? now();
  db.prepare(
    `INSERT INTO memories (id, content, content_type, source, importance, is_active, is_indexed, superseded_by, parent_id, source_uri, created_at, updated_at)
     VALUES (?, ?, 'text', 'api', 0.5, 1, 1, ?, ?, ?, ?, ?)`
  ).run(id, content, opts.superseded_by ?? null, opts.parent_id ?? null, opts.source_uri ?? null, ts, ts);
}

function tagMemory(db: DatabaseSync, memoryId: string, tag: string) {
  db.prepare("INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)").run(memoryId, tag);
}

describe("getMemoryLineage", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getDbForTesting();
    initializeSchema(db);
  });

  it("should return empty array for non-existent memory", () => {
    const result = getMemoryLineage(db, "nonexistent");
    expect(result).toEqual([]);
  });

  it("should return only current for memory with no chain", () => {
    insertMemory(db, "mem-solo", "standalone memory");
    const result = getMemoryLineage(db, "mem-solo");
    expect(result).toHaveLength(1);
    expect(result[0].direction).toBe("current");
    expect(result[0].depth).toBe(0);
  });

  it("should walk forward through superseded_by chain", () => {
    insertMemory(db, "mem-old", "old decision", { superseded_by: "mem-mid" });
    insertMemory(db, "mem-mid", "updated decision", { superseded_by: "mem-new" });
    insertMemory(db, "mem-new", "latest decision");

    const result = getMemoryLineage(db, "mem-old");
    expect(result).toHaveLength(3);
    expect(result[0].direction).toBe("current");
    expect(result[0].id).toBe("mem-old");
    expect(result[1].direction).toBe("successor");
    expect(result[1].id).toBe("mem-mid");
    expect(result[2].direction).toBe("successor");
    expect(result[2].id).toBe("mem-new");
  });

  it("should walk backward through predecessor chain", () => {
    insertMemory(db, "mem-old", "old decision", { superseded_by: "mem-mid" });
    insertMemory(db, "mem-mid", "updated decision", { superseded_by: "mem-new" });
    insertMemory(db, "mem-new", "latest decision");

    const result = getMemoryLineage(db, "mem-new");
    expect(result).toHaveLength(3);
    expect(result[0].direction).toBe("predecessor");
    expect(result[0].id).toBe("mem-old");
    expect(result[1].direction).toBe("predecessor");
    expect(result[1].id).toBe("mem-mid");
    expect(result[2].direction).toBe("current");
    expect(result[2].id).toBe("mem-new");
  });

  it("should walk both directions from middle of chain", () => {
    insertMemory(db, "mem-old", "old", { superseded_by: "mem-mid" });
    insertMemory(db, "mem-mid", "mid", { superseded_by: "mem-new" });
    insertMemory(db, "mem-new", "new");

    const result = getMemoryLineage(db, "mem-mid");
    expect(result).toHaveLength(3);
    expect(result[0].direction).toBe("predecessor");
    expect(result[0].id).toBe("mem-old");
    expect(result[1].direction).toBe("current");
    expect(result[1].id).toBe("mem-mid");
    expect(result[2].direction).toBe("successor");
    expect(result[2].id).toBe("mem-new");
  });

  it("should not infinite-loop on cycles in supersession chain", () => {
    // Create a cycle: A → B → A
    insertMemory(db, "cycle-a", "Decision A", { superseded_by: "cycle-b" });
    insertMemory(db, "cycle-b", "Decision B", { superseded_by: "cycle-a" });

    const result = getMemoryLineage(db, "cycle-a");
    // Should terminate without hanging. Exact length doesn't matter,
    // but it should include at most the two unique memories + current.
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it("should respect maxDepth", () => {
    insertMemory(db, "m1", "one", { superseded_by: "m2" });
    insertMemory(db, "m2", "two", { superseded_by: "m3" });
    insertMemory(db, "m3", "three", { superseded_by: "m4" });
    insertMemory(db, "m4", "four");

    const result = getMemoryLineage(db, "m1", 2);
    // current + up to 2 successors
    const successors = result.filter((e) => e.direction === "successor");
    expect(successors.length).toBeLessThanOrEqual(2);
  });
});

describe("getDecisionTimeline", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getDbForTesting();
    initializeSchema(db);
  });

  it("should return empty array when no decisions exist", () => {
    const result = getDecisionTimeline(db);
    expect(result).toEqual([]);
  });

  it("should return only memories tagged 'decision'", () => {
    insertMemory(db, "dec-1", "Use PostgreSQL for the database");
    tagMemory(db, "dec-1", "decision");
    insertMemory(db, "not-dec", "Random note about lunch");
    tagMemory(db, "not-dec", "note");

    const result = getDecisionTimeline(db);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("dec-1");
    expect(result[0].tags).toContain("decision");
  });

  it("should filter by additional tags (AND with decision)", () => {
    insertMemory(db, "dec-arch", "Use microservices");
    tagMemory(db, "dec-arch", "decision");
    tagMemory(db, "dec-arch", "architecture");

    insertMemory(db, "dec-other", "Use dark mode");
    tagMemory(db, "dec-other", "decision");
    tagMemory(db, "dec-other", "ui");

    const result = getDecisionTimeline(db, { tags: ["architecture"] });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("dec-arch");
  });

  it("should include supersession links", () => {
    insertMemory(db, "dec-old", "Use MySQL", { superseded_by: "dec-new" });
    tagMemory(db, "dec-old", "decision");
    insertMemory(db, "dec-new", "Use PostgreSQL");
    tagMemory(db, "dec-new", "decision");

    const result = getDecisionTimeline(db);
    const oldEntry = result.find((e) => e.id === "dec-old");
    const newEntry = result.find((e) => e.id === "dec-new");

    expect(oldEntry?.superseded_by).toBe("dec-new");
    expect(newEntry?.supersedes).toBe("dec-old");
  });

  it("should respect limit", () => {
    for (let i = 0; i < 10; i++) {
      insertMemory(db, `dec-${i}`, `Decision ${i}`);
      tagMemory(db, `dec-${i}`, "decision");
    }
    const result = getDecisionTimeline(db, { limit: 3 });
    expect(result).toHaveLength(3);
  });

  it("should cap results per parent_id (shard dedup)", () => {
    // Create the parent memory first (FK constraint)
    insertMemory(db, "parent-doc", "Parent document");
    tagMemory(db, "parent-doc", "decision");

    // 6 shards from the same parent
    for (let i = 0; i < 6; i++) {
      insertMemory(db, `shard-${i}`, `Shard ${i} of document`, { parent_id: "parent-doc" });
      tagMemory(db, `shard-${i}`, "decision");
    }
    // 2 standalone decisions
    insertMemory(db, "standalone-1", "Standalone decision 1");
    tagMemory(db, "standalone-1", "decision");
    insertMemory(db, "standalone-2", "Standalone decision 2");
    tagMemory(db, "standalone-2", "decision");

    const result = getDecisionTimeline(db, { limit: 50 });
    const shardResults = result.filter((e) => e.id.startsWith("shard-"));
    expect(shardResults.length).toBeLessThanOrEqual(3);
    // Standalones should all pass through
    expect(result.filter((e) => e.id.startsWith("standalone-")).length).toBe(2);
  });

  it("should exclude consolidation source", () => {
    const ts = now();
    db.prepare(
      `INSERT INTO memories (id, content, content_type, source, importance, is_active, is_indexed, created_at, updated_at)
       VALUES (?, ?, 'text', 'consolidation', 0.5, 1, 1, ?, ?)`
    ).run("cons-1", "Consolidated decision", ts, ts);
    tagMemory(db, "cons-1", "decision");

    const result = getDecisionTimeline(db);
    expect(result).toHaveLength(0);
  });

  it("should filter by date range", () => {
    insertMemory(db, "dec-jan", "January decision", { created_at: "2025-01-15 12:00:00" });
    tagMemory(db, "dec-jan", "decision");
    insertMemory(db, "dec-mar", "March decision", { created_at: "2025-03-15 12:00:00" });
    tagMemory(db, "dec-mar", "decision");

    const result = getDecisionTimeline(db, { after: "2025-02-01", before: "2025-04-01" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("dec-mar");
  });
});

describe("getTimeline", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getDbForTesting();
    initializeSchema(db);
  });

  it("should return empty for empty database", () => {
    expect(getTimeline(db)).toEqual([]);
  });

  it("should group memories by date", () => {
    insertMemory(db, "m1", "Memory 1", { created_at: "2025-03-01 10:00:00" });
    insertMemory(db, "m2", "Memory 2", { created_at: "2025-03-01 14:00:00" });
    insertMemory(db, "m3", "Memory 3", { created_at: "2025-03-02 10:00:00" });

    const result = getTimeline(db);
    expect(result).toHaveLength(2);
    // Most recent first
    expect(result[0].date).toBe("2025-03-02");
    expect(result[0].count).toBe(1);
    expect(result[1].date).toBe("2025-03-01");
    expect(result[1].count).toBe(2);
  });

  it("should include memories when requested", () => {
    insertMemory(db, "m1", "Memory 1", { created_at: "2025-03-01 10:00:00" });

    const without = getTimeline(db);
    expect(without[0].memories).toEqual([]);

    const with_ = getTimeline(db, { includeMemories: true });
    expect(with_[0].memories).toHaveLength(1);
    expect(with_[0].memories[0].id).toBe("m1");
  });
});

describe("getTemporalStats", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getDbForTesting();
    initializeSchema(db);
  });

  it("should return zeros for empty database", () => {
    const stats = getTemporalStats(db);
    expect(stats.total_days).toBe(0);
    expect(stats.avg_per_day).toBe(0);
    expect(stats.most_active_day).toBeNull();
  });

  it("should compute stats correctly", () => {
    insertMemory(db, "m1", "Memory 1", { created_at: "2025-03-01 10:00:00" });
    insertMemory(db, "m2", "Memory 2", { created_at: "2025-03-01 14:00:00" });
    insertMemory(db, "m3", "Memory 3", { created_at: "2025-03-02 10:00:00" });

    const stats = getTemporalStats(db);
    expect(stats.total_days).toBe(2);
    expect(stats.avg_per_day).toBe(1.5);
    expect(stats.most_active_day).toBe("2025-03-01");
    expect(stats.most_active_count).toBe(2);
  });
});
