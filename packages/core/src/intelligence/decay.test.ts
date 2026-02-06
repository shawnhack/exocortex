import { describe, it, expect, beforeEach } from "vitest";
import { getDbForTesting, initializeSchema } from "@exocortex/core";
import type { DatabaseSync } from "@exocortex/core";
import { getArchiveCandidates, archiveStaleMemories } from "./decay.js";

function insertMemory(
  db: DatabaseSync,
  overrides: Partial<{
    id: string;
    content: string;
    importance: number;
    access_count: number;
    created_at: string;
    last_accessed_at: string | null;
    is_active: number;
  }> = {}
) {
  const id = overrides.id ?? `test-${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  db.prepare(
    `INSERT INTO memories (id, content, content_type, source, importance, access_count, created_at, updated_at, is_active, last_accessed_at)
     VALUES (?, ?, 'text', 'cli', ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    overrides.content ?? "test memory",
    overrides.importance ?? 0.5,
    overrides.access_count ?? 0,
    overrides.created_at ?? now,
    now,
    overrides.is_active ?? 1,
    overrides.last_accessed_at ?? null
  );
  return id;
}

function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

describe("decay / archival", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getDbForTesting();
    initializeSchema(db);
  });

  describe("getArchiveCandidates", () => {
    it("should find stale memories (low importance + old + low access)", () => {
      insertMemory(db, { id: "stale-1", importance: 0.1, access_count: 1, created_at: daysAgo(120) });
      insertMemory(db, { id: "fresh-1", importance: 0.1, access_count: 1, created_at: daysAgo(30) });
      insertMemory(db, { id: "important-1", importance: 0.8, access_count: 1, created_at: daysAgo(120) });

      const candidates = getArchiveCandidates(db);
      const ids = candidates.map((c) => c.id);

      expect(ids).toContain("stale-1");
      expect(ids).not.toContain("fresh-1");
      expect(ids).not.toContain("important-1");
    });

    it("should find abandoned memories (very old + zero access)", () => {
      insertMemory(db, { id: "abandoned-1", importance: 0.9, access_count: 0, created_at: daysAgo(400) });
      insertMemory(db, { id: "used-old-1", importance: 0.9, access_count: 5, created_at: daysAgo(400) });

      const candidates = getArchiveCandidates(db);
      const ids = candidates.map((c) => c.id);

      expect(ids).toContain("abandoned-1");
      expect(ids).not.toContain("used-old-1");
    });

    it("should not return already-inactive memories", () => {
      insertMemory(db, { id: "inactive-1", importance: 0.1, access_count: 0, created_at: daysAgo(200), is_active: 0 });

      const candidates = getArchiveCandidates(db);
      expect(candidates).toHaveLength(0);
    });

    it("should respect custom options", () => {
      insertMemory(db, { id: "custom-1", importance: 0.4, access_count: 0, created_at: daysAgo(50) });

      const defaultCandidates = getArchiveCandidates(db);
      expect(defaultCandidates.map((c) => c.id)).not.toContain("custom-1");

      const customCandidates = getArchiveCandidates(db, {
        staleDays: 30,
        maxImportance: 0.5,
      });
      expect(customCandidates.map((c) => c.id)).toContain("custom-1");
    });
  });

  describe("archiveStaleMemories", () => {
    it("should set is_active=0 on archived memories", () => {
      insertMemory(db, { id: "archive-me", importance: 0.1, access_count: 0, created_at: daysAgo(120) });

      const result = archiveStaleMemories(db);
      expect(result.archived).toBe(1);
      expect(result.dry_run).toBe(false);

      const row = db.prepare("SELECT is_active FROM memories WHERE id = ?").get("archive-me") as { is_active: number };
      expect(row.is_active).toBe(0);
    });

    it("dry_run should not modify anything", () => {
      insertMemory(db, { id: "dry-run-1", importance: 0.1, access_count: 0, created_at: daysAgo(120) });

      const result = archiveStaleMemories(db, { dryRun: true });
      expect(result.archived).toBe(0);
      expect(result.dry_run).toBe(true);
      expect(result.candidates.length).toBe(1);

      const row = db.prepare("SELECT is_active FROM memories WHERE id = ?").get("dry-run-1") as { is_active: number };
      expect(row.is_active).toBe(1);
    });

    it("archived memories should be excluded from search (is_active=0)", () => {
      insertMemory(db, { id: "will-archive", importance: 0.1, access_count: 0, created_at: daysAgo(120) });

      archiveStaleMemories(db);

      const activeRows = db
        .prepare("SELECT id FROM memories WHERE is_active = 1")
        .all() as Array<{ id: string }>;
      expect(activeRows.map((r) => r.id)).not.toContain("will-archive");
    });
  });
});
