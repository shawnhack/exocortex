import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getDbForTesting,
  initializeSchema,
  MemoryStore,
  setSetting,
  setEmbeddingProvider,
  resetEmbeddingProvider,
} from "@exocortex/core";
import type { DatabaseSync } from "@exocortex/core";

const mockProvider = {
  embed: async (text: string) => {
    const arr = new Float32Array(32);
    for (let i = 0; i < text.length; i++) {
      arr[text.charCodeAt(i) % arr.length] += 1;
    }
    return arr;
  },
  dimensions: 32,
};

let db: DatabaseSync;
let store: MemoryStore;

beforeEach(() => {
  db = getDbForTesting();
  initializeSchema(db);
  setEmbeddingProvider(mockProvider);
  store = new MemoryStore(db);
});

afterEach(() => {
  resetEmbeddingProvider();
  db.close();
});

describe("concurrency integrity", () => {
  it("deduplicates concurrent identical writes by hash without creating duplicate active rows", async () => {
    setSetting(db, "dedup.hash_enabled", "true");
    setSetting(db, "dedup.skip_insert_on_match", "true");
    setSetting(db, "dedup.enabled", "false");

    const content = "Concurrent hash dedup content baseline token";

    const writes = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        store.create({
          content,
          content_type: "note",
          tags: ["concurrency", "hash-dedup"],
        })
      )
    );

    const fulfilled = writes.filter((w): w is PromiseFulfilledResult<Awaited<ReturnType<MemoryStore["create"]>>> => w.status === "fulfilled");
    const rejected = writes.filter((w): w is PromiseRejectedResult => w.status === "rejected");

    expect(fulfilled.length).toBeGreaterThan(0);
    if (rejected.length > 0) {
      for (const failure of rejected) {
        const message = String((failure.reason as Error)?.message ?? failure.reason);
        expect(message).toContain("UNIQUE constraint failed");
      }
    }

    const uniqueIds = new Set(fulfilled.map((r) => r.value.memory.id));
    expect(uniqueIds.size).toBe(1);

    const activeRows = db
      .prepare("SELECT COUNT(*) as count FROM memories WHERE content = ? AND is_active = 1")
      .get(content) as { count: number };
    expect(activeRows.count).toBe(1);
  });

  it("keeps access_count and access_log consistent under concurrent recordAccess calls", async () => {
    const created = await store.create({
      content: "Access concurrency target",
      content_type: "note",
      tags: ["concurrency", "access"],
    });

    const runs = 50;
    await Promise.all(
      Array.from({ length: runs }, (_, i) =>
        store.recordAccess(created.memory.id, `query-${i}`)
      )
    );

    const memory = await store.getById(created.memory.id);
    expect(memory).not.toBeNull();
    expect(memory!.access_count).toBe(runs);

    const logRows = db
      .prepare("SELECT COUNT(*) as count FROM access_log WHERE memory_id = ?")
      .get(created.memory.id) as { count: number };
    expect(logRows.count).toBe(runs);
  });
});
