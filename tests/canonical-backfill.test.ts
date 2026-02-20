import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  initializeSchema,
  backfillMemoryCanonicalization,
} from "@exocortex/core";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  initializeSchema(db);
});

afterEach(() => {
  db.close();
});

describe("backfillMemoryCanonicalization", () => {
  it("recomputes content hash, normalizes tags, and backfills metadata flag", () => {
    const now = new Date().toISOString().replace("T", " ").replace("Z", "");
    db.prepare(
      `INSERT INTO memories
         (id, content, content_hash, is_indexed, is_metadata, metadata, created_at, updated_at)
       VALUES (?, ?, ?, 1, 0, ?, ?, ?)`
    ).run(
      "LEGACY_1",
      "Legacy Next.js benchmark content",
      "legacy-hash",
      JSON.stringify({ mode: "benchmark" }),
      now,
      now
    );
    db.prepare("INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)")
      .run("LEGACY_1", "nextjs");

    const result = backfillMemoryCanonicalization(db, { dryRun: false });
    expect(result.scanned).toBeGreaterThan(0);
    expect(result.hashesUpdated).toBeGreaterThan(0);
    expect(result.tagsUpdated).toBeGreaterThan(0);
    expect(result.metadataFlagUpdated).toBeGreaterThan(0);

    const row = db
      .prepare("SELECT content_hash, is_metadata FROM memories WHERE id = ?")
      .get("LEGACY_1") as { content_hash: string; is_metadata: number };
    const expectedHash = createHash("sha256")
      .update("legacy next.js benchmark content")
      .digest("hex");
    expect(row.content_hash).toBe(expectedHash);
    expect(row.is_metadata).toBe(1);

    const tags = db
      .prepare("SELECT tag FROM memory_tags WHERE memory_id = ?")
      .all("LEGACY_1") as Array<{ tag: string }>;
    expect(tags.map((t) => t.tag)).toEqual(["next.js"]);
  });
});

