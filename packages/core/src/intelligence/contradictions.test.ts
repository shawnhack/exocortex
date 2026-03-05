import { describe, it, expect, beforeEach } from "vitest";
import { getDbForTesting } from "../db/connection.js";
import { initializeSchema } from "../db/schema.js";
import {
  recordContradiction,
  getContradictions,
  updateContradiction,
  autoDismissContradictions,
} from "./contradictions.js";
import type { DatabaseSync } from "node:sqlite";

// We test the pure functions findContradictionReason indirectly through
// detectContradictions (which requires embeddings) and directly test
// the DB-level CRUD + auto-dismiss logic here.

const now = () => new Date().toISOString().replace("T", " ").replace("Z", "");

function insertMemory(
  db: DatabaseSync,
  id: string,
  content: string,
  opts: { is_active?: number; quality_score?: number } = {}
) {
  const ts = now();
  db.prepare(
    `INSERT INTO memories (id, content, content_type, source, importance, is_active, quality_score, created_at, updated_at)
     VALUES (?, ?, 'text', 'api', 0.5, ?, ?, ?, ?)`
  ).run(id, content, opts.is_active ?? 1, opts.quality_score ?? 0.5, ts, ts);
}

describe("contradiction CRUD", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getDbForTesting();
    initializeSchema(db);
    insertMemory(db, "mem-a", "We use PostgreSQL for the database");
    insertMemory(db, "mem-b", "We do not use PostgreSQL anymore");
  });

  it("should record a contradiction", () => {
    const c = recordContradiction(db, {
      memory_a_id: "mem-a",
      memory_b_id: "mem-b",
      similarity: 0.88,
      reason: 'negation conflict: "use PostgreSQL" vs "do not use PostgreSQL"',
    });

    expect(c.id).toBeTruthy();
    expect(c.status).toBe("pending");
    expect(c.resolution).toBeNull();
    expect(c.memory_a_id).toBe("mem-a");
  });

  it("should list contradictions with status filter", () => {
    recordContradiction(db, {
      memory_a_id: "mem-a",
      memory_b_id: "mem-b",
      similarity: 0.88,
      reason: "test conflict",
    });

    expect(getContradictions(db, "pending")).toHaveLength(1);
    expect(getContradictions(db, "resolved")).toHaveLength(0);
    expect(getContradictions(db)).toHaveLength(1);
  });

  it("should update contradiction status and resolution", () => {
    const c = recordContradiction(db, {
      memory_a_id: "mem-a",
      memory_b_id: "mem-b",
      similarity: 0.88,
      reason: "test",
    });

    const updated = updateContradiction(db, c.id, {
      status: "resolved",
      resolution: "PostgreSQL was replaced in v2",
    });

    expect(updated?.status).toBe("resolved");
    expect(updated?.resolution).toBe("PostgreSQL was replaced in v2");
  });

  it("should return null for non-existent contradiction", () => {
    expect(updateContradiction(db, "nonexistent", { status: "resolved" })).toBeNull();
  });
});

describe("autoDismissContradictions", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getDbForTesting();
    initializeSchema(db);
  });

  it("should dismiss contradictions with deleted source", () => {
    insertMemory(db, "mem-a", "Content A", { is_active: 0 });
    insertMemory(db, "mem-b", "Content B");

    recordContradiction(db, {
      memory_a_id: "mem-a",
      memory_b_id: "mem-b",
      similarity: 0.85,
      reason: "test",
    });

    const result = autoDismissContradictions(db);
    expect(result.dismissed).toBe(1);
    expect(result.reasons.deleted_source).toBe(1);
    expect(getContradictions(db, "pending")).toHaveLength(0);
    expect(getContradictions(db, "dismissed")).toHaveLength(1);
  });

  it("should dismiss consolidation artifacts", () => {
    insertMemory(db, "mem-a", "[Consolidated summary of 5 memories]");
    insertMemory(db, "mem-b", "Regular memory");

    recordContradiction(db, {
      memory_a_id: "mem-a",
      memory_b_id: "mem-b",
      similarity: 0.85,
      reason: "test",
    });

    const result = autoDismissContradictions(db);
    expect(result.dismissed).toBe(1);
    expect(result.reasons.consolidation_artifact).toBe(1);
  });

  it("should dismiss low quality pairs", () => {
    insertMemory(db, "mem-a", "Low quality A", { quality_score: 0.10 });
    insertMemory(db, "mem-b", "Low quality B", { quality_score: 0.15 });

    recordContradiction(db, {
      memory_a_id: "mem-a",
      memory_b_id: "mem-b",
      similarity: 0.85,
      reason: "test",
    });

    const result = autoDismissContradictions(db);
    expect(result.dismissed).toBe(1);
    expect(result.reasons.low_quality).toBe(1);
  });

  it("should dismiss version/date value changes", () => {
    insertMemory(db, "mem-a", "Using version 1.0");
    insertMemory(db, "mem-b", "Using version 2.0");

    recordContradiction(db, {
      memory_a_id: "mem-a",
      memory_b_id: "mem-b",
      similarity: 0.9,
      reason: 'value change: "1.0.5" vs "2.0.1"',
    });

    const result = autoDismissContradictions(db);
    expect(result.dismissed).toBe(1);
    expect(result.reasons.version_date_change).toBe(1);
  });

  it("should support dry run mode", () => {
    insertMemory(db, "mem-a", "Content", { is_active: 0 });
    insertMemory(db, "mem-b", "Content B");

    recordContradiction(db, {
      memory_a_id: "mem-a",
      memory_b_id: "mem-b",
      similarity: 0.85,
      reason: "test",
    });

    const result = autoDismissContradictions(db, { dryRun: true });
    expect(result.dismissed).toBe(1);
    // But the actual record should still be pending
    expect(getContradictions(db, "pending")).toHaveLength(1);
  });

  it("should not dismiss valid contradictions", () => {
    insertMemory(db, "mem-a", "We use PostgreSQL", { quality_score: 0.8 });
    insertMemory(db, "mem-b", "We use MySQL", { quality_score: 0.8 });

    recordContradiction(db, {
      memory_a_id: "mem-a",
      memory_b_id: "mem-b",
      similarity: 0.9,
      reason: 'value change: "PostgreSQL for prod" vs "MySQL for prod"',
    });

    const result = autoDismissContradictions(db);
    expect(result.dismissed).toBe(0);
    expect(getContradictions(db, "pending")).toHaveLength(1);
  });
});
