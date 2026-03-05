import { describe, it, expect, beforeEach } from "vitest";
import { getDbForTesting } from "../db/connection.js";
import { initializeSchema } from "../db/schema.js";
import { EntityStore } from "./store.js";
import type { DatabaseSync } from "node:sqlite";

describe("EntityStore", () => {
  let db: DatabaseSync;
  let store: EntityStore;

  beforeEach(() => {
    db = getDbForTesting();
    initializeSchema(db);
    store = new EntityStore(db);
  });

  describe("create", () => {
    it("should create an entity with defaults", () => {
      const entity = store.create({ name: "PostgreSQL" });
      expect(entity.id).toBeTruthy();
      expect(entity.name).toBe("PostgreSQL");
      expect(entity.type).toBe("concept");
      expect(entity.aliases).toEqual([]);
      expect(entity.tags).toEqual([]);
    });

    it("should create an entity with all fields", () => {
      const entity = store.create({
        name: "React",
        type: "technology",
        aliases: ["ReactJS", "React.js"],
        tags: ["frontend", "library"],
        metadata: { version: "19" },
      });

      expect(entity.name).toBe("React");
      expect(entity.type).toBe("technology");
      expect(entity.aliases).toEqual(["ReactJS", "React.js"]);
      expect(entity.tags).toContain("frontend");
      expect(entity.tags).toContain("library");
      expect(entity.metadata).toEqual({ version: "19" });
    });
  });

  describe("getById / getByName", () => {
    it("should retrieve entity by ID", () => {
      const created = store.create({ name: "Node.js" });
      const found = store.getById(created.id);
      expect(found?.name).toBe("Node.js");
    });

    it("should return null for non-existent ID", () => {
      expect(store.getById("nonexistent")).toBeNull();
    });

    it("should retrieve entity by name (case-insensitive)", () => {
      store.create({ name: "TypeScript" });
      expect(store.getByName("typescript")?.name).toBe("TypeScript");
      expect(store.getByName("TYPESCRIPT")?.name).toBe("TypeScript");
    });

    it("should return null for non-existent name", () => {
      expect(store.getByName("nonexistent")).toBeNull();
    });
  });

  describe("list", () => {
    it("should list all entities", () => {
      store.create({ name: "A" });
      store.create({ name: "B" });
      expect(store.list()).toHaveLength(2);
    });

    it("should filter by type (legacy string param)", () => {
      store.create({ name: "Alice", type: "person" });
      store.create({ name: "React", type: "technology" });

      const people = store.list("person");
      expect(people).toHaveLength(1);
      expect(people[0].name).toBe("Alice");
    });

    it("should filter by tags", () => {
      store.create({ name: "React", tags: ["frontend"] });
      store.create({ name: "Express", tags: ["backend"] });

      const frontend = store.list({ tags: ["frontend"] });
      expect(frontend).toHaveLength(1);
      expect(frontend[0].name).toBe("React");
    });

    it("should sort by name ascending", () => {
      store.create({ name: "Zebra" });
      store.create({ name: "Apple" });
      const list = store.list();
      expect(list[0].name).toBe("Apple");
      expect(list[1].name).toBe("Zebra");
    });
  });

  describe("update", () => {
    it("should update entity name", () => {
      const entity = store.create({ name: "Old Name" });
      const updated = store.update(entity.id, { name: "New Name" });
      expect(updated?.name).toBe("New Name");
    });

    it("should update aliases", () => {
      const entity = store.create({ name: "React", aliases: ["ReactJS"] });
      const updated = store.update(entity.id, { aliases: ["ReactJS", "React.js"] });
      expect(updated?.aliases).toEqual(["ReactJS", "React.js"]);
    });

    it("should replace tags entirely", () => {
      const entity = store.create({ name: "React", tags: ["old-tag"] });
      store.update(entity.id, { tags: ["new-tag-1", "new-tag-2"] });
      const found = store.getById(entity.id);
      expect(found?.tags).toContain("new-tag-1");
      expect(found?.tags).toContain("new-tag-2");
      expect(found?.tags).not.toContain("old-tag");
    });

    it("should return null for non-existent entity", () => {
      expect(store.update("nonexistent", { name: "X" })).toBeNull();
    });
  });

  describe("delete", () => {
    it("should delete an entity", () => {
      const entity = store.create({ name: "Temp" });
      expect(store.delete(entity.id)).toBe(true);
      expect(store.getById(entity.id)).toBeNull();
    });

    it("should return false for non-existent entity", () => {
      expect(store.delete("nonexistent")).toBe(false);
    });
  });

  describe("relationships", () => {
    it("should add and retrieve relationships", () => {
      const a = store.create({ name: "React" });
      const b = store.create({ name: "JavaScript" });

      store.addRelationship(a.id, b.id, "uses", 0.9);
      const rels = store.getRelationships(a.id);
      expect(rels).toHaveLength(1);
      expect(rels[0].relationship).toBe("uses");
      expect(rels[0].confidence).toBe(0.9);
    });

    it("should deduplicate relationships", () => {
      const a = store.create({ name: "React" });
      const b = store.create({ name: "JavaScript" });

      store.addRelationship(a.id, b.id, "uses");
      store.addRelationship(a.id, b.id, "uses"); // duplicate
      expect(store.getRelationships(a.id)).toHaveLength(1);
    });

    it("should get related entities with direction", () => {
      const a = store.create({ name: "React" });
      const b = store.create({ name: "JavaScript" });

      store.addRelationship(a.id, b.id, "uses");
      const related = store.getRelatedEntities(a.id);
      expect(related).toHaveLength(1);
      expect(related[0].entity.name).toBe("JavaScript");
      expect(related[0].direction).toBe("outgoing");

      const incoming = store.getRelatedEntities(b.id);
      expect(incoming[0].direction).toBe("incoming");
    });
  });

  describe("memory links", () => {
    it("should link and retrieve memories for entity", () => {
      const entity = store.create({ name: "React" });
      const ts = new Date().toISOString().replace("T", " ").replace("Z", "");
      db.prepare(
        `INSERT INTO memories (id, content, content_type, source, importance, is_active, created_at, updated_at)
         VALUES (?, ?, 'text', 'api', 0.5, 1, ?, ?)`
      ).run("mem-1", "React is great", ts, ts);

      store.linkMemory(entity.id, "mem-1", 0.9);
      const memoryIds = store.getMemoriesForEntity(entity.id);
      expect(memoryIds).toContain("mem-1");
    });
  });

  describe("pruneOrphans", () => {
    it("should prune entities with fewer than minLinks active memories", () => {
      store.create({ name: "Orphan" });
      store.create({ name: "Connected" });

      const connected = store.getByName("Connected")!;
      const ts = new Date().toISOString().replace("T", " ").replace("Z", "");
      for (let i = 0; i < 3; i++) {
        db.prepare(
          `INSERT INTO memories (id, content, content_type, source, importance, is_active, created_at, updated_at)
           VALUES (?, ?, 'text', 'api', 0.5, 1, ?, ?)`
        ).run(`mem-${i}`, `Memory ${i}`, ts, ts);
        store.linkMemory(connected.id, `mem-${i}`);
      }

      const result = store.pruneOrphans(2);
      expect(result.pruned).toBe(1);
      expect(result.names).toContain("Orphan");
      expect(store.getByName("Connected")).not.toBeNull();
    });
  });
});
