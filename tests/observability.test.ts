import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  initializeSchema,
  MemoryStore,
  MemorySearch,
  setSetting,
  setGoldenQueries,
  runRetrievalRegression,
  getCounter,
  setEmbeddingProvider,
  resetEmbeddingProvider,
} from "@exocortex/core";
import type { EmbeddingProvider } from "@exocortex/core";

class MockEmbeddingProvider implements EmbeddingProvider {
  embed(text: string): Promise<Float32Array> {
    const arr = new Float32Array(8);
    for (let i = 0; i < text.length; i++) arr[i % 8] += text.charCodeAt(i);
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
let search: MemorySearch;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  initializeSchema(db);
  setEmbeddingProvider(new MockEmbeddingProvider());
  store = new MemoryStore(db);
  search = new MemorySearch(db);
});

afterEach(() => {
  db.close();
  resetEmbeddingProvider();
});

describe("observability counters", () => {
  it("tracks benchmark writes and dedup skips", async () => {
    await store.create({
      content: "Benchmark memory for observability.",
      benchmark: true,
    });
    await store.create({
      content: "Exact duplicate dedupe observability content for counter test.",
      tags: ["a"],
    });
    await store.create({
      content: "Exact duplicate dedupe observability content for counter test.",
      tags: ["b"],
    });

    expect(getCounter(db, "memory.benchmark_writes")).toBe(1);
    expect(getCounter(db, "memory.dedup_skipped")).toBeGreaterThanOrEqual(1);
  });

  it("tracks metadata exclusion and penalties", async () => {
    setSetting(db, "search.metadata_mode", "exclude");
    await store.create({
      content: "metadata-only benchmark record",
      benchmark: true,
      tags: ["retrieval-regression"],
    });
    await search.search({ query: "metadata benchmark record" });
    expect(getCounter(db, "search.metadata_excluded_queries")).toBeGreaterThan(0);

    setSetting(db, "search.metadata_mode", "penalize");
    await search.search({ query: "metadata benchmark record" });
    expect(getCounter(db, "search.metadata_penalized_queries")).toBeGreaterThan(0);
  });

  it("tracks retrieval regression runs and alerts", async () => {
    await store.create({
      content: "alpha retrieval baseline memory",
      tags: ["alpha"],
    });
    setGoldenQueries(db, ["alpha retrieval baseline"]);
    await runRetrievalRegression(db, { limit: 5 });

    const recent = await store.getRecent(1);
    await store.delete(recent[0].id);

    await runRetrievalRegression(db, {
      limit: 5,
      min_overlap_at_10: 1,
      max_avg_rank_shift: 0,
      create_alert_memory: false,
    });

    expect(getCounter(db, "retrieval_regression.runs")).toBeGreaterThanOrEqual(2);
    expect(getCounter(db, "retrieval_regression.alerts")).toBeGreaterThan(0);
  });
});

