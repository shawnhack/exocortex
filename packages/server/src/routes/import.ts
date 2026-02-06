import { Hono } from "hono";
import { z } from "zod";
import { getDb, MemoryStore } from "@exocortex/core";
import type { ContentType } from "@exocortex/core";

const importRoute = new Hono();

const importSchema = z.object({
  memories: z.array(
    z.object({
      content: z.string().min(1),
      content_type: z
        .enum(["text", "conversation", "note", "summary"])
        .optional(),
      source_uri: z.string().optional(),
      importance: z.number().min(0).max(1).optional(),
      tags: z.array(z.string()).optional(),
    })
  ),
});

// POST /api/memories/import
importRoute.post("/api/memories/import", async (c) => {
  const body = await c.req.json();
  const parsed = importSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const db = getDb();
  const store = new MemoryStore(db);

  let imported = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const item of parsed.data.memories) {
    try {
      await store.create({
        content: item.content,
        content_type: item.content_type ?? "text",
        source: "import",
        source_uri: item.source_uri,
        importance: item.importance,
        tags: item.tags,
      });
      imported++;
    } catch (err) {
      failed++;
      errors.push(
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  return c.json({ imported, failed, errors: errors.slice(0, 10) });
});

export default importRoute;
