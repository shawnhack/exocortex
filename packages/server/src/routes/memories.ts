import { Hono } from "hono";
import { z } from "zod";
import {
  getDb,
  MemoryStore,
  MemorySearch,
  MemoryLinkStore,
  getAllSettings,
  setSetting,
  exportData,
} from "@exocortex/core";
import { notifyMemoryStored } from "../scheduler.js";
import { stripEmbedding } from "../utils.js";

const memories = new Hono();

const createSchema = z.object({
  content: z.string().min(1),
  content_type: z
    .enum(["text", "conversation", "note", "summary"])
    .optional(),
  source: z
    .enum([
      "manual",
      "cli",
      "api",
      "mcp",
      "browser",
      "import",
      "consolidation",
    ])
    .optional(),
  source_uri: z.string().optional(),
  provider: z.string().optional(),
  model_id: z.string().optional(),
  model_name: z.string().optional(),
  agent: z.string().optional(),
  session_id: z.string().optional(),
  conversation_id: z.string().optional(),
  importance: z.number().min(0).max(1).optional(),
  parent_id: z.string().optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  is_metadata: z.boolean().optional(),
  benchmark: z.boolean().optional(),
});

const updateSchema = z.object({
  content: z.string().min(1).optional(),
  content_type: z
    .enum(["text", "conversation", "note", "summary"])
    .optional(),
  source_uri: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  model_id: z.string().nullable().optional(),
  model_name: z.string().nullable().optional(),
  agent: z.string().nullable().optional(),
  session_id: z.string().nullable().optional(),
  conversation_id: z.string().nullable().optional(),
  importance: z.number().min(0).max(1).optional(),
  is_active: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  is_metadata: z.boolean().optional(),
});

const searchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
  content_type: z
    .enum(["text", "conversation", "note", "summary"])
    .optional(),
  source: z
    .enum([
      "manual",
      "cli",
      "api",
      "mcp",
      "browser",
      "import",
      "consolidation",
    ])
    .optional(),
  tags: z.array(z.string()).optional(),
  after: z.string().optional(),
  before: z.string().optional(),
  min_importance: z.number().min(0).max(1).optional(),
  min_score: z.number().min(0).max(1).optional(),
  include_metadata: z.boolean().optional(),
  compact: z.boolean().optional(),
});

const settingsPatchSchema = z.record(z.string(), z.string());

