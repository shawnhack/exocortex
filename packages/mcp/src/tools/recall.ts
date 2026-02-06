import { getDb, initializeSchema, MemorySearch, MemoryStore } from "@exocortex/core";
import type { ContentType, MemorySource } from "@exocortex/core";

export const recallTool = {
  name: "memory_search",
  description:
    "Search Exocortex memories using hybrid retrieval (semantic + keyword + recency + frequency). Use this to recall previously stored information, find relevant context, or check what is known about a topic.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "Natural language search query",
      },
      limit: {
        type: "number",
        description: "Max results to return (default 10, max 50)",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Filter by tags",
      },
      after: {
        type: "string",
        description: "Only memories after this date (YYYY-MM-DD)",
      },
      before: {
        type: "string",
        description: "Only memories before this date (YYYY-MM-DD)",
      },
      content_type: {
        type: "string",
        enum: ["text", "conversation", "note", "summary"],
        description: "Filter by content type",
      },
    },
    required: ["query"],
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const query = args.query as string;
    const limit = Math.min((args.limit as number) ?? 10, 50);
    const tags = args.tags as string[] | undefined;
    const after = args.after as string | undefined;
    const before = args.before as string | undefined;
    const content_type = args.content_type as ContentType | undefined;

    const db = getDb();
    initializeSchema(db);
    const search = new MemorySearch(db);
    const store = new MemoryStore(db);

    const results = await search.search({
      query,
      limit,
      tags,
      after,
      before,
      content_type,
    });

    if (results.length === 0) {
      return "No memories found matching the query.";
    }

    // Record access
    for (const r of results) {
      await store.recordAccess(r.memory.id, query);
    }

    const lines = results.map((r) => {
      const m = r.memory;
      const meta: string[] = [];
      if (m.tags?.length) meta.push(`tags: ${m.tags.join(", ")}`);
      meta.push(`score: ${r.score.toFixed(3)}`);
      meta.push(`created: ${m.created_at}`);
      if (m.importance !== 0.5) meta.push(`importance: ${m.importance}`);
      return `[${m.id}] ${m.content}\n  (${meta.join(" | ")})`;
    });

    return `Found ${results.length} memories:\n\n${lines.join("\n\n")}`;
  },
};
