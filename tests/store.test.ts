import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  initializeSchema,
  MemoryStore,
  setSetting,
  setEmbeddingProvider,
  resetEmbeddingProvider,
} from "@exocortex/core";
import type { EmbeddingProvider } from "@exocortex/core";

// Deterministic mock embedder for testing
class MockEmbeddingProvider implements EmbeddingProvider {
  embed(text: string): Promise<Float32Array> {
    const arr = new Float32Array(8);
    for (let i = 0; i < text.length; i++) {
      arr[i % 8] += text.charCodeAt(i) / 1000;
    }
    let norm = 0;
    for (let i = 0; i < arr.length; i++) norm += arr[i] * arr[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < arr.length; i++) arr[i] /= norm;
    return Promise.resolve(arr);
  }

  embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  dimensions(): number {
    return 8;
  }
}

let db: DatabaseSync;
let store: MemoryStore;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  initializeSchema(db);
  setEmbeddingProvider(new MockEmbeddingProvider());
  store = new MemoryStore(db);
});

afterEach(() => {
  db.close();
  resetEmbeddingProvider();
});

describe("MemoryStore", () => {
  describe("create", () => {
    it("creates a memory with content", async () => {
      const { memory } = await store.create({ content: "Hello world" });
      expect(memory.id).toBeTruthy();
      expect(memory.content).toBe("Hello world");
      expect(memory.content_type).toBe("text");
      expect(memory.source).toBe("manual");
      expect(memory.is_active).toBe(true);
      expect(memory.importance).toBe(0.5);
    });

    it("creates a memory with tags", async () => {
      const { memory } = await store.create({
        content: "Tagged memory",
        tags: ["test", "hello"],
      });
      expect(memory.tags).toEqual(expect.arrayContaining(["test", "hello"]));
      expect(memory.tags!.length).toBe(2);
    });

    it("normalizes aliased tags on create", async () => {
      const { memory } = await store.create({
        content: "Tag alias test",
        tags: ["nextjs", "next-js", "clawworld", "NEXTJS"],
      });
      expect(memory.tags).toContain("next.js");
      expect(memory.tags).toContain("claw-world");
      expect(memory.tags?.filter((t) => t === "next.js")).toHaveLength(1);
    });

    it("creates a memory with custom fields", async () => {
      const { memory } = await store.create({
        content: "Important note",
        content_type: "note",
        source: "cli",
        importance: 0.9,
      });
      expect(memory.content_type).toBe("note");
      expect(memory.source).toBe("cli");
      expect(memory.importance).toBe(0.9);
    });

    it("generates an embedding", async () => {
      const { memory } = await store.create({ content: "Embed me" });
      expect(memory.embedding).toBeInstanceOf(Float32Array);
      expect(memory.embedding!.length).toBe(8);
    });

    it("creates a memory with metadata", async () => {
      const { memory } = await store.create({
        content: "With metadata",
        metadata: { model: "claude-opus-4-6", source_app: "test" },
      });
      expect(memory.metadata).toEqual({ model: "claude-opus-4-6", source_app: "test" });
    });

    it("handles null metadata gracefully", async () => {
      const { memory } = await store.create({ content: "No metadata" });
      expect(memory.metadata).toBeUndefined();
    });

    it("generates unique IDs", async () => {
      const { memory: a } = await store.create({ content: "First" });
      const { memory: b } = await store.create({ content: "Second" });
      expect(a.id).not.toBe(b.id);
    });

    it("supports benchmark mode defaults with reduced indexing", async () => {
      const { memory } = await store.create({
        content: "Benchmark capture for retrieval snapshot.",
        benchmark: true,
      });
      expect(memory.importance).toBe(0.15);
      expect(memory.tags).toContain("benchmark-artifact");
      expect(memory.is_metadata).toBe(true);
      expect(memory.embedding).toBeNull();

      const row = db
        .prepare("SELECT is_indexed, is_metadata FROM memories WHERE id = ?")
        .get(memory.id) as { is_indexed: number; is_metadata: number };
      expect(row.is_indexed).toBe(0);
      expect(row.is_metadata).toBe(1);
    });

    it("supports explicit metadata classification", async () => {
      const { memory } = await store.create({
        content: "Explicit metadata classification test",
        is_metadata: true,
      });
      expect(memory.is_metadata).toBe(true);
    });

    it("skips insert on exact hash duplicate and merges tags", async () => {
      const base = await store.create({
        content:
          "This duplicate content is long enough for dedup and should be reused exactly.",
        tags: ["alpha"],
      });
      const duplicate = await store.create({
        content:
          "This duplicate content is long enough for dedup and should be reused exactly.",
        tags: ["beta"],
      });

      expect(duplicate.dedup_action).toBe("skipped");
      expect(duplicate.memory.id).toBe(base.memory.id);
      expect(duplicate.memory.tags).toEqual(expect.arrayContaining(["alpha", "beta"]));

      const count = db
        .prepare("SELECT COUNT(*) as count FROM memories")
        .get() as { count: number };
      expect(count.count).toBe(1);
    });

    it("skips insert on semantic duplicate when threshold is met", async () => {
      setSetting(db, "dedup.similarity_threshold", "0.75");
      await store.create({
        content:
          "TypeScript project setup with pnpm workspace and strict config enabled.",
        tags: ["typescript"],
      });
      const nearDup = await store.create({
        content:
          "TypeScript project setup with pnpm workspaces and strict configs enabled.",
        tags: ["typescript"],
      });

      expect(nearDup.dedup_action).toBe("skipped");

      const active = db
        .prepare("SELECT COUNT(*) as count FROM memories WHERE is_active = 1")
        .get() as { count: number };
      expect(active.count).toBe(1);
    });

    it("does not deactivate an existing memory when a dedup-candidate insert fails", async () => {
      setSetting(db, "dedup.enabled", "true");
      setSetting(db, "dedup.similarity_threshold", "0.7");

      const content =
        "This is a sufficiently long memory content for dedup testing and should stay active.";
      const { memory: first } = await store.create({ content });

      const circular: Record<string, unknown> = {};
      circular.self = circular;

      await expect(
        store.create({
          content,
          metadata: circular,
        })
      ).rejects.toThrow();

      const existing = await store.getById(first.id);
      expect(existing).not.toBeNull();
      expect(existing!.is_active).toBe(true);
      expect(existing!.superseded_by).toBeNull();
    });
  });

  describe("getById", () => {
    it("returns null for non-existent ID", async () => {
      const result = await store.getById("nonexistent");
      expect(result).toBeNull();
    });

    it("returns the memory by ID", async () => {
      const { memory: created } = await store.create({ content: "Find me" });
      const found = await store.getById(created.id);
      expect(found).not.toBeNull();
      expect(found!.content).toBe("Find me");
    });

    it("returns memories by IDs preserving requested order", async () => {
      const first = await store.create({ content: "One" });
      const second = await store.create({ content: "Two" });

      const found = await store.getByIds([second.memory.id, first.memory.id]);
      expect(found.map((m) => m.id)).toEqual([second.memory.id, first.memory.id]);
    });
  });

  describe("update", () => {
    it("updates content", async () => {
      const { memory: mem } = await store.create({ content: "Original" });
      const updated = await store.update(mem.id, { content: "Updated" });
      expect(updated!.content).toBe("Updated");
    });

    it("strips private blocks when updating content", async () => {
      const { memory: mem } = await store.create({ content: "Original" });
      const updated = await store.update(mem.id, {
        content: "Visible <private>secret</private> text",
      });
      expect(updated!.content).toBe("Visible  text");
    });

    it("updates tags", async () => {
      const { memory: mem } = await store.create({
        content: "Taggable",
        tags: ["old"],
      });
      const updated = await store.update(mem.id, {
        tags: ["new1", "new2"],
      });
      expect(updated!.tags).toEqual(["new1", "new2"]);
    });

    it("updates importance", async () => {
      const { memory: mem } = await store.create({ content: "Boring" });
      const updated = await store.update(mem.id, { importance: 1.0 });
      expect(updated!.importance).toBe(1.0);
    });

    it("returns null for non-existent ID", async () => {
      const result = await store.update("nonexistent", {
        content: "nope",
      });
      expect(result).toBeNull();
    });

    it("merges metadata on update", async () => {
      const { memory: mem } = await store.create({
        content: "Meta test",
        metadata: { model: "test", version: 1 },
      });
      const updated = await store.update(mem.id, {
        metadata: { version: 2, extra: "new" },
      });
      expect(updated!.metadata).toEqual({ model: "test", version: 2, extra: "new" });
    });

    it("deletes metadata key via null value", async () => {
      const { memory: mem } = await store.create({
        content: "Meta delete test",
        metadata: { keep: true, remove: "bye" },
      });
      const updated = await store.update(mem.id, {
        metadata: { remove: null },
      });
      expect(updated!.metadata).toEqual({ keep: true });
    });

    it("dechunks a chunked parent when new content is short", async () => {
      setSetting(db, "chunking.enabled", "true");
      setSetting(db, "chunking.max_length", "30");
      setSetting(db, "chunking.target_size", "10");

      const { memory: parent } = await store.create({
        content: "Sentence. ".repeat(200),
      });

      const childrenBefore = db
        .prepare("SELECT COUNT(*) as count FROM memories WHERE parent_id = ?")
        .get(parent.id) as { count: number };
      expect(childrenBefore.count).toBeGreaterThan(0);

      const updated = await store.update(parent.id, { content: "Short replacement" });
      const childrenAfter = db
        .prepare("SELECT COUNT(*) as count FROM memories WHERE parent_id = ?")
        .get(parent.id) as { count: number };

      expect(childrenAfter.count).toBe(0);
      expect(updated).not.toBeNull();
      expect(updated!.embedding).toBeInstanceOf(Float32Array);
    });
  });

  describe("delete", () => {
    it("deletes an existing memory", async () => {
      const { memory: mem } = await store.create({ content: "Delete me" });
      const result = await store.delete(mem.id);
      expect(result).toBe(true);
      const found = await store.getById(mem.id);
      expect(found).toBeNull();
    });

    it("returns false for non-existent ID", async () => {
      const result = await store.delete("nonexistent");
      expect(result).toBe(false);
    });

    it("deletes child chunks when deleting a chunked parent", async () => {
      setSetting(db, "chunking.enabled", "true");
      setSetting(db, "chunking.max_length", "30");
      setSetting(db, "chunking.target_size", "10");

      const { memory: parent } = await store.create({
        content: "Sentence. ".repeat(200),
      });

      const before = db
        .prepare("SELECT COUNT(*) as count FROM memories WHERE parent_id = ?")
        .get(parent.id) as { count: number };
      expect(before.count).toBeGreaterThan(0);

      const deleted = await store.delete(parent.id);
      expect(deleted).toBe(true);

      const afterChildren = db
        .prepare("SELECT COUNT(*) as count FROM memories WHERE parent_id = ?")
        .get(parent.id) as { count: number };
      const afterParent = await store.getById(parent.id);
      expect(afterChildren.count).toBe(0);
      expect(afterParent).toBeNull();
    });
  });

  describe("getRecent", () => {
    it("returns memories in reverse chronological order", async () => {
      await store.create({ content: "First" });
      // Small delay to ensure different created_at timestamps
      await new Promise((r) => setTimeout(r, 20));
      await store.create({ content: "Second" });
      await new Promise((r) => setTimeout(r, 20));
      await store.create({ content: "Third" });
      const recent = await store.getRecent(10);
      expect(recent.length).toBe(3);
      // Most recent first
      expect(recent[0].content).toBe("Third");
      expect(recent[1].content).toBe("Second");
      expect(recent[2].content).toBe("First");
    });

    it("respects limit", async () => {
      for (let i = 0; i < 5; i++) {
        await store.create({ content: `Memory ${i}` });
      }
      const recent = await store.getRecent(2);
      expect(recent.length).toBe(2);
    });

    it("does not duplicate memories when filtering by multiple tags", async () => {
      const { memory: mem } = await store.create({
        content: "Tagged once",
        tags: ["alpha", "beta"],
      });

      const recent = await store.getRecent(10, 0, ["alpha", "beta"]);
      expect(recent.length).toBe(1);
      expect(recent[0].id).toBe(mem.id);
    });
  });

  describe("recordAccess", () => {
    it("increments access count", async () => {
      const { memory: mem } = await store.create({ content: "Access me" });
      await store.recordAccess(mem.id, "test query");
      await store.recordAccess(mem.id);

      const updated = await store.getById(mem.id);
      expect(updated!.access_count).toBe(2);
      expect(updated!.last_accessed_at).toBeTruthy();
    });
  });

  describe("getStats", () => {
    it("returns correct statistics", async () => {
      await store.create({ content: "A", content_type: "text", tags: ["t1"] });
      await store.create({ content: "B", content_type: "note", tags: ["t2"] });
      await store.create({ content: "C", content_type: "text" });

      const stats = await store.getStats();
      expect(stats.total_memories).toBe(3);
      expect(stats.active_memories).toBe(3);
      expect(stats.by_content_type["text"]).toBe(2);
      expect(stats.by_content_type["note"]).toBe(1);
      expect(stats.total_tags).toBe(2);
      expect(stats.oldest_memory).toBeTruthy();
      expect(stats.newest_memory).toBeTruthy();
    });
  });
});
