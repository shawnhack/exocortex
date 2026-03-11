import { Hono } from "hono";
import { z } from "zod";
import { getDb, MemoryStore, ingestUrl, researchTopic } from "@exocortex/core";
import type { MemoryTier } from "@exocortex/core";

const library = new Hono();

// GET /api/library/documents — list all parent documents (source=import, has metadata.document_url)
library.get("/api/library/documents", (c) => {
  const db = getDb();
  const limit = parseInt(c.req.query("limit") ?? "50", 10);
  const offset = parseInt(c.req.query("offset") ?? "0", 10);
  const search = c.req.query("search")?.trim() ?? "";

  const searchClause = search
    ? `AND (m.metadata LIKE '%' || ? || '%' OR m.source_uri LIKE '%' || ? || '%')`
    : "";
  const searchParams = search ? [search, search] : [];

  const rows = db
    .prepare(
      `SELECT m.id, m.content, m.importance, m.source_uri, m.tier, m.namespace,
              m.created_at, m.updated_at, m.metadata,
              (SELECT COUNT(*) FROM memories c WHERE c.parent_id = m.id AND c.is_active = 1) AS chunk_count
       FROM memories m
       WHERE m.is_active = 1
         AND m.source = 'import'
         AND m.source_uri IS NOT NULL
         AND m.parent_id IS NULL
         AND EXISTS (SELECT 1 FROM memories c WHERE c.parent_id = m.id)
         ${searchClause}
       ORDER BY m.created_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(...searchParams, limit, offset) as Array<{
    id: string;
    content: string;
    importance: number;
    source_uri: string;
    tier: string;
    namespace: string | null;
    created_at: string;
    updated_at: string;
    metadata: string | null;
    chunk_count: number;
  }>;

  const total = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM memories m
       WHERE m.is_active = 1
         AND m.source = 'import'
         AND m.source_uri IS NOT NULL
         AND m.parent_id IS NULL
         AND EXISTS (SELECT 1 FROM memories c WHERE c.parent_id = m.id)
         ${searchClause}`
    )
    .get(...searchParams) as { cnt: number };

  // Batch-fetch tags for all documents in one query (avoids N+1)
  const tagMap = new Map<string, string[]>();
  if (rows.length > 0) {
    const placeholders = rows.map(() => "?").join(",");
    const tagRows = db
      .prepare(`SELECT memory_id, tag FROM memory_tags WHERE memory_id IN (${placeholders})`)
      .all(...rows.map((r) => r.id)) as Array<{ memory_id: string; tag: string }>;
    for (const t of tagRows) {
      const arr = tagMap.get(t.memory_id) ?? [];
      arr.push(t.tag);
      tagMap.set(t.memory_id, arr);
    }
  }

  const documents = rows.map((r) => {
    const meta = r.metadata ? JSON.parse(r.metadata) : {};
    return {
      id: r.id,
      title: meta.document_title ?? r.source_uri,
      url: meta.document_url ?? r.source_uri,
      description: meta.document_description ?? null,
      total_chars: meta.total_chars ?? 0,
      chunk_count: r.chunk_count,
      importance: r.importance,
      tier: r.tier,
      namespace: r.namespace,
      tags: tagMap.get(r.id) ?? [],
      ingested_at: meta.ingested_at ?? r.created_at,
      created_at: r.created_at,
    };
  });

  return c.json({ documents, total: total.cnt });
});

// GET /api/library/documents/:id — get document with chunks
library.get("/api/library/documents/:id", (c) => {
  const db = getDb();
  const id = c.req.param("id");

  const row = db
    .prepare(
      `SELECT id, content, importance, source_uri, tier, namespace,
              created_at, updated_at, metadata
       FROM memories WHERE id = ? AND is_active = 1`
    )
    .get(id) as {
    id: string;
    content: string;
    importance: number;
    source_uri: string;
    tier: string;
    namespace: string | null;
    created_at: string;
    updated_at: string;
    metadata: string | null;
  } | undefined;

  if (!row) return c.json({ error: "Document not found" }, 404);

  const meta = row.metadata ? JSON.parse(row.metadata) : {};
  const tags = (
    db
      .prepare("SELECT tag FROM memory_tags WHERE memory_id = ?")
      .all(id) as Array<{ tag: string }>
  ).map((t) => t.tag);

  const chunks = db
    .prepare(
      `SELECT id, content, created_at
       FROM memories
       WHERE parent_id = ? AND is_active = 1
       ORDER BY created_at ASC`
    )
    .all(id) as Array<{
    id: string;
    content: string;
    created_at: string;
  }>;

  return c.json({
    id: row.id,
    title: meta.document_title ?? row.source_uri,
    url: meta.document_url ?? row.source_uri,
    description: meta.document_description ?? null,
    total_chars: meta.total_chars ?? 0,
    content: row.content,
    importance: row.importance,
    tier: row.tier,
    namespace: row.namespace,
    tags,
    ingested_at: meta.ingested_at ?? row.created_at,
    created_at: row.created_at,
    chunks: chunks.map((ch, i) => ({
      id: ch.id,
      index: i,
      content: ch.content,
      chars: ch.content.length,
    })),
  });
});

const ingestUrlSchema = z.object({
  url: z.string().url(),
  content: z.string().optional(),
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
  importance: z.number().min(0).max(1).optional(),
  tier: z
    .enum(["working", "episodic", "semantic", "procedural", "reference"])
    .optional(),
  namespace: z.string().optional(),
  chunk_size: z.number().min(100).max(5000).optional(),
  chunk_overlap: z.number().min(0).max(500).optional(),
});

// POST /api/library/ingest — ingest a URL
library.post("/api/library/ingest", async (c) => {
  const body = await c.req.json();
  const parsed = ingestUrlSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const db = getDb();
  try {
    const result = await ingestUrl(db, {
      ...parsed.data,
      tier: parsed.data.tier as MemoryTier | undefined,
    });
    return c.json(result);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500
    );
  }
});

const researchSchema = z.object({
  topic: z.string().min(1),
  queries: z.array(z.string()).optional(),
  max_sources: z.number().min(1).max(20).optional(),
  tags: z.array(z.string()).optional(),
  importance: z.number().min(0).max(1).optional(),
  tier: z
    .enum(["working", "episodic", "semantic", "procedural", "reference"])
    .optional(),
  namespace: z.string().optional(),
});

// POST /api/library/research — research a topic and ingest sources
library.post("/api/library/research", async (c) => {
  const body = await c.req.json();
  const parsed = researchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const db = getDb();
  try {
    const result = await researchTopic(db, {
      ...parsed.data,
      tier: parsed.data.tier as MemoryTier | undefined,
    });
    return c.json(result);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500
    );
  }
});

// DELETE /api/library/documents/:id — delete document and all chunks
library.delete("/api/library/documents/:id", async (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const store = new MemoryStore(db);

  const doc = await store.getById(id);
  if (!doc) return c.json({ error: "Document not found" }, 404);

  // Delete chunks first
  const chunks = db
    .prepare("SELECT id FROM memories WHERE parent_id = ? AND is_active = 1")
    .all(id) as Array<{ id: string }>;

  for (const chunk of chunks) {
    await store.delete(chunk.id);
  }
  await store.delete(id);

  return c.json({ ok: true, deleted: chunks.length + 1 });
});

export default library;
