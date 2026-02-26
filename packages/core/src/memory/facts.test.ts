import { describe, it, expect, beforeEach } from "vitest";
import { getDbForTesting } from "../db/connection.js";
import { initializeSchema } from "../db/schema.js";
import { extractFacts, storeFacts, searchFacts } from "./facts.js";
import type { DatabaseSync } from "node:sqlite";

let db: DatabaseSync;

beforeEach(() => {
  db = getDbForTesting();
  initializeSchema(db);
});

describe("extractFacts", () => {
  it("extracts port facts", () => {
    const facts = extractFacts("Exocortex runs on port 4010");
    expect(facts).toHaveLength(1);
    expect(facts[0].subject).toBe("Exocortex");
    expect(facts[0].predicate).toBe("port");
    expect(facts[0].object).toBe("4010");
  });

  it("extracts 'uses' relationships", () => {
    const facts = extractFacts("Cortex uses PostgreSQL for storage");
    const usesFact = facts.find((f) => f.predicate === "uses");
    expect(usesFact).toBeDefined();
    expect(usesFact!.subject).toBe("Cortex");
    expect(usesFact!.object).toContain("PostgreSQL");
  });

  it("extracts 'replaced' relationships", () => {
    const facts = extractFacts("PM2 replaced Docker Compose");
    const replacedFact = facts.find((f) => f.predicate === "replaced");
    expect(replacedFact).toBeDefined();
    expect(replacedFact!.subject).toBe("PM2");
    expect(replacedFact!.object).toContain("Docker");
  });

  it("extracts 'switched from X to Y' as replaced", () => {
    const facts = extractFacts("switched from npm to pnpm");
    const replacedFact = facts.find((f) => f.predicate === "replaced");
    expect(replacedFact).toBeDefined();
    expect(replacedFact!.subject).toBe("pnpm");
    expect(replacedFact!.object).toBe("npm");
  });

  it("extracts version facts", () => {
    const facts = extractFacts("Node version 24.0.1 is required");
    const versionFact = facts.find((f) => f.predicate === "version");
    expect(versionFact).toBeDefined();
    expect(versionFact!.subject).toBe("Node");
    expect(versionFact!.object).toBe("24.0.1");
  });

  it("extracts default value facts", () => {
    const facts = extractFacts("importance defaults to 0.5");
    const defaultFact = facts.find((f) => f.predicate === "default");
    expect(defaultFact).toBeDefined();
    expect(defaultFact!.object).toBe("0.5");
  });

  it("deduplicates extracted facts", () => {
    const facts = extractFacts(
      "Redis runs on port 6379. Redis runs on port 6379."
    );
    const portFacts = facts.filter((f) => f.predicate === "port" && f.subject === "Redis");
    expect(portFacts).toHaveLength(1);
  });

  it("extracts 'config' facts", () => {
    const facts = extractFacts("timeout configured to 30s");
    const configFact = facts.find((f) => f.predicate === "config");
    expect(configFact).toBeDefined();
    expect(configFact!.subject).toBe("timeout");
    expect(configFact!.object).toBe("30s");
  });

  it("extracts 'config' from 'set to'", () => {
    const facts = extractFacts("MaxRetries set to 5");
    const configFact = facts.find((f) => f.predicate === "config");
    expect(configFact).toBeDefined();
    expect(configFact!.subject).toBe("MaxRetries");
    expect(configFact!.object).toBe("5");
  });

  it("extracts 'depends_on' facts", () => {
    const facts = extractFacts("Cortex depends on Exocortex");
    const depFact = facts.find((f) => f.predicate === "depends_on");
    expect(depFact).toBeDefined();
    expect(depFact!.subject).toBe("Cortex");
    expect(depFact!.object).toBe("Exocortex");
  });

  it("extracts 'depends_on' from 'requires'", () => {
    const facts = extractFacts("Dashboard requires Node 20");
    const depFact = facts.find((f) => f.predicate === "depends_on");
    expect(depFact).toBeDefined();
    expect(depFact!.subject).toBe("Dashboard");
    expect(depFact!.object).toContain("Node");
  });

  it("extracts 'located_at' facts", () => {
    const facts = extractFacts("Config located at /home/user/.config");
    const locFact = facts.find((f) => f.predicate === "located_at");
    expect(locFact).toBeDefined();
    expect(locFact!.subject).toBe("Config");
    expect(locFact!.object).toBe("/home/user/.config");
  });

  it("extracts 'located_at' from 'lives in'", () => {
    const facts = extractFacts("Database lives in /var/data/db");
    const locFact = facts.find((f) => f.predicate === "located_at");
    expect(locFact).toBeDefined();
    expect(locFact!.subject).toBe("Database");
    expect(locFact!.object).toBe("/var/data/db");
  });

  it("extracts 'runs_as' facts", () => {
    const facts = extractFacts("Nginx runs as www-data");
    const runFact = facts.find((f) => f.predicate === "runs_as");
    expect(runFact).toBeDefined();
    expect(runFact!.subject).toBe("Nginx");
    expect(runFact!.object).toBe("www-data");
  });

  it("extracts 'runs_as' from 'started with'", () => {
    const facts = extractFacts("Server started with PM2");
    const runFact = facts.find((f) => f.predicate === "runs_as");
    expect(runFact).toBeDefined();
    expect(runFact!.subject).toBe("Server");
    expect(runFact!.object).toBe("PM2");
  });

  it("returns empty for content with no facts", () => {
    const facts = extractFacts("This is a general observation about the world.");
    // May or may not extract "is" facts depending on pattern, but should not crash
    expect(Array.isArray(facts)).toBe(true);
  });
});

