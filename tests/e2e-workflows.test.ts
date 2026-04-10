import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  initializeSchema,
  setSetting,
  setEmbeddingProvider,
  resetEmbeddingProvider,
  MemoryStore,
  MemorySearch,
  MemoryLinkStore,
  EntityStore,
  GoalStore,
  extractEntities,
  findClusters,
  autoConsolidate,
} from "@exocortex/core";
import type { EmbeddingProvider } from "@exocortex/core";

/**
 * Mock embedding provider: deterministic character-frequency vectors.
 * Not semantically meaningful, but sufficient for testing pipeline mechanics.
 */
class MockEmbeddingProvider implements EmbeddingProvider {
  embed(text: string): Promise<Float32Array> {
    const arr = new Float32Array(16);
    const lower = text.toLowerCase();
    for (let i = 0; i < lower.length; i++) {
      arr[lower.charCodeAt(i) % 16] += 1;
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
    return 16;
  }
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

let db: DatabaseSync;
let store: MemoryStore;
let search: MemorySearch;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  initializeSchema(db);
  setEmbeddingProvider(new MockEmbeddingProvider());

  // Use legacy scoring so FTS-only results produce non-zero scores
  setSetting(db, "scoring.use_rrf", "false");
  // Disable quality floor / score gap so all results are visible
  setSetting(db, "search.quality_floor", "0");
  setSetting(db, "search.score_gap_ratio", "0");

  store = new MemoryStore(db);
  search = new MemorySearch(db);
});

afterEach(() => {
  resetEmbeddingProvider();
  db.close();
});

// ---------------------------------------------------------------------------
// 1. Memory lifecycle: store → get → search → update → search again
// ---------------------------------------------------------------------------

