import { describe, it, expect, beforeEach } from "vitest";
import { getDbForTesting, initializeSchema } from "@exocortex/core";
import type { DatabaseSync } from "@exocortex/core";
import { adjustImportance } from "./importance.js";

function insertMemory(
  db: DatabaseSync,
  overrides: Partial<{
    id: string;
    content: string;
    importance: number;
    access_count: number;
    created_at: string;
    is_active: number;
  }> = {}
) {
  const id = overrides.id ?? `test-${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  db.prepare(
    `INSERT INTO memories (id, content, content_type, source, importance, access_count, created_at, updated_at, is_active)
     VALUES (?, ?, 'text', 'cli', ?, ?, ?, ?, ?)`
  ).run(
    id,
    overrides.content ?? "test memory",
    overrides.importance ?? 0.5,
    overrides.access_count ?? 0,
    overrides.created_at ?? now,
    now,
    overrides.is_active ?? 1
  );
  return id;
}

function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

describe("importance auto-adjustment", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getDbForTesting();
    initializeSchema(db);
  });

  describe("boost", () => {
    it("should boost frequently-accessed memories", () => {
      insertMemory(db, { id: "freq-1", importance: 0.5, access_count: 10 });

      const result = adjustImportance(db);
      expect(result.boosted).toBe(1);

      const row = db.prepare("SELECT importance FROM memories WHERE id = ?").get("freq-1") as { importance: number };
      expect(row.importance).toBeCloseTo(0.6);
    });

    it("should not boost past 0.9", () => {
      insertMemory(db, { id: "high-1", importance: 0.85, access_count: 10 });

      const result = adjustImportance(db, { boostThreshold: 5 });
      // importance 0.85 >= 0.8 → not eligible
      expect(result.boosted).toBe(0);
    });

    it("should not boost pinned (importance=1.0) memories", () => {
      insertMemory(db, { id: "pinned-1", importance: 1.0, access_count: 20 });

      const result = adjustImportance(db);
      expect(result.boosted).toBe(0);
      expect(result.decayed).toBe(0);
    });

    it("should not boost below access threshold", () => {
      insertMemory(db, { id: "low-access", importance: 0.3, access_count: 2 });

      const result = adjustImportance(db, { boostThreshold: 5 });
      expect(result.boosted).toBe(0);
    });
  });

  describe("decay", () => {
    it("should decay old, never-accessed memories", () => {
      insertMemory(db, { id: "old-1", importance: 0.5, access_count: 0, created_at: daysAgo(60) });

      const result = adjustImportance(db, { decayAgeDays: 30 });
      expect(result.decayed).toBe(1);

      const row = db.prepare("SELECT importance FROM memories WHERE id = ?").get("old-1") as { importance: number };
      expect(row.importance).toBeCloseTo(0.45);
    });

    it("should not decay below 0.1", () => {
      // importance 0.35 > 0.3 threshold, so eligible for decay
      // After decay: 0.35 - 0.05 = 0.30 → still above floor
      // Run twice to get closer to floor
      insertMemory(db, { id: "low-1", importance: 0.35, access_count: 0, created_at: daysAgo(60) });

      adjustImportance(db, { decayAgeDays: 30 });
      // After first decay: 0.35 - 0.05 = 0.30, which is now <= 0.3 threshold
      // So second run shouldn't decay further
      const result2 = adjustImportance(db, { decayAgeDays: 30 });
      expect(result2.decayed).toBe(0);

      const row = db.prepare("SELECT importance FROM memories WHERE id = ?").get("low-1") as { importance: number };
      expect(row.importance).toBeCloseTo(0.3);
    });

    it("should not decay memories with importance <= 0.3", () => {
      insertMemory(db, { id: "below-threshold", importance: 0.3, access_count: 0, created_at: daysAgo(60) });

      const result = adjustImportance(db, { decayAgeDays: 30 });
      expect(result.decayed).toBe(0);
    });

    it("should not decay pinned (importance=1.0) memories", () => {
      insertMemory(db, { id: "pinned-2", importance: 1.0, access_count: 0, created_at: daysAgo(60) });

      const result = adjustImportance(db, { decayAgeDays: 30 });
      expect(result.decayed).toBe(0);
    });

    it("should not decay recently created memories", () => {
      insertMemory(db, { id: "recent-1", importance: 0.5, access_count: 0, created_at: daysAgo(10) });

      const result = adjustImportance(db, { decayAgeDays: 30 });
      expect(result.decayed).toBe(0);
    });
  });

  describe("dry_run", () => {
    it("should report changes without applying them", () => {
      insertMemory(db, { id: "dry-1", importance: 0.5, access_count: 10 });
      insertMemory(db, { id: "dry-2", importance: 0.5, access_count: 0, created_at: daysAgo(60) });

      const result = adjustImportance(db, { dryRun: true, decayAgeDays: 30 });
      expect(result.dry_run).toBe(true);
      expect(result.boosted).toBe(1);
      expect(result.decayed).toBe(1);
      expect(result.details).toHaveLength(2);

      // Verify nothing actually changed
      const row1 = db.prepare("SELECT importance FROM memories WHERE id = ?").get("dry-1") as { importance: number };
      expect(row1.importance).toBeCloseTo(0.5);
      const row2 = db.prepare("SELECT importance FROM memories WHERE id = ?").get("dry-2") as { importance: number };
      expect(row2.importance).toBeCloseTo(0.5);
    });
  });
});
