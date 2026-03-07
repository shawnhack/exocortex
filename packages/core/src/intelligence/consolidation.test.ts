import { describe, it, expect, beforeEach } from "vitest";
import { getDbForTesting, initializeSchema } from "@exocortex/core";
import type { DatabaseSync } from "@exocortex/core";
import { findClusters, consolidateCluster, generateBasicSummary, applyCommunityAwareFiltering } from "./consolidation.js";
import type { ConsolidationCluster } from "./consolidation.js";

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
      expect(summary).toContain("3 sources");
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

  describe("applyCommunityAwareFiltering", () => {
    // Helper: create an entity and return its ID
    function createEntity(db: DatabaseSync, id: string, name: string): string {
      const now = new Date().toISOString().slice(0, 19).replace("T", " ");
      db.prepare(
        "INSERT INTO entities (id, name, type, aliases, metadata, created_at, updated_at) VALUES (?, ?, 'concept', '[]', '{}', ?, ?)"
      ).run(id, name, now, now);
      return id;
    }

    // Helper: link a memory to an entity
    function linkMemoryToEntity(db: DatabaseSync, memoryId: string, entityId: string): void {
      db.prepare(
        "INSERT OR REPLACE INTO memory_entities (memory_id, entity_id, relevance) VALUES (?, ?, 1.0)"
      ).run(memoryId, entityId);
    }

    // Helper: create a relationship between entities
    function addRelationship(db: DatabaseSync, sourceId: string, targetId: string, rel: string = "related"): void {
      const id = `rel-${Math.random().toString(36).slice(2)}`;
      const now = new Date().toISOString().slice(0, 19).replace("T", " ");
      db.prepare(
        "INSERT INTO entity_relationships (id, source_entity_id, target_entity_id, relationship, confidence, created_at) VALUES (?, ?, ?, ?, 0.8, ?)"
      ).run(id, sourceId, targetId, rel, now);
    }

    it("returns clusters unchanged when no communities exist", () => {
      const id1 = insertMemoryWithEmbedding(db, { id: "m1", content: "memory one" });
      const id2 = insertMemoryWithEmbedding(db, { id: "m2", content: "memory two" });

      const clusters: ConsolidationCluster[] = [{
        centroidId: id1,
        memberIds: [id1, id2],
        avgSimilarity: 0.9,
        topic: "test topic",
      }];

      const result = applyCommunityAwareFiltering(db, clusters, 2);
      expect(result.clusters).toHaveLength(1);
      expect(result.bridgeMemoryIds).toHaveLength(0);
      expect(result.clustersSplit).toBe(0);
    });

    it("keeps cluster intact when all memories share the same community", () => {
      // Create two entities in the same community (connected)
      const e1 = createEntity(db, "ent-1", "Alpha");
      const e2 = createEntity(db, "ent-2", "Beta");
      addRelationship(db, e1, e2);

      // Create memories linked to entities in the same community
      const m1 = insertMemoryWithEmbedding(db, { id: "m1", content: "memory one" });
      const m2 = insertMemoryWithEmbedding(db, { id: "m2", content: "memory two" });
      const m3 = insertMemoryWithEmbedding(db, { id: "m3", content: "memory three" });
      linkMemoryToEntity(db, m1, e1);
      linkMemoryToEntity(db, m2, e1);
      linkMemoryToEntity(db, m3, e2);

      const clusters: ConsolidationCluster[] = [{
        centroidId: m1,
        memberIds: [m1, m2, m3],
        avgSimilarity: 0.9,
        topic: "same community topic",
      }];

      const result = applyCommunityAwareFiltering(db, clusters, 2);
      expect(result.clusters).toHaveLength(1);
      expect(result.clusters[0].memberIds).toContain(m1);
      expect(result.clusters[0].memberIds).toContain(m2);
      expect(result.clusters[0].memberIds).toContain(m3);
      expect(result.clustersSplit).toBe(0);
    });

    it("splits cluster when memories span different communities", () => {
      // Community A: e1 <-> e2
      const e1 = createEntity(db, "ent-1", "Alpha");
      const e2 = createEntity(db, "ent-2", "Beta");
      addRelationship(db, e1, e2);

      // Community B: e3 <-> e4 (disconnected from A)
      const e3 = createEntity(db, "ent-3", "Gamma");
      const e4 = createEntity(db, "ent-4", "Delta");
      addRelationship(db, e3, e4);

      // Memories in community A
      const m1 = insertMemoryWithEmbedding(db, { id: "m1", content: "memory about Alpha" });
      const m2 = insertMemoryWithEmbedding(db, { id: "m2", content: "memory about Beta" });
      linkMemoryToEntity(db, m1, e1);
      linkMemoryToEntity(db, m2, e2);

      // Memories in community B
      const m3 = insertMemoryWithEmbedding(db, { id: "m3", content: "memory about Gamma" });
      const m4 = insertMemoryWithEmbedding(db, { id: "m4", content: "memory about Delta" });
      linkMemoryToEntity(db, m3, e3);
      linkMemoryToEntity(db, m4, e4);

      const clusters: ConsolidationCluster[] = [{
        centroidId: m1,
        memberIds: [m1, m2, m3, m4],
        avgSimilarity: 0.85,
        topic: "cross-community cluster",
      }];

      const result = applyCommunityAwareFiltering(db, clusters, 2);
      // Should have 2 sub-clusters (one per community)
      expect(result.clusters).toHaveLength(2);
      expect(result.clustersSplit).toBe(1);

      // Verify each sub-cluster contains only members from one community
      const allMemberIds = result.clusters.flatMap(c => c.memberIds);
      expect(allMemberIds).toContain(m1);
      expect(allMemberIds).toContain(m2);
      expect(allMemberIds).toContain(m3);
      expect(allMemberIds).toContain(m4);

      // Each cluster should have exactly 2 members
      for (const cluster of result.clusters) {
        expect(cluster.memberIds).toHaveLength(2);
      }
    });

    it("identifies and boosts bridge memories", () => {
      // Community A: e1 <-> e2
      const e1 = createEntity(db, "ent-1", "Alpha");
      const e2 = createEntity(db, "ent-2", "Beta");
      addRelationship(db, e1, e2);

      // Community B: e3 <-> e4 (disconnected from A)
      const e3 = createEntity(db, "ent-3", "Gamma");
      const e4 = createEntity(db, "ent-4", "Delta");
      addRelationship(db, e3, e4);

      // Bridge memory: linked to entities in both communities
      const bridge = insertMemoryWithEmbedding(db, { id: "bridge", content: "bridge memory", importance: 0.3 });
      linkMemoryToEntity(db, bridge, e1);
      linkMemoryToEntity(db, bridge, e3);

      // Normal memories in community A
      const m1 = insertMemoryWithEmbedding(db, { id: "m1", content: "memory one" });
      const m2 = insertMemoryWithEmbedding(db, { id: "m2", content: "memory two" });
      linkMemoryToEntity(db, m1, e1);
      linkMemoryToEntity(db, m2, e2);

      const clusters: ConsolidationCluster[] = [{
        centroidId: m1,
        memberIds: [m1, m2, bridge],
        avgSimilarity: 0.85,
        topic: "cluster with bridge",
      }];

      const result = applyCommunityAwareFiltering(db, clusters, 2);

      // Bridge memory should be identified
      expect(result.bridgeMemoryIds).toContain("bridge");

      // Bridge memory should have its importance boosted
      const mem = db.prepare("SELECT importance FROM memories WHERE id = ?").get("bridge") as any;
      expect(mem.importance).toBeGreaterThanOrEqual(0.8);

      // Bridge memory should NOT be in any cluster (it's preserved separately)
      for (const cluster of result.clusters) {
        expect(cluster.memberIds).not.toContain("bridge");
      }
    });

    it("drops sub-clusters smaller than minClusterSize after splitting", () => {
      // Community A: e1 <-> e2
      const e1 = createEntity(db, "ent-1", "Alpha");
      const e2 = createEntity(db, "ent-2", "Beta");
      addRelationship(db, e1, e2);

      // Community B: e3 <-> e4
      const e3 = createEntity(db, "ent-3", "Gamma");
      const e4 = createEntity(db, "ent-4", "Delta");
      addRelationship(db, e3, e4);

      // 2 memories in community A, 1 memory in community B
      const m1 = insertMemoryWithEmbedding(db, { id: "m1", content: "memory one" });
      const m2 = insertMemoryWithEmbedding(db, { id: "m2", content: "memory two" });
      const m3 = insertMemoryWithEmbedding(db, { id: "m3", content: "memory three" });
      linkMemoryToEntity(db, m1, e1);
      linkMemoryToEntity(db, m2, e2);
      linkMemoryToEntity(db, m3, e3);

      const clusters: ConsolidationCluster[] = [{
        centroidId: m1,
        memberIds: [m1, m2, m3],
        avgSimilarity: 0.85,
        topic: "split cluster",
      }];

      // With minClusterSize=2, community B sub-cluster (only m3) gets dropped
      const result = applyCommunityAwareFiltering(db, clusters, 2);
      expect(result.clustersSplit).toBe(1);
      expect(result.clusters).toHaveLength(1);
      expect(result.clusters[0].memberIds).toContain(m1);
      expect(result.clusters[0].memberIds).toContain(m2);
      expect(result.clusters[0].memberIds).not.toContain(m3);
    });

    it("handles memories with no entity links gracefully", () => {
      // Create a community so detection has something to find
      const e1 = createEntity(db, "ent-1", "Alpha");
      const e2 = createEntity(db, "ent-2", "Beta");
      addRelationship(db, e1, e2);

      // Memories with no entity links
      const m1 = insertMemoryWithEmbedding(db, { id: "m1", content: "unlinked memory one" });
      const m2 = insertMemoryWithEmbedding(db, { id: "m2", content: "unlinked memory two" });

      const clusters: ConsolidationCluster[] = [{
        centroidId: m1,
        memberIds: [m1, m2],
        avgSimilarity: 0.9,
        topic: "unlinked memories",
      }];

      const result = applyCommunityAwareFiltering(db, clusters, 2);
      // Should keep the cluster intact — unlinked memories go to community -1
      expect(result.clusters).toHaveLength(1);
      expect(result.clusters[0].memberIds).toContain(m1);
      expect(result.clusters[0].memberIds).toContain(m2);
      expect(result.clustersSplit).toBe(0);
    });

    it("integrates with findClusters via communityAware option", () => {
      // Community A: e1 <-> e2
      const e1 = createEntity(db, "ent-1", "Alpha");
      const e2 = createEntity(db, "ent-2", "Beta");
      addRelationship(db, e1, e2);

      // Community B: e3 <-> e4
      const e3 = createEntity(db, "ent-3", "Gamma");
      const e4 = createEntity(db, "ent-4", "Delta");
      addRelationship(db, e3, e4);

      const base = randomEmbedding(42);
      const m1 = insertMemoryWithEmbedding(db, { id: "ca-1", content: "similar memory from community A", embedding: similarEmbedding(base, 0.01) });
      const m2 = insertMemoryWithEmbedding(db, { id: "ca-2", content: "similar memory from community A", embedding: similarEmbedding(base, 0.01) });
      const m3 = insertMemoryWithEmbedding(db, { id: "cb-1", content: "similar memory from community B", embedding: similarEmbedding(base, 0.01) });
      const m4 = insertMemoryWithEmbedding(db, { id: "cb-2", content: "similar memory from community B", embedding: similarEmbedding(base, 0.01) });
      linkMemoryToEntity(db, m1, e1);
      linkMemoryToEntity(db, m2, e2);
      linkMemoryToEntity(db, m3, e3);
      linkMemoryToEntity(db, m4, e4);

      // Without community-aware: should find one big cluster
      const rawClusters = findClusters(db, { minSimilarity: 0.9, minClusterSize: 2 });
      const rawTotalMembers = rawClusters.reduce((sum, c) => sum + c.memberIds.length, 0);
      expect(rawTotalMembers).toBe(4);

      // With community-aware: should split into two clusters
      const caClusters = findClusters(db, { minSimilarity: 0.9, minClusterSize: 2, communityAware: true });
      expect(caClusters.length).toBe(2);
      for (const cluster of caClusters) {
        expect(cluster.memberIds).toHaveLength(2);
      }
    });
  });
});
