import { describe, it, expect, beforeEach } from "vitest";
import { getDbForTesting } from "../db/connection.js";
import { initializeSchema, setSetting } from "../db/schema.js";
import { MemorySearch } from "./search.js";
import type { DatabaseSync } from "node:sqlite";

describe("MemorySearch expanded_query", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getDbForTesting();
    initializeSchema(db);
    setSetting(db, "search.query_expansion", "true");
  });

  it("should use expanded_query for entity expansion input", () => {
    const now = new Date().toISOString().replace("T", " ").replace("Z", "");
    db.prepare(
      "INSERT INTO entities (id, name, type, aliases, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("ent-auth", "authentication", "concept", JSON.stringify(["auth", "authn"]), "{}", now, now);

    const search = new MemorySearch(db);
    // expanded_query includes "authentication" which matches the entity
    const expansion = (search as any).expandQuery("auth flow authentication login");
    expect(expansion).not.toBeNull();
    expect(expansion!.expandedTerms).toContain("authn");
  });

  it("should work without expanded_query (baseline)", () => {
    const search = new MemorySearch(db);
    // No entity matches for "auth" alone — no expansion
    const expansion = (search as any).expandQuery("auth flow");
    expect(expansion).toBeNull();
  });
});

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

describe("MemorySearch supersession demotion", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getDbForTesting();
    initializeSchema(db);
  });

  it("should demote memories that have superseded_by set", async () => {
    const now = new Date().toISOString().replace("T", " ").replace("Z", "");
    // Insert memories about the same topic — one superseded by the other
    // They need different content so FTS BM25 normalization doesn't collapse both to 0
    // is_indexed = 1 is required for the FTS trigger to fire
    db.prepare(
      `INSERT INTO memories (id, content, content_type, source, importance, is_active, is_indexed, superseded_by, created_at, updated_at)
       VALUES (?, ?, 'text', 'api', 0.8, 1, 1, ?, ?, ?)`
    ).run("mem-old", "Decision: use n8n for video pipeline orchestration and processing", "mem-new", now, now);

    db.prepare(
      `INSERT INTO memories (id, content, content_type, source, importance, is_active, is_indexed, superseded_by, created_at, updated_at)
       VALUES (?, ?, 'text', 'api', 0.8, 1, 1, NULL, ?, ?)`
    ).run("mem-new", "Decision: use TypeScript for video pipeline orchestration and processing", now, now);

    // Add a third memory that partially matches (only "pipeline") to give BM25 range
    db.prepare(
      `INSERT INTO memories (id, content, content_type, source, importance, is_active, is_indexed, created_at, updated_at)
       VALUES (?, ?, 'text', 'api', 0.3, 1, 1, ?, ?)`
    ).run("mem-partial", "The data pipeline runs batch jobs every night for ETL processing", now, now);

    // Verify FTS index has entries
    const ftsCount = db.prepare("SELECT COUNT(*) as c FROM memories_fts").get() as { c: number };
    expect(ftsCount.c).toBeGreaterThan(0);

    // Use legacy scoring (non-RRF) so FTS-only results produce non-zero scores
    setSetting(db, "scoring.use_rrf", "false");

    // Disable quality floor and score gap so demoted results still appear
    setSetting(db, "search.quality_floor", "0");
    setSetting(db, "search.score_gap_ratio", "0");

    const search = new MemorySearch(db);
    const results = await search.search({ query: "video pipeline orchestration", min_score: 0 });

    const oldResult = results.find((r) => r.memory.id === "mem-old");
    const newResult = results.find((r) => r.memory.id === "mem-new");

    expect(newResult).toBeDefined();
    expect(oldResult).toBeDefined();
    // Both should have non-zero FTS scores
    expect(newResult!.fts_score).toBeGreaterThan(0);
    // Superseded memory should be demoted to ~20% of the non-superseded one's score
    expect(newResult!.score).toBeGreaterThan(oldResult!.score);
    expect(oldResult!.score).toBeLessThan(newResult!.score * 0.5);
  });
});
