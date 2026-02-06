import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initializeSchema, EntityStore, MemoryStore, setEmbeddingProvider, resetEmbeddingProvider } from "@exocortex/core";
import type { EmbeddingProvider } from "@exocortex/core";

class MockEmbeddingProvider implements EmbeddingProvider {
  embed(text: string): Promise<Float32Array> {
    const arr = new Float32Array(8);
    for (let i = 0; i < text.length; i++) arr[i % 8] += text.charCodeAt(i) / 1000;
    let norm = 0;
    for (let i = 0; i < arr.length; i++) norm += arr[i] * arr[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < arr.length; i++) arr[i] /= norm;
    return Promise.resolve(arr);
  }
  embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
  dimensions(): number { return 8; }
}

let db: DatabaseSync;
let store: EntityStore;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  initializeSchema(db);
  store = new EntityStore(db);
  setEmbeddingProvider(new MockEmbeddingProvider());
  return () => resetEmbeddingProvider();
});

describe("EntityStore", () => {
  describe("create", () => {
    it("creates an entity with defaults", () => {
      const entity = store.create({ name: "React" });
      expect(entity.name).toBe("React");
      expect(entity.type).toBe("concept");
      expect(entity.aliases).toEqual([]);
      expect(entity.metadata).toEqual({});
      expect(entity.id).toBeTruthy();
    });

    it("creates an entity with all fields", () => {
      const entity = store.create({
        name: "TypeScript",
        type: "technology",
        aliases: ["TS"],
        metadata: { website: "typescriptlang.org" },
      });
      expect(entity.type).toBe("technology");
      expect(entity.aliases).toEqual(["TS"]);
      expect(entity.metadata).toEqual({ website: "typescriptlang.org" });
    });
  });

  describe("getById", () => {
    it("returns the entity by ID", () => {
      const created = store.create({ name: "Node.js" });
      const found = store.getById(created.id);
      expect(found).not.toBeNull();
      expect(found!.name).toBe("Node.js");
    });

    it("returns null for missing ID", () => {
      expect(store.getById("nonexistent")).toBeNull();
    });
  });

  describe("getByName", () => {
    it("finds entity by name (case-insensitive)", () => {
      store.create({ name: "PostgreSQL", type: "technology" });
      const found = store.getByName("postgresql");
      expect(found).not.toBeNull();
      expect(found!.name).toBe("PostgreSQL");
    });

    it("returns null for unknown name", () => {
      expect(store.getByName("Unknown")).toBeNull();
    });
  });

  describe("list", () => {
    it("lists all entities sorted by name", () => {
      store.create({ name: "Zod" });
      store.create({ name: "Axios" });
      store.create({ name: "Hono" });
      const all = store.list();
      expect(all.map((e) => e.name)).toEqual(["Axios", "Hono", "Zod"]);
    });

    it("filters by type", () => {
      store.create({ name: "Alice", type: "person" });
      store.create({ name: "React", type: "technology" });
      store.create({ name: "Bob", type: "person" });
      const people = store.list("person");
      expect(people).toHaveLength(2);
      expect(people.every((e) => e.type === "person")).toBe(true);
    });

    it("returns empty array when no entities exist", () => {
      expect(store.list()).toEqual([]);
    });
  });

  describe("update", () => {
    it("updates name and type", () => {
      const entity = store.create({ name: "JS", type: "technology" });
      const updated = store.update(entity.id, { name: "JavaScript" });
      expect(updated!.name).toBe("JavaScript");
      expect(updated!.type).toBe("technology");
    });

    it("updates aliases and metadata", () => {
      const entity = store.create({ name: "React" });
      const updated = store.update(entity.id, {
        aliases: ["ReactJS", "React.js"],
        metadata: { version: 19 },
      });
      expect(updated!.aliases).toEqual(["ReactJS", "React.js"]);
      expect(updated!.metadata).toEqual({ version: 19 });
    });

    it("returns null for nonexistent entity", () => {
      expect(store.update("missing", { name: "X" })).toBeNull();
    });
  });

  describe("delete", () => {
    it("deletes an existing entity", () => {
      const entity = store.create({ name: "Temp" });
      expect(store.delete(entity.id)).toBe(true);
      expect(store.getById(entity.id)).toBeNull();
    });

    it("returns false for nonexistent entity", () => {
      expect(store.delete("missing")).toBe(false);
    });
  });

  describe("linkMemory / getMemoriesForEntity", () => {
    it("links memories and returns them ordered by relevance", async () => {
      const entity = store.create({ name: "Exocortex", type: "project" });
      const memStore = new MemoryStore(db);
      const m1 = await memStore.create({ content: "First memory" });
      const m2 = await memStore.create({ content: "Second memory" });

      store.linkMemory(entity.id, m1.memory.id, 0.3);
      store.linkMemory(entity.id, m2.memory.id, 0.9);

      const ids = store.getMemoriesForEntity(entity.id);
      expect(ids).toEqual([m2.memory.id, m1.memory.id]);
    });

    it("returns empty array when no memories linked", () => {
      const entity = store.create({ name: "Empty" });
      expect(store.getMemoriesForEntity(entity.id)).toEqual([]);
    });

    it("upserts on duplicate link", async () => {
      const entity = store.create({ name: "Test" });
      const memStore = new MemoryStore(db);
      const m = await memStore.create({ content: "Memory" });

      store.linkMemory(entity.id, m.memory.id, 0.5);
      store.linkMemory(entity.id, m.memory.id, 0.9);

      const ids = store.getMemoriesForEntity(entity.id);
      expect(ids).toHaveLength(1);
    });
  });

  describe("relationships", () => {
    it("adds and retrieves relationships", () => {
      const react = store.create({ name: "React", type: "technology" });
      const nextjs = store.create({ name: "Next.js", type: "technology" });

      store.addRelationship(nextjs.id, react.id, "uses");

      const rels = store.getRelationships(nextjs.id);
      expect(rels).toHaveLength(1);
      expect(rels[0].source_entity_id).toBe(nextjs.id);
      expect(rels[0].target_entity_id).toBe(react.id);
      expect(rels[0].relationship).toBe("uses");
    });

    it("deduplicates identical relationships", () => {
      const a = store.create({ name: "A" });
      const b = store.create({ name: "B" });

      store.addRelationship(a.id, b.id, "uses");
      store.addRelationship(a.id, b.id, "uses");

      expect(store.getRelationships(a.id)).toHaveLength(1);
    });

    it("allows different relationship types between same entities", () => {
      const a = store.create({ name: "A" });
      const b = store.create({ name: "B" });

      store.addRelationship(a.id, b.id, "uses");
      store.addRelationship(a.id, b.id, "extends");

      expect(store.getRelationships(a.id)).toHaveLength(2);
    });

    it("retrieves relationships from both directions", () => {
      const a = store.create({ name: "A" });
      const b = store.create({ name: "B" });

      store.addRelationship(a.id, b.id, "uses");

      expect(store.getRelationships(a.id)).toHaveLength(1);
      expect(store.getRelationships(b.id)).toHaveLength(1);
    });
  });

  describe("getRelatedEntities", () => {
    it("returns related entities with direction", () => {
      const react = store.create({ name: "React", type: "technology" });
      const nextjs = store.create({ name: "Next.js", type: "technology" });
      const remix = store.create({ name: "Remix", type: "technology" });

      store.addRelationship(nextjs.id, react.id, "uses");
      store.addRelationship(remix.id, react.id, "uses");

      const related = store.getRelatedEntities(react.id);
      expect(related).toHaveLength(2);
      expect(related.every((r) => r.direction === "incoming")).toBe(true);
      expect(related.map((r) => r.entity.name).sort()).toEqual(["Next.js", "Remix"]);
    });

    it("distinguishes outgoing and incoming directions", () => {
      const a = store.create({ name: "A" });
      const b = store.create({ name: "B" });
      const c = store.create({ name: "C" });

      store.addRelationship(a.id, b.id, "uses");
      store.addRelationship(c.id, a.id, "extends");

      const related = store.getRelatedEntities(a.id);
      const outgoing = related.find((r) => r.direction === "outgoing");
      const incoming = related.find((r) => r.direction === "incoming");

      expect(outgoing!.entity.name).toBe("B");
      expect(outgoing!.relationship).toBe("uses");
      expect(incoming!.entity.name).toBe("C");
      expect(incoming!.relationship).toBe("extends");
    });

    it("returns empty array when no relationships exist", () => {
      const entity = store.create({ name: "Isolated" });
      expect(store.getRelatedEntities(entity.id)).toEqual([]);
    });
  });
});