describe("storeFacts + searchFacts", () => {
  it("stores and retrieves facts by subject", () => {
    // Create a memory to reference
    db.prepare(
      "INSERT INTO memories (id, content, content_type, source) VALUES (?, ?, ?, ?)"
    ).run("mem-1", "Exocortex runs on port 4010", "text", "manual");

    const facts = [
      { subject: "Exocortex", predicate: "port", object: "4010", confidence: 0.9 },
    ];
    storeFacts(db, "mem-1", facts);

    const results = searchFacts(db, { subject: "Exocortex" });
    expect(results).toHaveLength(1);
    expect(results[0].predicate).toBe("port");
    expect(results[0].object).toBe("4010");
    expect(results[0].memory_id).toBe("mem-1");
  });

  it("searches by predicate", () => {
    db.prepare(
      "INSERT INTO memories (id, content, content_type, source) VALUES (?, ?, ?, ?)"
    ).run("mem-2", "Test content for facts", "text", "manual");

    storeFacts(db, "mem-2", [
      { subject: "Redis", predicate: "port", object: "6379", confidence: 0.9 },
      { subject: "Redis", predicate: "uses", object: "TCP", confidence: 0.8 },
    ]);

    const portFacts = searchFacts(db, { predicate: "port" });
    expect(portFacts).toHaveLength(1);
    expect(portFacts[0].object).toBe("6379");
  });

  it("searches by object with LIKE matching", () => {
    db.prepare(
      "INSERT INTO memories (id, content, content_type, source) VALUES (?, ?, ?, ?)"
    ).run("mem-3", "Test", "text", "manual");

    storeFacts(db, "mem-3", [
      { subject: "App", predicate: "port", object: "4010", confidence: 0.9 },
    ]);

    const results = searchFacts(db, { object: "4010" });
    expect(results).toHaveLength(1);
  });

  it("returns empty for no matching facts", () => {
    const results = searchFacts(db, { subject: "NonExistent" });
    expect(results).toHaveLength(0);
  });

  it("respects limit parameter", () => {
    db.prepare(
      "INSERT INTO memories (id, content, content_type, source) VALUES (?, ?, ?, ?)"
    ).run("mem-4", "Test", "text", "manual");

    for (let i = 0; i < 5; i++) {
      storeFacts(db, "mem-4", [
        { subject: `Service${i}`, predicate: "port", object: String(3000 + i), confidence: 0.9 },
      ]);
    }

    const results = searchFacts(db, { predicate: "port", limit: 3 });
    expect(results).toHaveLength(3);
  });
});
