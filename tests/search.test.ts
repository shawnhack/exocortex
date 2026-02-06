import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  initializeSchema,
  MemoryStore,
  MemorySearch,
  setEmbeddingProvider,
  resetEmbeddingProvider,
} from "@exocortex/core";
import type { EmbeddingProvider } from "@exocortex/core";

// Mock embedder that produces somewhat meaningful vectors
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

let db: DatabaseSync;
let store: MemoryStore;
let search: MemorySearch;

beforeEach(async () => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  initializeSchema(db);
  setEmbeddingProvider(new MockEmbeddingProvider());
  store = new MemoryStore(db);
  search = new MemorySearch(db);

  await store.create({
    content: "TypeScript is a typed superset of JavaScript",
    tags: ["programming", "typescript"],
  });
  await store.create({
    content: "React is a JavaScript library for building user interfaces",
    tags: ["programming", "react"],
  });
  await store.create({
    content: "SQLite is a lightweight database engine",
    tags: ["database"],
  });
  await store.create({
    content: "The weather today is sunny and warm",
    tags: ["weather"],
  });
});

afterEach(() => {
  db.close();
  resetEmbeddingProvider();
});

describe("MemorySearch", () => {
  it("returns results for a matching query", async () => {
    const results = await search.search({ query: "JavaScript" });
    expect(results.length).toBeGreaterThan(0);
    const contents = results.map((r) => r.memory.content);
    expect(contents.some((c) => c.includes("JavaScript"))).toBe(true);
  });

  it("returns results with score breakdown", async () => {
    const results = await search.search({ query: "database" });
    expect(results.length).toBeGreaterThan(0);

    const first = results[0];
    expect(first.score).toBeGreaterThan(0);
    expect(typeof first.vector_score).toBe("number");
    expect(typeof first.fts_score).toBe("number");
    expect(typeof first.recency_score).toBe("number");
    expect(typeof first.frequency_score).toBe("number");
  });

  it("respects tag filter", async () => {
    const results = await search.search({
      query: "programming language",
      tags: ["database"],
    });
    for (const r of results) {
      expect(r.memory.tags).toContain("database");
    }
  });

  it("respects content_type filter", async () => {
    await store.create({
      content: "A conversation about databases",
      content_type: "conversation",
      tags: ["database"],
    });

    const results = await search.search({
      query: "database",
      content_type: "conversation",
    });

    for (const r of results) {
      expect(r.memory.content_type).toBe("conversation");
    }
  });

  it("respects limit", async () => {
    const results = await search.search({
      query: "programming language JavaScript TypeScript",
      limit: 1,
    });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("returns no FTS matches for gibberish query", async () => {
    const results = await search.search({
      query: "xyznonexistent123456",
    });
    // With a mock embedder, vector similarity is nonzero so results may appear
    // But FTS should not match
    for (const r of results) {
      expect(r.fts_score).toBe(0);
    }
  });

  it("ranks more relevant results higher", async () => {
    const results = await search.search({ query: "SQLite database" });
    if (results.length >= 2) {
      expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
    }
  });
});
