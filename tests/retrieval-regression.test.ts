import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  initializeSchema,
  MemoryStore,
  setEmbeddingProvider,
  resetEmbeddingProvider,
  setSetting,
  setGoldenQueries,
  getLatestRetrievalRegressionRunId,
  promoteGoldenBaselinesFromRun,
  resetGoldenBaselines,
  compareRetrievalAgainstRun,
  runRetrievalRegression,
} from "@exocortex/core";
import type { EmbeddingProvider } from "@exocortex/core";

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

beforeEach(async () => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  initializeSchema(db);
  setEmbeddingProvider(new MockEmbeddingProvider());
  store = new MemoryStore(db);

  await store.create({
    content: "Exocortex retrieval architecture uses hybrid scoring with RRF.",
    tags: ["exocortex", "retrieval"],
  });
  await store.create({
    content: "Cortex sentinel health-check reliability issues and fixes.",
    tags: ["cortex", "health-check"],
  });
  await store.create({
    content: "Alpha trade exit logic mismatches between live and paper trader.",
    tags: ["alpha-trade", "exit-logic"],
  });
});

afterEach(() => {
  db.close();
  resetEmbeddingProvider();
});

describe("runRetrievalRegression", () => {
  it("initializes baselines on first run and compares on second run", async () => {
    setGoldenQueries(db, [
      "exocortex retrieval architecture",
      "cortex sentinel health-check reliability",
    ]);

    const first = await runRetrievalRegression(db, { limit: 1 });
    expect(first.ran).toBe(2);
    expect(first.initialized).toBe(2);
    expect(first.alerts).toBe(0);

    const second = await runRetrievalRegression(db, { limit: 5 });
    expect(second.ran).toBe(2);
    expect(second.initialized).toBe(0);
    for (const row of second.results) {
      expect(row.overlap_at_10).toBeGreaterThan(0);
    }
  });

  it("raises alerts and can store alert memory when drift breaches thresholds", async () => {
    setGoldenQueries(db, ["alpha trade exit logic mismatches"]);
    await runRetrievalRegression(db, { limit: 5 });

    const baseline = await store.getRecent(1);
    expect(baseline.length).toBe(1);
    await store.delete(baseline[0].id);

    const run = await runRetrievalRegression(db, {
      limit: 5,
      min_overlap_at_10: 1,
      max_avg_rank_shift: 0,
      create_alert_memory: true,
    });

    expect(run.alerts).toBeGreaterThan(0);
    expect(run.alert_memory_id).toBeTruthy();

    const alertMemory = await store.getById(run.alert_memory_id!);
    expect(alertMemory).not.toBeNull();
    expect(alertMemory!.tags).toContain("benchmark-artifact");
    expect(alertMemory!.tags).toContain("retrieval-regression");
  });

  it("supports filtered golden query definitions and baseline updates", async () => {
    await store.create({
      content: "Retrieval architecture deep dive for note-only baselines.",
      content_type: "note",
      tags: ["retrieval", "architecture"],
    });

    setGoldenQueries(db, [
      {
        query: "retrieval architecture deep dive",
        tags: ["retrieval"],
        content_type: "note",
      },
    ]);

    const first = await runRetrievalRegression(db, { limit: 5 });
    expect(first.initialized).toBe(1);
    expect(first.results[0].current_ids.length).toBeGreaterThan(0);

    const previousTopId = first.results[0].current_ids[0];
    await store.delete(previousTopId);
    await store.create({
      content: "Replacement retrieval architecture note after baseline shift.",
      content_type: "note",
      tags: ["retrieval", "architecture"],
    });

    const second = await runRetrievalRegression(db, {
      limit: 1,
      min_overlap_at_10: 1,
      max_avg_rank_shift: 0,
      update_baselines: true,
    });
    expect(second.alerts).toBeGreaterThan(0);

    const third = await runRetrievalRegression(db, {
      limit: 1,
      min_overlap_at_10: 1,
      max_avg_rank_shift: 0,
    });
    expect(third.alerts).toBe(0);
  });

  it("excludes benchmark metadata memories by default and includes them when requested", async () => {
    setSetting(db, "search.metadata_mode", "exclude");
    setSetting(db, "benchmark.indexed", "true");
    setSetting(db, "dedup.enabled", "false");

    const normal = await store.create({
      content: "Golden benchmark exclusion query normal memory",
      tags: ["regression"],
      content_type: "note",
    });
    const benchmark = await store.create({
      content: "Golden benchmark exclusion query benchmark artifact",
      tags: ["regression"],
      content_type: "note",
      benchmark: true,
    });

    setGoldenQueries(db, [{ query: "golden benchmark exclusion query", tags: ["regression"] }]);
    const defaultRun = await runRetrievalRegression(db, { limit: 10 });
    const defaultIds = defaultRun.results[0].current_ids;
    expect(defaultIds).toContain(normal.memory.id);
    expect(defaultIds).not.toContain(benchmark.memory.id);

    const includeMetadataRun = await runRetrievalRegression(db, {
      queries: [{ query: "golden benchmark exclusion query", tags: ["regression"], include_metadata: true }],
      limit: 10,
      update_baselines: true,
    });
    expect(includeMetadataRun.results[0].current_ids).toContain(benchmark.memory.id);
  });

  it("supports baseline reset/promote and compare against a previous run", async () => {
    setGoldenQueries(db, ["exocortex retrieval architecture"]);

    const first = await runRetrievalRegression(db, { limit: 5 });
    expect(first.run_id).toBeTruthy();

    const latest = getLatestRetrievalRegressionRunId(db);
    expect(latest).toBe(first.run_id);

    const reset = resetGoldenBaselines(db);
    expect(reset.removed).toBeGreaterThan(0);

    const promoted = promoteGoldenBaselinesFromRun(db, first.run_id!);
    expect(promoted.promoted).toBeGreaterThan(0);

    const compare = await compareRetrievalAgainstRun(db, {
      run_id: first.run_id!,
      limit: 5,
      min_overlap_at_10: 0.5,
      max_avg_rank_shift: 10,
    });
    expect(compare.ran).toBeGreaterThan(0);
  });
});
