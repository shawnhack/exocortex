import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  initializeSchema,
  MemoryStore,
  setEmbeddingProvider,
  resetEmbeddingProvider,
  detectContradictions,
  recordContradiction,
  getContradictions,
  updateContradiction,
  autoDismissContradictions,
} from "@exocortex/core";
import type { EmbeddingProvider, ContradictionCandidate } from "@exocortex/core";

// Mock embedder that produces similar vectors for similar prefixes
class MockEmbeddingProvider implements EmbeddingProvider {
  embed(text: string): Promise<Float32Array> {
    const arr = new Float32Array(8);
    for (let i = 0; i < text.length; i++) arr[i % 8] += text.charCodeAt(i) / 1000;
    let norm = 0;
    for (let i = 0; i < arr.length; i++) norm += arr[i] * arr[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < arr.length; i++) arr[i] /= norm;
    return Promise.resolve(arr);
  }
  embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
  dimensions(): number { return 8; }
}

// Embedder that lets us control exact vectors per memory
class ControlledEmbeddingProvider implements EmbeddingProvider {
  private vectors = new Map<string, Float32Array>();

  set(text: string, vector: Float32Array) {
    this.vectors.set(text, vector);
  }

  embed(text: string): Promise<Float32Array> {
    const v = this.vectors.get(text);
    if (v) return Promise.resolve(v);
    // Fallback: deterministic hash
    const arr = new Float32Array(8);
    for (let i = 0; i < text.length; i++) arr[i % 8] += text.charCodeAt(i) / 1000;
    let norm = 0;
    for (let i = 0; i < arr.length; i++) norm += arr[i] * arr[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < arr.length; i++) arr[i] /= norm;
    return Promise.resolve(arr);
  }
  embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
  dimensions(): number { return 8; }
}

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  initializeSchema(db);
  setEmbeddingProvider(new MockEmbeddingProvider());
  return () => resetEmbeddingProvider();
});

describe("contradiction CRUD", () => {
  it("records and retrieves a contradiction", async () => {
    const store = new MemoryStore(db);
    const a = await store.create({ content: "We use React for the frontend" });
    const b = await store.create({ content: "We stopped using React" });

    const candidate: ContradictionCandidate = {
      memory_a_id: a.memory.id,
      memory_b_id: b.memory.id,
      similarity: 0.85,
      reason: "Negation detected",
    };

    const recorded = recordContradiction(db, candidate);
    expect(recorded.id).toBeTruthy();
    expect(recorded.status).toBe("pending");
    expect(recorded.description).toBe("Negation detected");

    const all = getContradictions(db);
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(recorded.id);
  });

  it("filters contradictions by status", async () => {
    const store = new MemoryStore(db);
    const a = await store.create({ content: "Memory A" });
    const b = await store.create({ content: "Memory B" });
    const c = await store.create({ content: "Memory C" });

    const c1 = recordContradiction(db, {
      memory_a_id: a.memory.id, memory_b_id: b.memory.id,
      similarity: 0.8, reason: "Reason 1",
    });
    recordContradiction(db, {
      memory_a_id: a.memory.id, memory_b_id: c.memory.id,
      similarity: 0.8, reason: "Reason 2",
    });

    updateContradiction(db, c1.id, { status: "resolved", resolution: "A is correct" });

    expect(getContradictions(db, "pending")).toHaveLength(1);
    expect(getContradictions(db, "resolved")).toHaveLength(1);
    expect(getContradictions(db, "dismissed")).toHaveLength(0);
  });

  it("updates contradiction status and resolution", async () => {
    const store = new MemoryStore(db);
    const a = await store.create({ content: "Memory A" });
    const b = await store.create({ content: "Memory B" });

    const c = recordContradiction(db, {
      memory_a_id: a.memory.id, memory_b_id: b.memory.id,
      similarity: 0.8, reason: "Test",
    });

    const updated = updateContradiction(db, c.id, {
      status: "dismissed",
      resolution: "Not a real contradiction",
    });

    expect(updated!.status).toBe("dismissed");
    expect(updated!.resolution).toBe("Not a real contradiction");
  });

  it("returns null when updating nonexistent contradiction", () => {
    expect(updateContradiction(db, "missing", { status: "resolved" })).toBeNull();
  });

  it("respects limit parameter", async () => {
    const store = new MemoryStore(db);
    const a = await store.create({ content: "A" });
    const b = await store.create({ content: "B" });
    const c = await store.create({ content: "C" });

    recordContradiction(db, { memory_a_id: a.memory.id, memory_b_id: b.memory.id, similarity: 0.8, reason: "R1" });
    recordContradiction(db, { memory_a_id: a.memory.id, memory_b_id: c.memory.id, similarity: 0.8, reason: "R2" });

    expect(getContradictions(db, undefined, 1)).toHaveLength(1);
  });
});

