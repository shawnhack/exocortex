import { describe, it, expect, beforeEach } from "vitest";
import { getDbForTesting, initializeSchema } from "@exocortex/core";
import type { DatabaseSync } from "@exocortex/core";
import { exportData, verifyBackup } from "./backup.js";

function insertMemory(
  db: DatabaseSync,
  overrides: Partial<{
    id: string;
    content: string;
    importance: number;
  }> = {}
) {
  const id = overrides.id ?? `test-${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  db.prepare(
    `INSERT INTO memories (id, content, content_type, source, importance, access_count, created_at, updated_at, is_active)
     VALUES (?, ?, 'text', 'cli', ?, 0, ?, ?, 1)`
  ).run(id, overrides.content ?? "test memory", overrides.importance ?? 0.5, now, now);
  return id;
}

describe("verifyBackup", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getDbForTesting();
    initializeSchema(db);
  });

  it("should pass for a valid export/import round-trip", () => {
    insertMemory(db, { id: "m1", content: "hello world" });
    insertMemory(db, { id: "m2", content: "second memory" });

    const data = exportData(db);
    const result = verifyBackup(db, data);

    expect(result.valid).toBe(true);
    expect(result.discrepancies).toHaveLength(0);

    const memoriesRow = result.counts.find((c) => c.table === "memories");
    expect(memoriesRow).toBeDefined();
    expect(memoriesRow!.backup).toBe(2);
    expect(memoriesRow!.imported).toBe(2);
    expect(memoriesRow!.source).toBe(2);
  });

  it("should detect count mismatches when backup data is modified", () => {
    insertMemory(db, { id: "m1", content: "hello" });

    const data = exportData(db);
    // Add a fake memory to the backup data that has a duplicate ID
    // so it won't actually import (INSERT OR IGNORE)
    data.memories.push({
      ...data.memories[0],
      id: data.memories[0].id, // duplicate ID won't import
    });

    const result = verifyBackup(db, data);
    expect(result.valid).toBe(false);
    expect(result.discrepancies.length).toBeGreaterThan(0);
    expect(result.discrepancies[0]).toContain("memories");
  });

  it("should check embeddings when option is set", () => {
    insertMemory(db, { id: "m1", content: "has content" });
    insertMemory(db, { id: "m2", content: "   " });

    const data = exportData(db);
    const result = verifyBackup(db, data, {
      checkEmbeddings: true,
      sampleSize: 10,
    });

    expect(result.embeddingCheck).toBeDefined();
    expect(result.embeddingCheck!.sampled).toBe(2);
    expect(result.embeddingCheck!.withContent).toBe(1);
  });

  it("should not include embedding check when option is not set", () => {
    insertMemory(db, { id: "m1", content: "test" });

    const data = exportData(db);
    const result = verifyBackup(db, data);

    expect(result.embeddingCheck).toBeUndefined();
  });
});
