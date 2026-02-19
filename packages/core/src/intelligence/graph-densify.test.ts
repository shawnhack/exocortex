import { describe, it, expect, beforeEach } from "vitest";
import { getDbForTesting, initializeSchema, EntityStore } from "@exocortex/core";
import type { DatabaseSync } from "@exocortex/core";
import { densifyEntityGraph } from "./graph-densify.js";

function insertEntity(db: DatabaseSync, id: string, name: string): void {
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  db.prepare(
    "INSERT INTO entities (id, name, type, aliases, metadata, created_at, updated_at) VALUES (?, ?, 'concept', '[]', '{}', ?, ?)"
  ).run(id, name, now, now);
}

function insertMemory(db: DatabaseSync, id: string): void {
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  db.prepare(
    "INSERT INTO memories (id, content, content_type, source, importance, access_count, created_at, updated_at, is_active) VALUES (?, 'test', 'text', 'cli', 0.5, 0, ?, ?, 1)"
  ).run(id, now, now);
}

function linkEntityToMemory(
  db: DatabaseSync,
  entityId: string,
  memoryId: string
): void {
  db.prepare(
    "INSERT INTO memory_entities (entity_id, memory_id, relevance) VALUES (?, ?, 1.0)"
  ).run(entityId, memoryId);
}

function getRelationshipCount(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT COUNT(*) as cnt FROM entity_relationships")
    .get() as { cnt: number };
  return row.cnt;
}

describe("densifyEntityGraph", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getDbForTesting();
    initializeSchema(db);
  });

  it("should link entities sharing memories above threshold", () => {
    insertEntity(db, "e1", "Alpha");
    insertEntity(db, "e2", "Beta");
    insertMemory(db, "m1");
    insertMemory(db, "m2");
    insertMemory(db, "m3");
    linkEntityToMemory(db, "e1", "m1");
    linkEntityToMemory(db, "e2", "m1");
    linkEntityToMemory(db, "e1", "m2");
    linkEntityToMemory(db, "e2", "m2");
    linkEntityToMemory(db, "e1", "m3");
    linkEntityToMemory(db, "e2", "m3");

    const result = densifyEntityGraph(db, { minCoOccurrences: 2 });
    expect(result.pairsAnalyzed).toBe(1);
    expect(result.relationshipsCreated).toBe(1);
    expect(result.dry_run).toBe(false);
    expect(getRelationshipCount(db)).toBe(1);
  });

  it("should skip pairs below threshold", () => {
    insertEntity(db, "e1", "Alpha");
    insertEntity(db, "e2", "Beta");
    insertMemory(db, "m1");
    linkEntityToMemory(db, "e1", "m1");
    linkEntityToMemory(db, "e2", "m1");

    const result = densifyEntityGraph(db, { minCoOccurrences: 2 });
    expect(result.pairsAnalyzed).toBe(0);
    expect(result.relationshipsCreated).toBe(0);
    expect(getRelationshipCount(db)).toBe(0);
  });

  it("should skip pairs that already have relationships", () => {
    insertEntity(db, "e1", "Alpha");
    insertEntity(db, "e2", "Beta");
    insertMemory(db, "m1");
    insertMemory(db, "m2");
    linkEntityToMemory(db, "e1", "m1");
    linkEntityToMemory(db, "e2", "m1");
    linkEntityToMemory(db, "e1", "m2");
    linkEntityToMemory(db, "e2", "m2");

    // Pre-create a relationship
    const store = new EntityStore(db);
    store.addRelationship("e1", "e2", "related", 0.5);

    const result = densifyEntityGraph(db, { minCoOccurrences: 2 });
    expect(result.pairsAnalyzed).toBe(0);
    expect(result.relationshipsCreated).toBe(0);
  });

  it("should report only in dry run mode", () => {
    insertEntity(db, "e1", "Alpha");
    insertEntity(db, "e2", "Beta");
    insertMemory(db, "m1");
    insertMemory(db, "m2");
    linkEntityToMemory(db, "e1", "m1");
    linkEntityToMemory(db, "e2", "m1");
    linkEntityToMemory(db, "e1", "m2");
    linkEntityToMemory(db, "e2", "m2");

    const result = densifyEntityGraph(db, {
      dryRun: true,
      minCoOccurrences: 2,
    });
    expect(result.pairsAnalyzed).toBe(1);
    expect(result.relationshipsCreated).toBe(1);
    expect(result.dry_run).toBe(true);
    // No actual relationships created
    expect(getRelationshipCount(db)).toBe(0);
  });

  it("should calculate confidence based on shared count", () => {
    insertEntity(db, "e1", "Alpha");
    insertEntity(db, "e2", "Beta");
    // Create 10 shared memories → confidence should be capped at 0.9
    for (let i = 0; i < 10; i++) {
      insertMemory(db, `m${i}`);
      linkEntityToMemory(db, "e1", `m${i}`);
      linkEntityToMemory(db, "e2", `m${i}`);
    }

    densifyEntityGraph(db, { minCoOccurrences: 2 });

    const rel = db
      .prepare(
        "SELECT confidence FROM entity_relationships WHERE source_entity_id = ? AND target_entity_id = ?"
      )
      .get("e1", "e2") as { confidence: number } | undefined;
    expect(rel).toBeDefined();
    expect(rel!.confidence).toBeCloseTo(0.9);
  });
});
