import { describe, it, expect, beforeEach } from "vitest";
import { getDbForTesting } from "../db/connection.js";
import { initializeSchema, setSetting } from "../db/schema.js";
import { MemorySearch } from "./search.js";
import type { DatabaseSync } from "node:sqlite";

describe("MemorySearch.expandQuery", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getDbForTesting();
    initializeSchema(db);
    // Enable query expansion for tests
    setSetting(db, "search.query_expansion", "true");
  });

  /**
   * Helper: access the private expandQuery via casting.
   */
  function callExpandQuery(
    search: MemorySearch,
    query: string
  ): { expandedText: string; expandedTerms: string[] } | null {
    return (search as any).expandQuery(query);
  }

  describe("n-gram entity matching", () => {
    it("should expand 2-word entity names", () => {
      const now = new Date().toISOString().replace("T", " ").replace("Z", "");
      // Insert a 2-word entity with an alias
      db.prepare(
        "INSERT INTO entities (id, name, type, aliases, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("ent1", "machine learning", "concept", JSON.stringify(["ML"]), "{}", now, now);

      const search = new MemorySearch(db);
      const result = callExpandQuery(search, "about machine learning systems");

      expect(result).not.toBeNull();
      expect(result!.expandedTerms).toContain("ML");
    });

    it("should expand 3-word entity names", () => {
      const now = new Date().toISOString().replace("T", " ").replace("Z", "");
      db.prepare(
        "INSERT INTO entities (id, name, type, aliases, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("ent2", "natural language processing", "concept", JSON.stringify(["NLP"]), "{}", now, now);

      const search = new MemorySearch(db);
      const result = callExpandQuery(search, "natural language processing techniques");

      expect(result).not.toBeNull();
      expect(result!.expandedTerms).toContain("NLP");
    });
  });

  describe("bidirectional tag aliases", () => {
    it("should expand alias to canonical form", () => {
      // Default alias map includes: nextjs -> next.js
      setSetting(
        db,
        "tags.alias_map",
        JSON.stringify({ js: "javascript", ts: "typescript" })
      );

      const search = new MemorySearch(db);
      const result = callExpandQuery(search, "writing better javascript code");

      expect(result).not.toBeNull();
      // "javascript" is a canonical form, so aliases (js) should be added
      expect(result!.expandedTerms).toContain("js");
    });

    it("should expand canonical form to aliases", () => {
      setSetting(
        db,
        "tags.alias_map",
        JSON.stringify({ nextjs: "next.js", "next-js": "next.js" })
      );

      const search = new MemorySearch(db);
      const result = callExpandQuery(search, "deploying nextjs application");

      expect(result).not.toBeNull();
      // "nextjs" is an alias key -> should add canonical "next.js"
      expect(result!.expandedTerms).toContain("next.js");
    });
  });

  describe("expansion term cap", () => {
    it("should cap total expansion terms at configured max", () => {
      setSetting(db, "search.expansion_max_terms", "3");
      const now = new Date().toISOString().replace("T", " ").replace("Z", "");

      // Create entity with many aliases to force many expansion terms
      db.prepare(
        "INSERT INTO entities (id, name, type, aliases, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(
        "ent3",
        "react",
        "technology",
        JSON.stringify(["ReactJS", "React.js", "react-dom", "preact", "react-native"]),
        "{}",
        now,
        now
      );

      const search = new MemorySearch(db);
      const result = callExpandQuery(search, "using react for development");

      expect(result).not.toBeNull();
      expect(result!.expandedTerms.length).toBeLessThanOrEqual(3);
    });
  });

  describe("respects enabled setting", () => {
    it("should return null when query expansion is disabled", () => {
      setSetting(db, "search.query_expansion", "false");

      const search = new MemorySearch(db);
      const result = callExpandQuery(search, "some query text");

      expect(result).toBeNull();
    });

    it("should return expansion when enabled", () => {
      const now = new Date().toISOString().replace("T", " ").replace("Z", "");
      db.prepare(
        "INSERT INTO entities (id, name, type, aliases, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("ent4", "python", "technology", JSON.stringify(["py", "cpython"]), "{}", now, now);

      const search = new MemorySearch(db);
      const result = callExpandQuery(search, "learning python basics");

      expect(result).not.toBeNull();
      expect(result!.expandedTerms.length).toBeGreaterThan(0);
    });
  });
});
