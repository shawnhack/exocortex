import { Hono } from "hono";
import { getDb, MemoryLinkStore } from "@exocortex/core";

const links = new Hono();

/**
 * GET /api/memories/:id/links — Get all links for a memory.
 * Returns linked memory IDs, link types, and strengths.
 */
links.get("/api/memories/:id/links", (c) => {
  const db = getDb();
  const store = new MemoryLinkStore(db);
  const id = c.req.param("id");

  const memory = db.prepare("SELECT id FROM memories WHERE id = ?").get(id);
  if (!memory) return c.json({ error: "Memory not found" }, 404);

  const memoryLinks = store.getLinks(id);

  // Batch-fetch all linked memory previews in one query
  const otherIds = memoryLinks.map((link) =>
    link.source_id === id ? link.target_id : link.source_id
  );
  const previewMap = new Map<string, { id: string; content: string; content_type: string; importance: number; created_at: string }>();
  if (otherIds.length > 0) {
    const placeholders = otherIds.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT id, content, content_type, importance, created_at FROM memories WHERE id IN (${placeholders})`)
      .all(...otherIds) as Array<{ id: string; content: string; content_type: string; importance: number; created_at: string }>;
    for (const row of rows) {
      previewMap.set(row.id, row);
    }
  }

  const results = memoryLinks.map((link) => {
    const otherId = link.source_id === id ? link.target_id : link.source_id;
    const direction = link.source_id === id ? "outgoing" : "incoming";
    const row = previewMap.get(otherId);

    return {
      memory_id: otherId,
      link_type: link.link_type,
      strength: link.strength,
      direction,
      created_at: link.created_at,
      preview: row
        ? {
            id: row.id,
            content: row.content.length > 200 ? row.content.slice(0, 200) + "..." : row.content,
            content_type: row.content_type,
            importance: row.importance,
            created_at: row.created_at,
          }
        : null,
    };
  });

  return c.json({ links: results, count: results.length });
});

export default links;
