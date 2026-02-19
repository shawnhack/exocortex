import { describe, it, expect, beforeEach } from "vitest";
import { getDbForTesting, initializeSchema } from "@exocortex/core";
import type { DatabaseSync } from "@exocortex/core";
import { buildCoRetrievalLinks } from "./co-retrieval.js";

function insertMemory(db: DatabaseSync, id: string): void {
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  db.prepare(
    "INSERT INTO memories (id, content, content_type, source, importance, access_count, created_at, updated_at, is_active) VALUES (?, 'test', 'text', 'cli', 0.5, 0, ?, ?, 1)"
  ).run(id, now, now);
}

function insertCoRetrieval(
  db: DatabaseSync,
  memoryIds: string[],
  queryHash = "abc123"
): void {
  db.prepare(
    "INSERT INTO co_retrievals (query_hash, memory_ids, result_count) VALUES (?, ?, ?)"
  ).run(queryHash, JSON.stringify(memoryIds), memoryIds.length);
}

function getLinkCount(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT COUNT(*) as cnt FROM memory_links")
    .get() as { cnt: number };
  return row.cnt;
}

function getLinkStrength(
  db: DatabaseSync,
  sourceId: string,
  targetId: string
): number | undefined {
  const row = db
    .prepare(
      "SELECT strength FROM memory_links WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)"
    )
    .get(sourceId, targetId, targetId, sourceId) as
    | { strength: number }
    | undefined;
  return row?.strength;
}

describe("buildCoRetrievalLinks", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getDbForTesting();
    initializeSchema(db);
  });

  it("should create links for frequently co-retrieved memories", () => {
    insertMemory(db, "m1");
    insertMemory(db, "m2");

    // 3 co-retrievals (meets threshold of 3)
    insertCoRetrieval(db, ["m1", "m2"], "q1");
    insertCoRetrieval(db, ["m1", "m2"], "q2");
    insertCoRetrieval(db, ["m1", "m2"], "q3");

    const result = buildCoRetrievalLinks(db, { minCoRetrievals: 3 });
    expect(result.pairsAnalyzed).toBe(1);
    expect(result.linksCreated).toBe(1);
    expect(result.linksStrengthened).toBe(0);
    expect(result.dry_run).toBe(false);
    expect(getLinkCount(db)).toBe(1);
  });

  it("should skip pairs below threshold", () => {
    insertMemory(db, "m1");
    insertMemory(db, "m2");

    // Only 2 co-retrievals (below threshold of 3)
    insertCoRetrieval(db, ["m1", "m2"], "q1");
    insertCoRetrieval(db, ["m1", "m2"], "q2");

    const result = buildCoRetrievalLinks(db, { minCoRetrievals: 3 });
    expect(result.pairsAnalyzed).toBe(0);
    expect(result.linksCreated).toBe(0);
    expect(getLinkCount(db)).toBe(0);
  });

  it("should strengthen existing links", () => {
    insertMemory(db, "m1");
    insertMemory(db, "m2");

    // Pre-create a link
    db.prepare(
      "INSERT INTO memory_links (source_id, target_id, link_type, strength) VALUES (?, ?, 'related', 0.4)"
    ).run("m1", "m2");

    insertCoRetrieval(db, ["m1", "m2"], "q1");
    insertCoRetrieval(db, ["m1", "m2"], "q2");
    insertCoRetrieval(db, ["m1", "m2"], "q3");

    const result = buildCoRetrievalLinks(db, { minCoRetrievals: 3 });
    expect(result.linksCreated).toBe(0);
    expect(result.linksStrengthened).toBe(1);

    const strength = getLinkStrength(db, "m1", "m2");
    expect(strength).toBeCloseTo(0.45); // 0.4 + 0.05
  });

  it("should report only in dry run mode", () => {
    insertMemory(db, "m1");
    insertMemory(db, "m2");

    insertCoRetrieval(db, ["m1", "m2"], "q1");
    insertCoRetrieval(db, ["m1", "m2"], "q2");
    insertCoRetrieval(db, ["m1", "m2"], "q3");

    const result = buildCoRetrievalLinks(db, {
      dryRun: true,
      minCoRetrievals: 3,
    });
    expect(result.dry_run).toBe(true);
    expect(result.linksCreated).toBe(1);
    expect(getLinkCount(db)).toBe(0); // No actual links created
  });

  it("should respect lookback window", () => {
    insertMemory(db, "m1");
    insertMemory(db, "m2");

    // Insert co-retrievals with old timestamps
    const oldDate = new Date(Date.now() - 60 * 86400000)
      .toISOString()
      .replace("T", " ")
      .replace("Z", "");
    db.prepare(
      "INSERT INTO co_retrievals (query_hash, memory_ids, result_count, created_at) VALUES (?, ?, ?, ?)"
    ).run("q1", JSON.stringify(["m1", "m2"]), 2, oldDate);
    db.prepare(
      "INSERT INTO co_retrievals (query_hash, memory_ids, result_count, created_at) VALUES (?, ?, ?, ?)"
    ).run("q2", JSON.stringify(["m1", "m2"]), 2, oldDate);
    db.prepare(
      "INSERT INTO co_retrievals (query_hash, memory_ids, result_count, created_at) VALUES (?, ?, ?, ?)"
    ).run("q3", JSON.stringify(["m1", "m2"]), 2, oldDate);

    const result = buildCoRetrievalLinks(db, {
      minCoRetrievals: 3,
      lookbackDays: 30,
    });
    expect(result.pairsAnalyzed).toBe(0); // All records outside lookback
  });
});