function parseIntQuery(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function isSensitiveSettingKey(key: string): boolean {
  return /(api[_-]?key|token|secret|password)/i.test(key);
}

function maskSensitiveValue(value: string): string {
  if (value.length === 0) return value;
  if (value.length <= 4) return "••••";
  return `${value.slice(0, 2)}••••${value.slice(-2)}`;
}

function maskSensitiveSettings(settings: Record<string, string>): Record<string, string> {
  const masked = { ...settings };
  for (const key of Object.keys(masked)) {
    if (isSensitiveSettingKey(key)) {
      masked[key] = maskSensitiveValue(masked[key] ?? "");
    }
  }
  return masked;
}

// POST /api/memories — Create memory
memories.post("/api/memories", async (c) => {
  const body = await c.req.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const db = getDb();
  const store = new MemoryStore(db);
  const result = await store.create({
    ...parsed.data,
    source: parsed.data.source ?? "api",
  });
  if (result.dedup_action !== "skipped") {
    notifyMemoryStored();
  }
  const { memory } = result;
  return c.json(stripEmbedding(memory), 201);
});

// GET /api/memories/recent (must be before :id to avoid shadowing)
memories.get("/api/memories/recent", async (c) => {
  const limit = parseIntQuery(c.req.query("limit"), 20, 1, 100);
  const offset = parseIntQuery(c.req.query("offset"), 0, 0, 1_000_000);
  const tagsParam = c.req.query("tags");
  const tags = tagsParam ? tagsParam.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
  const contentType = c.req.query("content_type");
  const after = c.req.query("after");
  const before = c.req.query("before");
  const minImportanceParam = c.req.query("min_importance");
  const minImportance = minImportanceParam !== undefined ? Number.parseFloat(minImportanceParam) : undefined;

  const db = getDb();
  const store = new MemoryStore(db);
  // Fetch extra rows to account for filtering, then trim to requested limit
  const fetchLimit = (contentType || after || before || minImportance !== undefined) ? limit * 5 : limit;
  let results = await store.getRecent(fetchLimit, offset, tags);

  if (contentType) {
    results = results.filter((m) => m.content_type === contentType);
  }
  if (after) {
    results = results.filter((m) => m.created_at >= after);
  }
  if (before) {
    results = results.filter((m) => m.created_at <= before);
  }
  if (minImportance !== undefined && Number.isFinite(minImportance)) {
    results = results.filter((m) => m.importance >= minImportance);
  }

  results = results.slice(0, limit);
  return c.json({ results: results.map(stripEmbedding), count: results.length });
});

// POST /api/memories/search
memories.post("/api/memories/search", async (c) => {
  const body = await c.req.json();
  const parsed = searchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const db = getDb();
  const search = new MemorySearch(db);
  const results = await search.search(parsed.data);

  if (parsed.data.compact) {
    const compactResults = results.map((r) => ({
      id: r.memory.id,
      preview: r.memory.content.substring(0, 80) + (r.memory.content.length > 80 ? "..." : ""),
      score: r.score,
      tags: r.memory.tags ?? [],
      created_at: r.memory.created_at,
    }));
    return c.json({ results: compactResults, count: results.length });
  }

  // Record access for returned memories (skip for compact — no full read)
  const store = new MemoryStore(db);
  for (const result of results) {
    await store.recordAccess(result.memory.id, parsed.data.query);
  }

  return c.json({ results: results.map(r => ({ ...r, memory: stripEmbedding(r.memory) })), count: results.length });
});

const contextGraphSchema = z.object({
  query: z.string().min(1),
  max_tokens: z.number().int().min(100).max(100000).optional(),
  compact: z.boolean().optional(),
  max_linked: z.number().int().min(0).max(50).optional(),
});

// POST /api/memories/context-graph
memories.post("/api/memories/context-graph", async (c) => {
  const body = await c.req.json();
  const parsed = contextGraphSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const { query, compact, max_linked = 5 } = parsed.data;
  const maxTokens = parsed.data.max_tokens;

  const db = getDb();
  const search = new MemorySearch(db);
  const store = new MemoryStore(db);
  const linkStore = new MemoryLinkStore(db);

  // 1. Run standard hybrid search (same as /api/memories/search)
  const searchResults = await search.search({
    query,
    limit: maxTokens ? 50 : 15,
  });

  if (searchResults.length === 0) {
    return c.json({ results: [], count: 0, linked_count: 0 });
  }

  // 2. Collect seed memory IDs
  const seedIds = searchResults.map((r) => r.memory.id);

  // 3. Get 1-hop linked memory refs
  const linkedRefs = linkStore.getLinkedRefs(seedIds);

  // 4. Cap at max_linked
  const cappedRefs = linkedRefs.slice(0, max_linked);

  // 5. Fetch linked memories
  const linkedIds = cappedRefs.map((ref) => ref.id);
  const linkedMemories = linkedIds.length > 0 ? await store.getByIds(linkedIds) : [];

  // Build ref lookup
  const refMap = new Map(cappedRefs.map((ref) => [ref.id, ref]));

  // 6. Format results
  if (compact) {
    // Token budget: 80% seeds, 20% linked
    const seedBudget = maxTokens ? Math.floor(maxTokens * 0.8) : undefined;
    const linkedBudget = maxTokens ? maxTokens - (seedBudget ?? 0) : undefined;

    // Format seed results
    let seedResults = searchResults.map((r) => ({
      id: r.memory.id,
      preview: r.memory.content.substring(0, 120) + (r.memory.content.length > 120 ? "..." : ""),
      score: r.score,
      tags: r.memory.tags ?? [],
      created_at: r.memory.created_at,
    }));

    // Apply token budget to seeds
    if (seedBudget) {
      let tokens = 0;
      const capped: typeof seedResults = [];
      for (const r of seedResults) {
        const est = Math.ceil((r.preview.length + 40) / 4);
        if (capped.length > 0 && tokens + est > seedBudget) break;
        capped.push(r);
        tokens += est;
      }
      seedResults = capped;
    }

    // Format linked results
    let linkedResults = linkedMemories.map((m) => {
      const ref = refMap.get(m.id);
      return {
        id: m.id,
        preview: m.content.substring(0, 120) + (m.content.length > 120 ? "..." : ""),
        score: ref?.strength ?? 0,
        tags: m.tags ?? [],
        created_at: m.created_at,
        linked_from: ref?.linked_from,
        link_type: ref?.link_type,
      };
    });

    // Apply token budget to linked
    if (linkedBudget) {
      let tokens = 0;
      const capped: typeof linkedResults = [];
      for (const r of linkedResults) {
        const est = Math.ceil((r.preview.length + 60) / 4);
        if (capped.length > 0 && tokens + est > linkedBudget) break;
        capped.push(r);
        tokens += est;
      }
      linkedResults = capped;
    }

    const allResults = [...seedResults, ...linkedResults];
    return c.json({
      results: allResults,
      count: allResults.length,
      linked_count: linkedResults.length,
    });
  }

  // Non-compact: full results
  const seedFormatted = searchResults.map((r) => ({
    memory: r.memory,
    score: r.score,
  }));

  const linkedFormatted = linkedMemories.map((m) => {
    const ref = refMap.get(m.id);
    return {
      memory: m,
      score: ref?.strength ?? 0,
      linked_from: ref?.linked_from,
      link_type: ref?.link_type,
    };
  });

  // Record access for non-compact results
  for (const r of searchResults) {
    await store.recordAccess(r.memory.id, query);
  }

  return c.json({
    results: [...seedFormatted, ...linkedFormatted],
    count: seedFormatted.length + linkedFormatted.length,
    linked_count: linkedFormatted.length,
  });
});

// GET /api/memories/archived
memories.get("/api/memories/archived", async (c) => {
  const limit = parseIntQuery(c.req.query("limit"), 20, 1, 100);
  const offset = parseIntQuery(c.req.query("offset"), 0, 0, 1_000_000);

  const db = getDb();
  const store = new MemoryStore(db);
  const results = await store.getArchived(limit, offset);
  return c.json({ results: results.map(stripEmbedding), count: results.length });
});

// POST /api/memories/:id/restore
memories.post("/api/memories/:id/restore", async (c) => {
  const db = getDb();
  const store = new MemoryStore(db);
  const restored = await store.restore(c.req.param("id"));
  if (!restored) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// GET /api/memories/:id
memories.get("/api/memories/:id", async (c) => {
  const db = getDb();
  const store = new MemoryStore(db);
  const memory = await store.getById(c.req.param("id"));
  if (!memory) return c.json({ error: "Not found" }, 404);
  return c.json(stripEmbedding(memory));
});

// PATCH /api/memories/:id
memories.patch("/api/memories/:id", async (c) => {
  const body = await c.req.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const db = getDb();
  const store = new MemoryStore(db);
  const memory = await store.update(c.req.param("id"), parsed.data);
  if (!memory) return c.json({ error: "Not found" }, 404);
  return c.json(stripEmbedding(memory));
});

// DELETE /api/memories/:id
memories.delete("/api/memories/:id", async (c) => {
  const db = getDb();
  const store = new MemoryStore(db);
  const deleted = await store.delete(c.req.param("id"));
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// GET /api/export — export all data as JSON backup
memories.get("/api/export", (c) => {
  const db = getDb();
  const data = exportData(db);
  c.header("Content-Disposition", `attachment; filename="exocortex-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  return c.json(data);
});

// GET /api/stats
memories.get("/api/stats", async (c) => {
  const db = getDb();
  const store = new MemoryStore(db);
  const stats = await store.getStats();
  return c.json(stats);
});

// GET /api/settings
memories.get("/api/settings", (c) => {
  const db = getDb();
  return c.json(maskSensitiveSettings(getAllSettings(db)));
});

// PATCH /api/settings
memories.patch("/api/settings", async (c) => {
  const body = await c.req.json();
  const parsed = settingsPatchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }
  const db = getDb();
  for (const [key, value] of Object.entries(parsed.data)) {
    // Skip masked values to avoid overwriting real secrets
    if (value.includes("••••")) continue;
    setSetting(db, key, value);
  }
  return c.json(maskSensitiveSettings(getAllSettings(db)));
});

export default memories;
