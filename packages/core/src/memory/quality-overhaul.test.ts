import { describe, it, expect, beforeEach } from "vitest";
import { getDbForTesting } from "../db/connection.js";
import { initializeSchema, getSetting, setSetting } from "../db/schema.js";
import { MemoryStore, validateStorageGate } from "./store.js";
import { MemoryLinkStore } from "./links.js";
import { generateBasicSummary, validateSummary } from "../intelligence/consolidation.js";
import type { DatabaseSync } from "node:sqlite";

let db: DatabaseSync;
let store: MemoryStore;

beforeEach(() => {
  db = getDbForTesting();
  initializeSchema(db);
  store = new MemoryStore(db);
});

describe("Storage Gate (validateStorageGate)", () => {
  it("rejects content shorter than 120 characters", () => {
    expect(() => validateStorageGate("Too short")).toThrow(
      "Memory content too short"
    );
  });

  it("accepts content at exactly 120 characters", () => {
    expect(() => validateStorageGate("A".repeat(120))).not.toThrow();
  });

  it("allows short conversation messages", () => {
    expect(() =>
      validateStorageGate("Hello!", { content_type: "conversation" })
    ).not.toThrow();
  });

  it("allows short chunks with parent_id", () => {
    expect(() =>
      validateStorageGate("Short chunk", { parent_id: "parent-1" })
    ).not.toThrow();
  });

  it("allows short metadata content", () => {
    expect(() =>
      validateStorageGate("Short", { is_metadata: true })
    ).not.toThrow();
  });

  it("allows short benchmark content", () => {
    expect(() =>
      validateStorageGate("Short", { benchmark: true })
    ).not.toThrow();
  });

  it("allows short goal-progress content", () => {
    expect(() =>
      validateStorageGate("Done!", { tags: ["goal-progress"] })
    ).not.toThrow();
  });
});

describe("Read-Triggered Reinforcement", () => {
  it("bumps importance on access", async () => {
    const result = await store.create({
      content: "A".repeat(100),
      content_type: "text",
      source: "api",
      importance: 0.5,
    });

    const id = result.memory.id;
    await store.recordAccess(id, "test query");

    const row = db
      .prepare("SELECT importance FROM memories WHERE id = ?")
      .get(id) as { importance: number };
    expect(row.importance).toBeCloseTo(0.51, 2);
  });

  it("caps importance at 0.95", async () => {
    const result = await store.create({
      content: "A".repeat(100),
      content_type: "text",
      source: "api",
      importance: 0.94,
    });

    const id = result.memory.id;
    await store.recordAccess(id, "test");

    const row = db
      .prepare("SELECT importance FROM memories WHERE id = ?")
      .get(id) as { importance: number };
    expect(row.importance).toBeLessThanOrEqual(0.95);
  });

  it("does not bump importance above 0.9 threshold", async () => {
    const result = await store.create({
      content: "A".repeat(100),
      content_type: "text",
      source: "api",
      importance: 0.91,
    });

    const id = result.memory.id;
    await store.recordAccess(id, "test");

    const row = db
      .prepare("SELECT importance FROM memories WHERE id = ?")
      .get(id) as { importance: number };
    // Should stay at 0.91 (guard: importance < 0.9)
    expect(row.importance).toBeCloseTo(0.91, 2);
  });

  it("reinforces linked memories at lower rate", async () => {
    const a = await store.create({
      content: "A".repeat(100),
      content_type: "text",
      source: "api",
      importance: 0.5,
    });
    const b = await store.create({
      content: "B".repeat(100),
      content_type: "text",
      source: "api",
      importance: 0.5,
    });

    const linkStore = new MemoryLinkStore(db);
    linkStore.link(a.memory.id, b.memory.id, "related", 0.8);

    await store.recordAccess(a.memory.id, "test");

    const bRow = db
      .prepare("SELECT importance FROM memories WHERE id = ?")
      .get(b.memory.id) as { importance: number };
    expect(bRow.importance).toBeCloseTo(0.505, 3);
  });

  it("respects configurable boost values", async () => {
    setSetting(db, "reinforcement.access_boost", "0.05");

    const result = await store.create({
      content: "A".repeat(100),
      content_type: "text",
      source: "api",
      importance: 0.5,
    });

    await store.recordAccess(result.memory.id, "test");

    const row = db
      .prepare("SELECT importance FROM memories WHERE id = ?")
      .get(result.memory.id) as { importance: number };
    expect(row.importance).toBeCloseTo(0.55, 2);
  });
});

