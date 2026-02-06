import { describe, it, expect, beforeEach } from "vitest";
import { getDbForTesting, initializeSchema } from "@exocortex/core";
import type { DatabaseSync } from "@exocortex/core";
import { findClusters, consolidateCluster, generateBasicSummary } from "./consolidation.js";

function insertMemoryWithEmbedding(
  db: DatabaseSync,
  overrides: Partial<{
    id: string;
    content: string;
    embedding: Float32Array;
    importance: number;
    created_at: string;
    is_active: number;
  }> = {}
) {
  const id = overrides.id ?? `test-${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  const embedding = overrides.embedding ?? randomEmbedding();
  const embeddingBlob = new Uint8Array(embedding.buffer);

  db.prepare(
    `INSERT INTO memories (id, content, content_type, source, embedding, importance, access_count, created_at, updated_at, is_active)
     VALUES (?, ?, 'text', 'cli', ?, ?, 0, ?, ?, ?)`
  ).run(
    id,
    overrides.content ?? "test memory",
    embeddingBlob,
    overrides.importance ?? 0.5,
    overrides.created_at ?? now,
    now,
    overrides.is_active ?? 1
  );
  return id;
}

function randomEmbedding(seed = Math.random()): Float32Array {
  const arr = new Float32Array(8);
  for (let i = 0; i < 8; i++) {
    arr[i] = Math.sin(seed * (i + 1) * 1000);
  }
  // Normalize
  let norm = 0;
  for (let i = 0; i < arr.length; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < arr.length; i++) arr[i] /= norm;
  return arr;
}

function similarEmbedding(base: Float32Array, noise = 0.05): Float32Array {
  const arr = new Float32Array(base.length);
  for (let i = 0; i < base.length; i++) {
    arr[i] = base[i] + (Math.random() - 0.5) * noise;
  }
  let norm = 0;
  for (let i = 0; i < arr.length; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < arr.length; i++) arr[i] /= norm;
  return arr;
}

describe("consolidation", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getDbForTesting();
    initializeSchema(db);
  });

  describe("findClusters", () => {
    it("returns empty when no memories exist", () => {
      const clusters = findClusters(db);
      expect(clusters).toHaveLength(0);
    });

    it("returns empty when fewer memories than minClusterSize", () => {
      insertMemoryWithEmbedding(db, { id: "m1" });
      insertMemoryWithEmbedding(db, { id: "m2" });
      const clusters = findClusters(db, { minClusterSize: 3 });
      expect(clusters).toHaveLength(0);
    });

    it("finds cluster of similar memories", () => {
      const base = randomEmbedding(42);
      insertMemoryWithEmbedding(db, { id: "sim-1", content: "memory about topic A", embedding: similarEmbedding(base, 0.01) });
      insertMemoryWithEmbedding(db, { id: "sim-2", content: "memory about topic A", embedding: similarEmbedding(base, 0.01) });
      insertMemoryWithEmbedding(db, { id: "sim-3", content: "memory about topic A", embedding: similarEmbedding(base, 0.01) });
      // Add a dissimilar one
      insertMemoryWithEmbedding(db, { id: "diff-1", content: "completely different", embedding: randomEmbedding(999) });

      const clusters = findClusters(db, { minClusterSize: 3, minSimilarity: 0.9 });
      expect(clusters.length).toBeGreaterThanOrEqual(1);
      const clusterIds = clusters[0].memberIds;
      expect(clusterIds).toContain("sim-1");
      expect(clusterIds).toContain("sim-2");
      expect(clusterIds).toContain("sim-3");
    });

    it("respects minSimilarity threshold", () => {
      const base = randomEmbedding(42);
      insertMemoryWithEmbedding(db, { id: "a1", embedding: similarEmbedding(base, 0.01) });
      insertMemoryWithEmbedding(db, { id: "a2", embedding: similarEmbedding(base, 0.01) });
      insertMemoryWithEmbedding(db, { id: "a3", embedding: similarEmbedding(base, 0.01) });

      // Very high threshold — might not form cluster
      const highThreshold = findClusters(db, { minSimilarity: 0.999, minClusterSize: 3 });
      // Low threshold — should form cluster
      const lowThreshold = findClusters(db, { minSimilarity: 0.5, minClusterSize: 3 });
      expect(lowThreshold.length).toBeGreaterThanOrEqual(highThreshold.length);
    });
  });

  describe("generateBasicSummary", () => {
    it("generates a summary from member contents", () => {
      const id1 = insertMemoryWithEmbedding(db, { content: "Decided to use SQLite for the database layer." });
      const id2 = insertMemoryWithEmbedding(db, { content: "The architecture uses a monorepo with pnpm workspaces." });
      const id3 = insertMemoryWithEmbedding(db, { content: "Bug fix: resolved the date parsing issue in dashboard." });

      const summary = generateBasicSummary(db, [id1, id2, id3]);
      expect(summary).toContain("Consolidated summary of 3 memories");
      expect(summary.length).toBeGreaterThan(50);
    });

    it("returns empty string for no members", () => {
      const summary = generateBasicSummary(db, []);
      expect(summary).toBe("");
    });

    it("includes tags in summary header", () => {
      const id1 = insertMemoryWithEmbedding(db, { id: "tagged-1", content: "Memory with important facts about 2024-01-01." });
      db.prepare("INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)").run("tagged-1", "exocortex");

      const summary = generateBasicSummary(db, [id1]);
      expect(summary).toContain("exocortex");
    });
  });

  describe("consolidateCluster", () => {
    it("creates a summary memory and archives source memories", async () => {
      const base = randomEmbedding(42);
      const id1 = insertMemoryWithEmbedding(db, { id: "c1", content: "content 1", embedding: base });
      const id2 = insertMemoryWithEmbedding(db, { id: "c2", content: "content 2", embedding: similarEmbedding(base, 0.01) });
      const id3 = insertMemoryWithEmbedding(db, { id: "c3", content: "content 3", embedding: similarEmbedding(base, 0.01) });

      // Add tags to source memories
      db.prepare("INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)").run("c1", "tag-a");
      db.prepare("INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)").run("c2", "tag-b");
      db.prepare("INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)").run("c3", "tag-a");

      const cluster = {
        centroidId: id1,
        memberIds: [id1, id2, id3],
        avgSimilarity: 0.95,
        topic: "test topic",
      };

      const summaryId = await consolidateCluster(db, cluster, "Summary of content 1, 2, 3");

      // Verify summary memory was created
      const summary = db.prepare("SELECT * FROM memories WHERE id = ?").get(summaryId) as any;
      expect(summary).toBeTruthy();
      expect(summary.content_type).toBe("summary");
      expect(summary.source).toBe("consolidation");
      expect(summary.is_active).toBe(1);

      // Verify source memories are archived
      for (const id of [id1, id2, id3]) {
        const mem = db.prepare("SELECT is_active, parent_id FROM memories WHERE id = ?").get(id) as any;
        expect(mem.is_active).toBe(0);
        expect(mem.parent_id).toBe(summaryId);
      }

      // Verify consolidation record
      const consol = db.prepare("SELECT * FROM consolidations WHERE summary_id = ?").get(summaryId) as any;
      expect(consol).toBeTruthy();
      expect(consol.memories_merged).toBe(3);
    });

    it("propagates tags from source memories to summary", async () => {
      const id1 = insertMemoryWithEmbedding(db, { id: "t1" });
      const id2 = insertMemoryWithEmbedding(db, { id: "t2" });
      const id3 = insertMemoryWithEmbedding(db, { id: "t3" });

      db.prepare("INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)").run("t1", "alpha");
      db.prepare("INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)").run("t2", "beta");
      db.prepare("INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)").run("t3", "alpha");

      const cluster = {
        centroidId: id1,
        memberIds: [id1, id2, id3],
        avgSimilarity: 0.9,
        topic: "tag propagation test",
      };

      const summaryId = await consolidateCluster(db, cluster, "Summary content");

      const tags = db
        .prepare("SELECT tag FROM memory_tags WHERE memory_id = ?")
        .all(summaryId) as Array<{ tag: string }>;
      const tagSet = new Set(tags.map((t) => t.tag));
      expect(tagSet.has("alpha")).toBe(true);
      expect(tagSet.has("beta")).toBe(true);
    });

    it("embeds summary when provider is given", async () => {
      const id1 = insertMemoryWithEmbedding(db, { id: "e1" });
      const id2 = insertMemoryWithEmbedding(db, { id: "e2" });
      const id3 = insertMemoryWithEmbedding(db, { id: "e3" });

      const mockProvider = {
        embed: async () => new Float32Array(8).fill(0.5),
        embedBatch: async (texts: string[]) => texts.map(() => new Float32Array(8).fill(0.5)),
        dimensions: () => 8,
      };

      const cluster = {
        centroidId: id1,
        memberIds: [id1, id2, id3],
        avgSimilarity: 0.9,
        topic: "embedding test",
      };

      const summaryId = await consolidateCluster(db, cluster, "Summary to embed", mockProvider);

      const summary = db.prepare("SELECT embedding FROM memories WHERE id = ?").get(summaryId) as any;
      expect(summary.embedding).not.toBeNull();
    });
  });
});
