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

  const memoryLinks = store.getLinks(id);

  // For each link, resolve the "other" side's content preview
  const results = memoryLinks.map((link) => {
    const otherId = link.source_id === id ? link.target_id : link.source_id;
    const direction = link.source_id === id ? "outgoing" : "incoming";

    // Get a content preview for the linked memory
    const row = db
      .prepare("SELECT id, content, content_type, importance, created_at FROM memories WHERE id = ?")
      .get(otherId) as { id: string; content: string; content_type: string; importance: number; created_at: string } | undefined;

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