describe("Default settings", () => {
  it("has default settings for reinforcement", () => {
    expect(getSetting(db, "reinforcement.access_boost")).toBe("0.01");
    expect(getSetting(db, "reinforcement.link_boost")).toBe("0.005");
  });

  it("has default settings for confidence gap filter", () => {
    expect(getSetting(db, "search.score_gap_ratio")).toBe("0.15");
    expect(getSetting(db, "search.quality_floor")).toBe("0.08");
  });
});

describe("generateBasicSummary", () => {
  it("includes topic sentence with date range and tags", async () => {
    const m1 = await store.create({
      content: "The Exocortex system uses SQLite for storage and provides an MCP server interface for memory operations.",
      content_type: "text",
      source: "api",
      tags: ["architecture", "exocortex"],
    });
    const m2 = await store.create({
      content: "The Cortex gateway handles agent scheduling and WebSocket connections for the platform.",
      content_type: "text",
      source: "api",
      tags: ["architecture", "cortex"],
    });

    const summary = generateBasicSummary(db, [m1.memory.id, m2.memory.id]);
    expect(summary).toContain("2 sources");
    expect(summary).toContain("architecture");
  });

  it("preserves file paths and version numbers in specifics", async () => {
    const m1 = await store.create({
      content: "The config file lives at /home/user/project/config.json and uses version v2.1.0 of the schema format.",
      content_type: "text",
      source: "api",
    });
    const m2 = await store.create({
      content: "The gateway code is in /home/user/project/src/gateway.ts and calls the loadPromptAmendments function.",
      content_type: "text",
      source: "api",
    });

    const summary = generateBasicSummary(db, [m1.memory.id, m2.memory.id]);
    expect(summary).toContain("/home/user/project/config.json");
    expect(summary).toContain("v2.1.0");
    expect(summary).toContain("loadPromptAmendments");
  });

  it("respects word budget", async () => {
    // Create memories with lots of content
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const longContent = `Memory ${i}: ` + "This is a detailed technical note about the system. ".repeat(30);
      const result = await store.create({
        content: longContent,
        content_type: "text",
        source: "api",
      });
      ids.push(result.memory.id);
    }

    const summary = generateBasicSummary(db, ids);
    const wordCount = summary.split(/\s+/).length;
    // Should be roughly within budget (500 words + some slack for section headers)
    expect(wordCount).toBeLessThan(600);
  });
});

describe("validateSummary", () => {
  it("passes a good summary that preserves proper nouns", () => {
    const sources = [
      "The Exocortex system was designed by Alice for the Cortex platform.",
      "Bob reviewed the Sentinel scheduler and approved the changes.",
    ];
    const summary =
      "Consolidated: The Exocortex system was designed by Alice. Bob reviewed the Sentinel scheduler for the Cortex platform.";

    const result = validateSummary(summary, sources);
    expect(result.valid).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  it("rejects summaries that are too short", () => {
    const result = validateSummary("Too short.", ["A long source document with many details."]);
    expect(result.valid).toBe(false);
    expect(result.reasons[0]).toContain("too short");
  });

  it("rejects summaries that lose proper nouns", () => {
    const sources = [
      "Alice and Bob worked on the Exocortex project.",
      "Charlie reviewed the Sentinel and Cortex components.",
    ];
    // Summary drops most proper nouns
    const summary =
      "A team worked on the project components and reviewed the system architecture. The review was completed successfully and changes were approved.";

    const result = validateSummary(summary, sources);
    expect(result.valid).toBe(false);
    expect(result.reasons.some((r) => r.includes("proper nouns preserved"))).toBe(true);
  });

  it("passes when sources have no proper nouns", () => {
    const sources = [
      "the system uses a database for storage and retrieval operations.",
      "the scheduler runs jobs on a configurable cron schedule.",
    ];
    const summary =
      "The system uses a database for storage. The scheduler runs jobs on a cron schedule for automated operations.";

    const result = validateSummary(summary, sources);
    expect(result.valid).toBe(true);
  });
});
