import { describe, it, expect, beforeEach } from "vitest";
import { getDbForTesting } from "../db/connection.js";
import { initializeSchema } from "../db/schema.js";
import { MemoryLinkStore } from "./links.js";
import type { DatabaseSync } from "node:sqlite";

const now = () => new Date().toISOString().replace("T", " ").replace("Z", "");

function insertMemory(db: DatabaseSync, id: string, content: string) {
  const ts = now();
  db.prepare(
    `INSERT INTO memories (id, content, content_type, source, importance, is_active, created_at, updated_at)
     VALUES (?, ?, 'text', 'api', 0.5, 1, ?, ?)`
  ).run(id, content, ts, ts);
}

describe("MemoryLinkStore", () => {
  let db: DatabaseSync;
  let store: MemoryLinkStore;

  beforeEach(() => {
    db = getDbForTesting();
    initializeSchema(db);
    store = new MemoryLinkStore(db);
    insertMemory(db, "mem-a", "Memory A");
    insertMemory(db, "mem-b", "Memory B");
    insertMemory(db, "mem-c", "Memory C");
    insertMemory(db, "mem-d", "Memory D");
  });

  describe("link", () => {
    it("should create a link between two memories", () => {
      store.link("mem-a", "mem-b", "related", 0.7);
      const links = store.getLinks("mem-a");
      expect(links).toHaveLength(1);
      expect(links[0].source_id).toBe("mem-a");
      expect(links[0].target_id).toBe("mem-b");
      expect(links[0].link_type).toBe("related");
      expect(links[0].strength).toBe(0.7);
    });

    it("should upsert on conflict (update strength and type)", () => {
      store.link("mem-a", "mem-b", "related", 0.5);
      store.link("mem-a", "mem-b", "supersedes", 0.9);
      const links = store.getLinks("mem-a");
      expect(links).toHaveLength(1);
      expect(links[0].link_type).toBe("supersedes");
      expect(links[0].strength).toBe(0.9);
    });

    it("should use defaults for type and strength", () => {
      store.link("mem-a", "mem-b");
      const links = store.getLinks("mem-a");
      expect(links[0].link_type).toBe("related");
      expect(links[0].strength).toBe(0.5);
    });
  });

  describe("unlink", () => {
    it("should remove a link and return true", () => {
      store.link("mem-a", "mem-b");
      const removed = store.unlink("mem-a", "mem-b");
      expect(removed).toBe(true);
      expect(store.getLinks("mem-a")).toHaveLength(0);
    });

    it("should return false when no link exists", () => {
      expect(store.unlink("mem-a", "mem-b")).toBe(false);
    });
  });

  describe("getLinks", () => {
    it("should return both outgoing and incoming links", () => {
      store.link("mem-a", "mem-b", "related", 0.8);
      store.link("mem-c", "mem-a", "supports", 0.6);

      const links = store.getLinks("mem-a");
      expect(links).toHaveLength(2);
    });

    it("should sort by strength descending", () => {
      store.link("mem-a", "mem-b", "related", 0.3);
      store.link("mem-c", "mem-a", "supports", 0.9);

      const links = store.getLinks("mem-a");
      expect(links[0].strength).toBe(0.9);
      expect(links[1].strength).toBe(0.3);
    });

    it("should return empty array when no links exist", () => {
      expect(store.getLinks("mem-a")).toEqual([]);
    });
  });

  describe("getLinkedIds", () => {
    it("should return empty array for empty input", () => {
      expect(store.getLinkedIds([])).toEqual([]);
    });

    it("should return linked IDs excluding seed set", () => {
      store.link("mem-a", "mem-b");
      store.link("mem-a", "mem-c");

      const ids = store.getLinkedIds(["mem-a"]);
      expect(ids).toContain("mem-b");
      expect(ids).toContain("mem-c");
      expect(ids).not.toContain("mem-a");
    });

    it("should include reverse-direction links", () => {
      store.link("mem-b", "mem-a");
      const ids = store.getLinkedIds(["mem-a"]);
      expect(ids).toContain("mem-b");
    });

    it("should deduplicate across directions", () => {
      store.link("mem-a", "mem-b");
      store.link("mem-b", "mem-a");
      const ids = store.getLinkedIds(["mem-a"]);
      expect(ids).toEqual(["mem-b"]);
    });

    it("should return 1-hop only (not transitive)", () => {
      store.link("mem-a", "mem-b");
      store.link("mem-b", "mem-c");

      const ids = store.getLinkedIds(["mem-a"]);
      expect(ids).toContain("mem-b");
      expect(ids).not.toContain("mem-c");
    });
  });

  describe("getLinkedRefs", () => {
    it("should return empty array for empty input", () => {
      expect(store.getLinkedRefs([])).toEqual([]);
    });

    it("should return linked refs with provenance", () => {
      store.link("mem-a", "mem-b", "elaborates", 0.8);
      const refs = store.getLinkedRefs(["mem-a"]);
      expect(refs).toHaveLength(1);
      expect(refs[0].id).toBe("mem-b");
      expect(refs[0].linked_from).toBe("mem-a");
      expect(refs[0].link_type).toBe("elaborates");
      expect(refs[0].strength).toBe(0.8);
    });

    it("should include reverse links", () => {
      store.link("mem-b", "mem-a", "supports", 0.6);
      const refs = store.getLinkedRefs(["mem-a"]);
      expect(refs).toHaveLength(1);
      expect(refs[0].id).toBe("mem-b");
    });

    it("should exclude seed IDs from results", () => {
      store.link("mem-a", "mem-b");
      store.link("mem-b", "mem-a");
      const refs = store.getLinkedRefs(["mem-a", "mem-b"]);
      expect(refs).toHaveLength(0);
    });

    it("should deduplicate keeping highest strength", () => {
      // A→B with strength 0.3, B→A's reverse shows B with linked_from A
      // C→B with strength 0.9, queried from seed [A,C] — B appears from both
      store.link("mem-a", "mem-b", "related", 0.3);
      store.link("mem-c", "mem-b", "supports", 0.9);

      const refs = store.getLinkedRefs(["mem-a", "mem-c"]);
      // mem-b should appear once with highest strength
      const bRefs = refs.filter((r) => r.id === "mem-b");
      expect(bRefs).toHaveLength(1);
      expect(bRefs[0].strength).toBe(0.9);
    });

    it("should sort results by strength descending", () => {
      store.link("mem-a", "mem-b", "related", 0.3);
      store.link("mem-a", "mem-c", "elaborates", 0.8);
      store.link("mem-a", "mem-d", "supports", 0.5);

      const refs = store.getLinkedRefs(["mem-a"]);
      expect(refs[0].strength).toBe(0.8);
      expect(refs[1].strength).toBe(0.5);
      expect(refs[2].strength).toBe(0.3);
    });
  });
});