describe("detectContradictions", () => {
  it("detects negation contradiction between similar memories", async () => {
    const embedder = new ControlledEmbeddingProvider();
    setEmbeddingProvider(embedder);

    // Create two vectors that are nearly identical (high cosine similarity)
    const baseVec = new Float32Array([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const similarVec = new Float32Array([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.49]);

    embedder.set("We use PostgreSQL for the database", baseVec);
    embedder.set("We don't use PostgreSQL for the database", similarVec);

    const store = new MemoryStore(db);
    await store.create({ content: "We use PostgreSQL for the database" });
    await store.create({ content: "We don't use PostgreSQL for the database" });

    const candidates = detectContradictions(db, { similarityThreshold: 0.9 });
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(candidates[0].reason).toContain("negation");
  });

  it("detects value change contradictions", async () => {
    const embedder = new ControlledEmbeddingProvider();
    setEmbeddingProvider(embedder);

    const baseVec = new Float32Array([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const similarVec = new Float32Array([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.49]);

    embedder.set("The API is using REST endpoints", baseVec);
    embedder.set("The API is using GraphQL endpoints", similarVec);

    const store = new MemoryStore(db);
    await store.create({ content: "The API is using REST endpoints" });
    await store.create({ content: "The API is using GraphQL endpoints" });

    const candidates = detectContradictions(db, { similarityThreshold: 0.9 });
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(candidates[0].reason).toContain("value change");
  });

  it("skips pairs below similarity threshold", async () => {
    const embedder = new ControlledEmbeddingProvider();
    setEmbeddingProvider(embedder);

    // Orthogonal vectors — zero similarity
    embedder.set("Memory about databases", new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]));
    embedder.set("Memory about not using frontend", new Float32Array([0, 1, 0, 0, 0, 0, 0, 0]));

    const store = new MemoryStore(db);
    await store.create({ content: "Memory about databases" });
    await store.create({ content: "Memory about not using frontend" });

    const candidates = detectContradictions(db, { similarityThreshold: 0.7 });
    expect(candidates).toHaveLength(0);
  });

  it("skips already-recorded contradiction pairs", async () => {
    const embedder = new ControlledEmbeddingProvider();
    setEmbeddingProvider(embedder);

    const baseVec = new Float32Array([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const similarVec = new Float32Array([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.49]);

    embedder.set("We use React for everything", baseVec);
    embedder.set("We stopped using React for everything", similarVec);

    const store = new MemoryStore(db);
    const a = await store.create({ content: "We use React for everything" });
    const b = await store.create({ content: "We stopped using React for everything" });

    // First detection finds it
    const first = detectContradictions(db, { similarityThreshold: 0.9 });
    expect(first.length).toBeGreaterThanOrEqual(1);

    // Record it
    recordContradiction(db, first[0]);

    // Second detection skips it
    const second = detectContradictions(db, { similarityThreshold: 0.9 });
    const pair = second.find(
      (c) =>
        (c.memory_a_id === a.memory.id && c.memory_b_id === b.memory.id) ||
        (c.memory_a_id === b.memory.id && c.memory_b_id === a.memory.id)
    );
    expect(pair).toBeUndefined();
  });

  it("returns candidates sorted by similarity descending", async () => {
    const embedder = new ControlledEmbeddingProvider();
    setEmbeddingProvider(embedder);

    const v1 = new Float32Array([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const v2 = new Float32Array([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.49]); // very similar to v1
    const v3 = new Float32Array([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.49, 0.48]); // slightly less similar

    embedder.set("We are using Redis for caching", v1);
    embedder.set("We stopped using Redis for caching", v2);
    embedder.set("We never used Redis for caching", v3);

    const store = new MemoryStore(db);
    await store.create({ content: "We are using Redis for caching" });
    await store.create({ content: "We stopped using Redis for caching" });
    await store.create({ content: "We never used Redis for caching" });

    const candidates = detectContradictions(db, { similarityThreshold: 0.9 });
    if (candidates.length >= 2) {
      expect(candidates[0].similarity).toBeGreaterThanOrEqual(candidates[1].similarity);
    }
  });

  it("respects maxMemories option", async () => {
    const store = new MemoryStore(db);
    // Create more memories than the limit
    for (let i = 0; i < 5; i++) {
      await store.create({ content: `Memory number ${i} about testing` });
    }

    // With maxMemories=2, only 2 memories compared — at most 1 pair
    const candidates = detectContradictions(db, { maxMemories: 2 });
    // Can't have more pairs than C(2,2) = 1
    expect(candidates.length).toBeLessThanOrEqual(1);
  });

  it("ignores inactive memories", async () => {
    const embedder = new ControlledEmbeddingProvider();
    setEmbeddingProvider(embedder);

    const v1 = new Float32Array([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const v2 = new Float32Array([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.49]);

    embedder.set("Active statement about using Vue", v1);
    embedder.set("We don't use Vue anymore", v2);

    const store = new MemoryStore(db);
    const a = await store.create({ content: "Active statement about using Vue" });
    await store.create({ content: "We don't use Vue anymore" });

    // Deactivate one memory
    db.prepare("UPDATE memories SET is_active = 0 WHERE id = ?").run(a.memory.id);

    const candidates = detectContradictions(db, { similarityThreshold: 0.9 });
    expect(candidates).toHaveLength(0);
  });
});

describe("autoDismissContradictions", () => {
  function insertContradiction(
    memAId: string,
    memBId: string,
    reason: string
  ): string {
    const id = `CONTRA_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString().replace("T", " ").replace("Z", "");
    db.prepare(
      `INSERT INTO contradictions (id, memory_a_id, memory_b_id, description, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`
    ).run(id, memAId, memBId, reason, now, now);
    return id;
  }

  it("dismisses when memory is deleted", async () => {
    const store = new MemoryStore(db);
    const a = await store.create({ content: "Memory A about testing" });
    const b = await store.create({ content: "Memory B about testing" });

    insertContradiction(a.memory.id, b.memory.id, "negation conflict: test");

    // Delete memory A
    db.prepare("UPDATE memories SET is_active = 0 WHERE id = ?").run(a.memory.id);

    const result = autoDismissContradictions(db);
    expect(result.dismissed).toBe(1);
    expect(result.reasons.deleted_source).toBe(1);
    expect(getContradictions(db, "pending")).toHaveLength(0);
    expect(getContradictions(db, "dismissed")).toHaveLength(1);
  });

  it("dismisses consolidation artifacts", async () => {
    const store = new MemoryStore(db);
    const a = await store.create({ content: "[Consolidated summary of 3 memories from 2026-02-14..." });
    const b = await store.create({ content: "Normal memory about architecture" });

    insertContradiction(a.memory.id, b.memory.id, "value change: something");

    const result = autoDismissContradictions(db);
    expect(result.dismissed).toBe(1);
    expect(result.reasons.consolidation_artifact).toBe(1);
  });

  it("dismisses low quality pairs", async () => {
    const store = new MemoryStore(db);
    const a = await store.create({ content: "Low quality memory A about topic" });
    const b = await store.create({ content: "Low quality memory B about topic" });

    // Set both to low quality
    db.prepare("UPDATE memories SET quality_score = 0.10 WHERE id = ?").run(a.memory.id);
    db.prepare("UPDATE memories SET quality_score = 0.15 WHERE id = ?").run(b.memory.id);

    insertContradiction(a.memory.id, b.memory.id, "negation conflict: test");

    const result = autoDismissContradictions(db);
    expect(result.dismissed).toBe(1);
    expect(result.reasons.low_quality).toBe(1);
  });

  it("dismisses version-number value changes", async () => {
    const store = new MemoryStore(db);
    const a = await store.create({ content: "Package version is 2.1" });
    const b = await store.create({ content: "Package version is 3.0" });

    insertContradiction(a.memory.id, b.memory.id, 'value change: "2.1.0" vs "3.0.0"');

    const result = autoDismissContradictions(db);
    expect(result.dismissed).toBe(1);
    expect(result.reasons.version_date_change).toBe(1);
  });

  it("keeps real contradictions", async () => {
    const store = new MemoryStore(db);
    const a = await store.create({ content: "We use PostgreSQL for the database" });
    const b = await store.create({ content: "We use MySQL for the database" });

    // Set reasonable quality
    db.prepare("UPDATE memories SET quality_score = 0.60 WHERE id = ?").run(a.memory.id);
    db.prepare("UPDATE memories SET quality_score = 0.55 WHERE id = ?").run(b.memory.id);

    insertContradiction(
      a.memory.id,
      b.memory.id,
      'value change: "PostgreSQL for the database" vs "MySQL for the database"'
    );

    const result = autoDismissContradictions(db);
    expect(result.dismissed).toBe(0);
    expect(getContradictions(db, "pending")).toHaveLength(1);
  });
});
