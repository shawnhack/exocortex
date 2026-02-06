import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  initializeSchema,
  MemoryStore,
  setEmbeddingProvider,
  resetEmbeddingProvider,
  getPurgeCandidates,
  purgeTrash,
  setSetting,
} from "@exocortex/core";
import type { EmbeddingProvider } from "@exocortex/core";

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

/** Return a datetime string N days in the past */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

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

describe("purgeTrash", () => {
  it("purges memories trashed more than 30 days ago", async () => {
    const { memory } = await store.create({ content: "Old trashed memory" });

    // Soft-delete and backdate updated_at to 31 days ago
    db.prepare("UPDATE memories SET is_active = 0, updated_at = ? WHERE id = ?").run(
      daysAgo(31),
      memory.id
    );

    const result = purgeTrash(db);
    expect(result.purged).toBe(1);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].id).toBe(memory.id);
    expect(result.dry_run).toBe(false);

    // Verify actually deleted
    const row = db.prepare("SELECT id FROM memories WHERE id = ?").get(memory.id);
    expect(row).toBeUndefined();
  });

  it("skips memories trashed less than 30 days ago", async () => {
    const { memory } = await store.create({ content: "Recently trashed" });

    // Soft-delete with updated_at only 10 days ago
    db.prepare("UPDATE memories SET is_active = 0, updated_at = ? WHERE id = ?").run(
      daysAgo(10),
      memory.id
    );

    const result = purgeTrash(db);
    expect(result.purged).toBe(0);
    expect(result.candidates).toHaveLength(0);

    // Still exists
    const row = db.prepare("SELECT id FROM memories WHERE id = ?").get(memory.id);
    expect(row).toBeDefined();
  });

  it("skips memories whose superseded_by target is still active", async () => {
    const { memory: original } = await store.create({ content: "Original version" });
    const { memory: replacement } = await store.create({ content: "Updated version" });

    // Mark original as superseded by the active replacement
    db.prepare(
      "UPDATE memories SET is_active = 0, superseded_by = ?, updated_at = ? WHERE id = ?"
    ).run(replacement.id, daysAgo(31), original.id);

    const candidates = getPurgeCandidates(db);
    expect(candidates).toHaveLength(0);

    const result = purgeTrash(db);
    expect(result.purged).toBe(0);
  });

  it("purges when superseded_by target is also inactive", async () => {
    const { memory: original } = await store.create({ content: "Original" });
    const { memory: replacement } = await store.create({ content: "Replacement" });

    // Both are inactive
    db.prepare(
      "UPDATE memories SET is_active = 0, superseded_by = ?, updated_at = ? WHERE id = ?"
    ).run(replacement.id, daysAgo(31), original.id);
    db.prepare("UPDATE memories SET is_active = 0, updated_at = ? WHERE id = ?").run(
      daysAgo(31),
      replacement.id
    );

    const result = purgeTrash(db);
    expect(result.purged).toBe(2);
  });

  it("dry run returns candidates without deleting", async () => {
    const { memory } = await store.create({ content: "Dry run test" });

    db.prepare("UPDATE memories SET is_active = 0, updated_at = ? WHERE id = ?").run(
      daysAgo(31),
      memory.id
    );

    const result = purgeTrash(db, { dryRun: true });
    expect(result.purged).toBe(0);
    expect(result.candidates).toHaveLength(1);
    expect(result.dry_run).toBe(true);

    // Still exists
    const row = db.prepare("SELECT id FROM memories WHERE id = ?").get(memory.id);
    expect(row).toBeDefined();
  });

  it("respects custom days setting", async () => {
    const { memory } = await store.create({ content: "Custom days test" });

    // Trashed 15 days ago
    db.prepare("UPDATE memories SET is_active = 0, updated_at = ? WHERE id = ?").run(
      daysAgo(15),
      memory.id
    );

    // Default 30 days — should not purge
    expect(purgeTrash(db).purged).toBe(0);

    // Override setting to 10 days — should purge
    setSetting(db, "trash.auto_purge_days", "10");
    const result = purgeTrash(db);
    expect(result.purged).toBe(1);
  });

  it("disables purge when setting is 0", async () => {
    const { memory } = await store.create({ content: "Never purge" });

    db.prepare("UPDATE memories SET is_active = 0, updated_at = ? WHERE id = ?").run(
      daysAgo(365),
      memory.id
    );

    setSetting(db, "trash.auto_purge_days", "0");
    const result = purgeTrash(db);
    expect(result.purged).toBe(0);
    expect(result.candidates).toHaveLength(0);
  });
});
