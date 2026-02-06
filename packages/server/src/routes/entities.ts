import { Hono } from "hono";
import { z } from "zod";
import { getDb, EntityStore, MemoryStore } from "@exocortex/core";
import type { EntityType } from "@exocortex/core";
import { stripEmbedding } from "../utils.js";

const entities = new Hono();

const createSchema = z.object({
  name: z.string().min(1),
  type: z
    .enum(["person", "project", "technology", "organization", "concept"])
    .optional(),
  aliases: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  type: z
    .enum(["person", "project", "technology", "organization", "concept"])
    .optional(),
  aliases: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// GET /api/entities/graph — all entities + relationships in one call
entities.get("/api/entities/graph", (c) => {
  const db = getDb();
  const store = new EntityStore(db);
  const allEntities = store.list();

  // Single query for all relationships instead of N+1
  const rows = db
    .prepare(
      "SELECT source_entity_id, target_entity_id, relationship FROM entity_relationships ORDER BY created_at DESC"
    )
    .all() as Array<{ source_entity_id: string; target_entity_id: string; relationship: string }>;

  const relationships = rows.map((r) => ({
    source_id: r.source_entity_id,
    target_id: r.target_entity_id,
    relationship: r.relationship,
  }));

  return c.json({ entities: allEntities, relationships });
});

// GET /api/entities
entities.get("/api/entities", (c) => {
  const type = c.req.query("type") as EntityType | undefined;
  const db = getDb();
  const store = new EntityStore(db);
  const results = store.list(type);
  return c.json({ results, count: results.length });
});

// POST /api/entities
entities.post("/api/entities", async (c) => {
  const body = await c.req.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }
  const db = getDb();
  const store = new EntityStore(db);
  const entity = store.create(parsed.data);
  return c.json(entity, 201);
});

// GET /api/entities/:id
entities.get("/api/entities/:id", (c) => {
  const db = getDb();
  const store = new EntityStore(db);
  const entity = store.getById(c.req.param("id"));
  if (!entity) return c.json({ error: "Not found" }, 404);
  return c.json(entity);
});

// PATCH /api/entities/:id
entities.patch("/api/entities/:id", async (c) => {
  const body = await c.req.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }
  const db = getDb();
  const store = new EntityStore(db);
  const entity = store.update(c.req.param("id"), parsed.data);
  if (!entity) return c.json({ error: "Not found" }, 404);
  return c.json(entity);
});

// DELETE /api/entities/:id
entities.delete("/api/entities/:id", (c) => {
  const db = getDb();
  const store = new EntityStore(db);
  const deleted = store.delete(c.req.param("id"));
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// GET /api/entities/:id/relationships
entities.get("/api/entities/:id/relationships", (c) => {
  const db = getDb();
  const store = new EntityStore(db);
  const entity = store.getById(c.req.param("id"));
  if (!entity) return c.json({ error: "Not found" }, 404);
  const relationships = store.getRelatedEntities(entity.id);
  return c.json({ results: relationships, count: relationships.length });
});

// GET /api/entities/:id/memories
entities.get("/api/entities/:id/memories", async (c) => {
  const db = getDb();
  const entityStore = new EntityStore(db);
  const entity = entityStore.getById(c.req.param("id"));
  if (!entity) return c.json({ error: "Not found" }, 404);

  const memoryIds = entityStore.getMemoriesForEntity(entity.id);
  const memoryStore = new MemoryStore(db);
  const memories = (await memoryStore.getByIds(memoryIds)).map(stripEmbedding);

  return c.json({ entity, memories, count: memories.length });
});

export default entities;