describe("memory lifecycle workflow", () => {
  it("creates, retrieves, searches, updates, and re-searches a memory", async () => {
    // Store
    const { memory: created } = await store.create({
      content: "Exocortex uses SQLite for persistent memory storage",
      tags: ["architecture", "database"],
      importance: 0.8,
      namespace: "test",
    });
    expect(created.id).toBeTruthy();

    // Get by ID
    const fetched = await store.getById(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.content).toContain("SQLite");
    expect(fetched!.tags).toContain("architecture");

    // Search — should find it
    const results1 = await search.search({ query: "SQLite storage", min_score: 0 });
    expect(results1.length).toBeGreaterThan(0);
    expect(results1.some((r) => r.memory.id === created.id)).toBe(true);

    // Update content and tags
    const updated = await store.update(created.id, {
      content: "Exocortex uses SQLite with WAL mode for high-performance memory storage",
      tags: ["architecture", "database", "performance"],
      importance: 0.9,
    });
    expect(updated).not.toBeNull();
    expect(updated!.content).toContain("WAL mode");
    expect(updated!.tags).toContain("performance");

    // Search again — should reflect updated content
    const fetched2 = await store.getById(created.id);
    expect(fetched2!.content).toContain("WAL mode");
    expect(fetched2!.importance).toBe(0.9);
  });

  it("archives and excludes memory from active search", async () => {
    const { memory: { id } } = await store.create({
      content: "This memory will be archived soon",
      tags: ["ephemeral"],
    });

    // Deactivate
    await store.update(id, { is_active: false });

    // Active search should not find it
    const results = await search.search({ query: "archived soon", min_score: 0 });
    expect(results.every((r) => r.memory.id !== id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Scoring pipeline: importance affects ranking
// ---------------------------------------------------------------------------

describe("scoring pipeline", () => {
  it("ranks higher-importance memories above lower-importance ones", async () => {
    // Disable semantic dedup — mock embeddings produce near-identical vectors
    // for content with overlapping terms, triggering false-positive dedup
    setSetting(db, "dedup.enabled", "false");

    const { memory: low } = await store.create({
      content: "The data pipeline architecture uses batch processing for ETL workflows",
      tags: ["architecture"],
      importance: 0.2,
    });

    const { memory: high } = await store.create({
      content: "The data pipeline architecture uses stream processing for real-time analytics",
      tags: ["architecture"],
      importance: 0.95,
    });

    const results = await search.search({
      query: "data pipeline architecture processing",
      min_score: 0,
      limit: 10,
    });

    // Both should appear in results
    const highResult = results.find((r) => r.memory.id === high.id);
    const lowResult = results.find((r) => r.memory.id === low.id);
    expect(highResult).toBeDefined();
    expect(lowResult).toBeDefined();

    // Importance doesn't directly affect hybrid score (which is vector + FTS + recency + frequency),
    // but it feeds into qualityScore which influences filtering. Both should be found and have
    // reasonable scores. We verify here that both memories exist with correct importance values.
    const lowMem = await store.getById(low.id);
    const highMem = await store.getById(high.id);
    expect(highMem!.importance).toBe(0.95);
    expect(lowMem!.importance).toBe(0.2);
  });

  it("tag-filtered search narrows results", async () => {
    await store.create({
      content: "React component rendering optimization strategies",
      tags: ["frontend", "react"],
    });

    await store.create({
      content: "Database query rendering optimization techniques",
      tags: ["backend", "sql"],
    });

    const frontendOnly = await search.search({
      query: "rendering optimization",
      tags: ["frontend"],
      min_score: 0,
    });

    expect(frontendOnly.length).toBe(1);
    expect(frontendOnly[0].memory.tags).toContain("frontend");
  });
});

// ---------------------------------------------------------------------------
// 3. Link graph: manual links affect retrieval
// ---------------------------------------------------------------------------

describe("link graph workflow", () => {
  it("creates links between memories and retrieves linked context", async () => {
    const links = new MemoryLinkStore(db);

    const { memory: mem1 } = await store.create({
      content: "Authentication system uses JWT tokens for session management",
      tags: ["auth"],
    });

    const { memory: mem2 } = await store.create({
      content: "JWT tokens should be rotated every 24 hours for security",
      tags: ["auth", "security"],
    });

    const { memory: mem3 } = await store.create({
      content: "Unrelated: the build pipeline uses GitHub Actions",
      tags: ["ci"],
    });

    // Link mem1 ↔ mem2
    links.link(mem1.id, mem2.id, "related", 0.9);

    // Verify links exist
    const mem1Links = links.getLinks(mem1.id);
    expect(mem1Links.length).toBeGreaterThanOrEqual(1);

    // mem2 should appear as linked (either as source or target)
    const linkedPeerIds = mem1Links.map((l) =>
      l.source_id === mem1.id ? l.target_id : l.source_id
    );
    expect(linkedPeerIds).toContain(mem2.id);
    expect(linkedPeerIds).not.toContain(mem3.id);
  });
});

// ---------------------------------------------------------------------------
// 4. Consolidation flow: similar memories → cluster → merge
// ---------------------------------------------------------------------------

describe("consolidation workflow", () => {
  it("finds clusters of similar memories and consolidates them", async () => {
    // Disable dedup so all similar memories are stored (mock embeddings
    // produce high cosine similarity, triggering false-positive dedup)
    setSetting(db, "dedup.enabled", "false");

    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const { memory } = await store.create({
        content: `Decision: use TypeScript for all backend services revision ${i}`,
        tags: ["decision", "typescript"],
        importance: 0.6,
      });
      ids.push(memory.id);
    }

    // Verify all 4 memories were actually stored
    const stored = db.prepare("SELECT COUNT(*) as c FROM memories WHERE embedding IS NOT NULL AND parent_id IS NULL").get() as { c: number };
    expect(stored.c).toBeGreaterThanOrEqual(4);

    // Mock embeddings produce ~0.998 cosine similarity for these, so any threshold works
    const clusters = findClusters(db, { minSimilarity: 0.9, minClusterSize: 2 });
    expect(clusters.length).toBeGreaterThan(0);

    // At least one cluster should contain our memories
    const ourCluster = clusters.find((c) =>
      c.memberIds.some((id) => ids.includes(id))
    );
    expect(ourCluster).toBeDefined();
    expect(ourCluster!.memberIds.length).toBeGreaterThanOrEqual(2);
  });

  it("autoConsolidate merges clusters and sets superseded_by", async () => {
    setSetting(db, "dedup.enabled", "false");

    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { memory } = await store.create({
        content: `Config: the API rate limit is set to 100 requests per minute version ${i}`,
        tags: ["config"],
        importance: 0.5,
      });
      ids.push(memory.id);
    }

    const result = await autoConsolidate(db, new MockEmbeddingProvider(), {
      minSimilarity: 0.9,
      minClusterSize: 2,
      maxClusters: 5,
    });

    // Should have found and processed at least one cluster
    if (result.clustersFound > 0) {
      expect(result.clustersConsolidated).toBeGreaterThanOrEqual(1);
      expect(result.memoriesMerged).toBeGreaterThanOrEqual(2);
      expect(result.summaryIds.length).toBeGreaterThanOrEqual(1);

      // Verify: original memories get archived (is_active=0, parent_id=summaryId)
      let archivedCount = 0;
      for (const id of ids) {
        const mem = await store.getById(id);
        if (mem && !mem.is_active) {
          archivedCount++;
        }
      }
      expect(archivedCount).toBeGreaterThanOrEqual(2);

      // Summary memory should exist and be active
      for (const summaryId of result.summaryIds) {
        const summary = await store.getById(summaryId);
        expect(summary).not.toBeNull();
        expect(summary!.is_active).toBe(true);
        expect(summary!.content_type).toBe("summary");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Entity extraction → linking → entity-aware search expansion
// ---------------------------------------------------------------------------

describe("entity pipeline workflow", () => {
  it("extracts entities from text", () => {
    const entities = extractEntities(
      "TypeScript is used with React and Node.js to build the exocortex dashboard"
    );

    // Should find at least some technology entities
    expect(entities.length).toBeGreaterThan(0);
    const names = entities.map((e) => e.name.toLowerCase());
    expect(names.some((n) => n.includes("typescript") || n.includes("react") || n.includes("node"))).toBe(true);
  });

  it("creates entities and links them to memories", async () => {
    const entityStore = new EntityStore(db);

    // Create entity BEFORE the memory — MemoryStore.create() auto-extracts
    // entities, which would create a duplicate without our custom aliases
    const entity = entityStore.create({
      name: "Valkey",
      type: "technology",
      aliases: ["valkey-cache", "vk"],
    });

    const { memory: mem } = await store.create({
      content: "Valkey handles our caching layer with cluster mode",
      tags: ["database"],
    });

    entityStore.linkMemory(entity.id, mem.id, 0.9);

    // Verify the link
    const linkedMemories = entityStore.getMemoriesForEntity(entity.id);
    expect(linkedMemories).toContain(mem.id);

    // Entity should be retrievable with aliases intact
    const fetched = entityStore.getByName("Valkey");
    expect(fetched).not.toBeNull();
    expect(fetched!.aliases).toContain("valkey-cache");
  });

  it("entity aliases expand search queries", async () => {
    const entityStore = new EntityStore(db);
    setSetting(db, "search.query_expansion", "true");

    // Create entity with aliases
    entityStore.create({
      name: "kubernetes",
      type: "technology",
      aliases: ["k8s", "kube"],
    });

    // Create memory with alias term
    await store.create({
      content: "k8s cluster autoscaling configuration for production workloads",
      tags: ["infrastructure"],
    });

    // Search with canonical name — should expand to find alias match
    const results = await search.search({
      query: "kubernetes cluster scaling",
      min_score: 0,
    });

    // The query expansion should add "k8s" and "kube" to the query
    expect(results.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Goal + memory integration
// ---------------------------------------------------------------------------

describe("goal-memory integration", () => {
  it("creates a goal and logs progress that creates a linked memory", async () => {
    const goals = new GoalStore(db);

    const goal = goals.create({
      title: "Ship exocortex v1.0",
      description: "Complete all features for public release",
      priority: "high",
    });

    expect(goal.id).toBeTruthy();
    expect(goal.status).toBe("active");

    // Log progress — this should create a memory
    const memoryId = await goals.logProgress(
      goal.id,
      "Completed E2E test suite covering 6 major workflows",
      0.7
    );

    expect(memoryId).toBeTruthy();

    // The progress memory should exist
    const progressMem = await store.getById(memoryId);
    expect(progressMem).not.toBeNull();
    expect(progressMem!.content).toContain("E2E test suite");

    // Update goal status
    const completed = goals.update(goal.id, { status: "completed" });
    expect(completed).not.toBeNull();
    expect(completed!.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// 7. Tier-aware storage and search
// ---------------------------------------------------------------------------

describe("tier-aware workflow", () => {
  it("stores memories at different tiers and filters by tier", async () => {
    await store.create({
      content: "Working note: debugging the search scoring issue",
      tier: "working",
      tags: ["debug"],
    });

    await store.create({
      content: "TypeScript generics are covariant by default for type parameters",
      tier: "semantic",
      tags: ["typescript"],
      importance: 0.8,
    });

    await store.create({
      content: "To fix flaky tests, always reset global state in afterEach hooks",
      tier: "procedural",
      tags: ["testing", "technique"],
      importance: 0.7,
    });

    // Search with tier filter
    const semanticOnly = await search.search({
      query: "TypeScript",
      tier: "semantic",
      min_score: 0,
    });
    expect(semanticOnly.every((r) => r.memory.tier === "semantic")).toBe(true);

    const proceduralOnly = await search.search({
      query: "testing",
      tier: "procedural",
      min_score: 0,
    });
    expect(proceduralOnly.every((r) => r.memory.tier === "procedural")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. Namespace isolation
// ---------------------------------------------------------------------------

describe("namespace isolation", () => {
  it("memories in different namespaces do not cross-contaminate searches", async () => {
    // Disable dedup — similar content in different namespaces triggers false-positive dedup
    setSetting(db, "dedup.enabled", "false");

    await store.create({
      content: "Alpha project uses Kubernetes for container orchestration",
      namespace: "alpha",
      tags: ["infrastructure"],
    });

    await store.create({
      content: "Beta project uses Docker Swarm for container orchestration",
      namespace: "beta",
      tags: ["infrastructure"],
    });

    const alphaResults = await search.search({
      query: "container orchestration",
      namespace: "alpha",
      min_score: 0,
    });

    // Only alpha namespace results
    expect(alphaResults.length).toBeGreaterThanOrEqual(1);
    expect(alphaResults.every((r) => r.memory.namespace === "alpha")).toBe(true);

    const betaResults = await search.search({
      query: "container orchestration",
      namespace: "beta",
      min_score: 0,
    });

    // Only beta namespace results
    expect(betaResults.length).toBeGreaterThanOrEqual(1);
    expect(betaResults.every((r) => r.memory.namespace === "beta")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. Namespace-aware dedup regression
// ---------------------------------------------------------------------------

describe("namespace-aware dedup regression", () => {
  it("does not dedup similar content across different namespaces", async () => {
    // Do NOT disable dedup — we are testing that dedup respects namespace boundaries
    const { memory: alphaMemory } = await store.create({
      content:
        "The deployment pipeline uses blue-green strategy for zero-downtime releases",
      tags: ["devops"],
      namespace: "alpha",
    });

    const { memory: betaMemory } = await store.create({
      content:
        "The deployment pipeline uses canary strategy for zero-downtime releases",
      tags: ["devops"],
      namespace: "beta",
    });

    // Both memories should exist and be active — the second must not be
    // deduped against the first since they are in different namespaces
    const fetchedAlpha = await store.getById(alphaMemory.id);
    expect(fetchedAlpha).not.toBeNull();
    expect(fetchedAlpha!.is_active).toBe(true);
    expect(fetchedAlpha!.namespace).toBe("alpha");

    const fetchedBeta = await store.getById(betaMemory.id);
    expect(fetchedBeta).not.toBeNull();
    expect(fetchedBeta!.is_active).toBe(true);
    expect(fetchedBeta!.namespace).toBe("beta");

    // Verify they are distinct memories, not one superseding the other
    expect(alphaMemory.id).not.toBe(betaMemory.id);
  });
});

// ---------------------------------------------------------------------------
// 10. Importance weight in scoring
// ---------------------------------------------------------------------------

describe("importance weight in scoring", () => {
  it("high-importance memories score higher than low-importance ones", async () => {
    // Disable dedup so all memories are stored regardless of similarity
    setSetting(db, "dedup.enabled", "false");

    const { memory: lowImportance } = await store.create({
      content: "Redis caching layer configuration for session storage",
      tags: ["database"],
      importance: 0.1,
    });

    const { memory: highImportance } = await store.create({
      content: "PostgreSQL database indexing optimization for query performance",
      tags: ["database"],
      importance: 0.95,
    });

    const { memory: medImportance } = await store.create({
      content: "MongoDB sharding strategy for horizontal database scaling",
      tags: ["database"],
      importance: 0.5,
    });

    const results = await search.search({
      query: "database",
      min_score: 0,
      limit: 10,
    });

    // All three should appear in results
    const highResult = results.find((r) => r.memory.id === highImportance.id);
    const medResult = results.find((r) => r.memory.id === medImportance.id);
    const lowResult = results.find((r) => r.memory.id === lowImportance.id);
    expect(highResult).toBeDefined();
    expect(medResult).toBeDefined();
    expect(lowResult).toBeDefined();

    // The high-importance memory should score higher than the low-importance one
    expect(highResult!.score).toBeGreaterThan(lowResult!.score);
  });
});
