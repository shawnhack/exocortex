import { describe, it, expect } from "vitest";
import { extractRelationships, extractEntities } from "./extractor.js";
import type { ExtractedEntity } from "./extractor.js";

describe("extractRelationships", () => {
  const entities: ExtractedEntity[] = [
    { name: "Exocortex", type: "project", confidence: 0.9 },
    { name: "SQLite", type: "technology", confidence: 0.9 },
    { name: "React", type: "technology", confidence: 0.9 },
    { name: "Alice", type: "person", confidence: 0.75 },
    { name: "Anthropic", type: "organization", confidence: 0.85 },
  ];

  it("extracts 'uses' relationships", () => {
    const text = "Exocortex uses SQLite for storage.";
    const rels = extractRelationships(text, entities);
    expect(rels).toHaveLength(1);
    expect(rels[0].source).toBe("Exocortex");
    expect(rels[0].target).toBe("SQLite");
    expect(rels[0].relationship).toBe("uses");
  });

  it("extracts 'built with' relationships", () => {
    const text = "Exocortex built with React for the dashboard.";
    const rels = extractRelationships(text, entities);
    expect(rels.some((r) => r.relationship === "uses" && r.target === "React")).toBe(true);
  });

  it("extracts 'works_at' relationships", () => {
    const text = "Alice works at Anthropic on AI tools.";
    const rels = extractRelationships(text, entities);
    expect(rels.some((r) => r.relationship === "works_at" && r.source === "Alice" && r.target === "Anthropic")).toBe(true);
  });

  it("extracts 'created' relationships", () => {
    const text = "Alice created Exocortex as a memory system.";
    const rels = extractRelationships(text, entities);
    expect(rels.some((r) => r.relationship === "created" && r.source === "Alice" && r.target === "Exocortex")).toBe(true);
  });

  it("extracts 'replaces' relationships", () => {
    const text = "React replaces the old dashboard in Exocortex.";
    // "React replaces ..." — target needs to be a known entity
    // This won't match since "old dashboard" isn't an entity
    // But let's test with known entities
    const text2 = "SQLite replaces React as data layer.";
    const rels = extractRelationships(text2, entities);
    expect(rels.some((r) => r.relationship === "replaces")).toBe(true);
  });

  it("returns empty array for fewer than 2 entities", () => {
    const text = "SQLite is a database.";
    const rels = extractRelationships(text, [entities[1]]);
    expect(rels).toHaveLength(0);
  });

  it("deduplicates same relationships", () => {
    const text = "Exocortex uses SQLite. The Exocortex project uses SQLite for data.";
    const rels = extractRelationships(text, entities);
    const sqliteUses = rels.filter(
      (r) => r.source === "Exocortex" && r.target === "SQLite" && r.relationship === "uses"
    );
    expect(sqliteUses).toHaveLength(1);
  });

  it("does not create self-relationships", () => {
    const text = "SQLite uses SQLite internally.";
    const rels = extractRelationships(text, entities);
    const selfRels = rels.filter((r) => r.source === r.target);
    expect(selfRels).toHaveLength(0);
  });

  it("only creates relationships between known entities", () => {
    const text = "UnknownTool uses SQLite for storage.";
    const rels = extractRelationships(text, entities);
    // "UnknownTool" is not in entities, so no relationship should be created
    expect(rels.filter((r) => r.source === "UnknownTool")).toHaveLength(0);
  });
});
