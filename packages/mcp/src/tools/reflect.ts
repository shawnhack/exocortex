import {
  getDb,
  initializeSchema,
  MemorySearch,
  MemoryStore,
} from "@exocortex/core";

export const contextTool = {
  name: "memory_context",
  description:
    "Get contextual memories for a topic. Use this at the start of a conversation to load relevant background context about a subject, project, or person.",
  inputSchema: {
    type: "object" as const,
    properties: {
      topic: {
        type: "string",
        description: "The topic to load context for (e.g. 'exocortex project', 'crypto portfolio', 'health goals')",
      },
      limit: {
        type: "number",
        description: "Max memories to return (default 15)",
      },
    },
    required: ["topic"],
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const topic = args.topic as string;
    const limit = Math.min((args.limit as number) ?? 15, 30);

    const db = getDb();
    initializeSchema(db);
    const search = new MemorySearch(db);
    const store = new MemoryStore(db);

    const results = await search.search({ query: topic, limit });

    if (results.length === 0) {
      return `No context found for "${topic}".`;
    }

    for (const r of results) {
      await store.recordAccess(r.memory.id, `context:${topic}`);
    }

    const lines = results.map((r) => {
      const m = r.memory;
      const tagStr = m.tags?.length ? ` [${m.tags.join(", ")}]` : "";
      return `- ${m.content}${tagStr} (${m.created_at})`;
    });

    return `Context for "${topic}" (${results.length} memories):\n\n${lines.join("\n")}`;
  },
};

export const entitiesTool = {
  name: "memory_entities",
  description:
    "List entities (people, projects, technologies, organizations, concepts) tracked in Exocortex, optionally filtered by type. Returns entity names and linked memory counts.",
  inputSchema: {
    type: "object" as const,
    properties: {
      type: {
        type: "string",
        enum: ["person", "project", "technology", "organization", "concept"],
        description: "Filter by entity type",
      },
      query: {
        type: "string",
        description: "Search entity names",
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const type = args.type as string | undefined;
    const query = args.query as string | undefined;

    const db = getDb();
    initializeSchema(db);

    let sql = `
      SELECT e.id, e.name, e.type, e.aliases,
             COUNT(me.memory_id) as memory_count
      FROM entities e
      LEFT JOIN memory_entities me ON e.id = me.entity_id
    `;
    const conditions: string[] = [];
    const params: string[] = [];

    if (type) {
      conditions.push("e.type = ?");
      params.push(type);
    }
    if (query) {
      conditions.push("(e.name LIKE ? OR e.aliases LIKE ?)");
      params.push(`%${query}%`, `%${query}%`);
    }

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }
    sql += " GROUP BY e.id ORDER BY memory_count DESC, e.name ASC LIMIT 50";

    const rows = db.prepare(sql).all(...params) as unknown as Array<{
      id: string;
      name: string;
      type: string;
      aliases: string;
      memory_count: number;
    }>;

    if (rows.length === 0) {
      return type
        ? `No entities found of type "${type}".`
        : "No entities found. Entities are created when memories are analyzed (Phase 3).";
    }

    const lines = rows.map((r) => {
      const aliases = JSON.parse(r.aliases) as string[];
      const aliasStr = aliases.length > 0 ? ` (aka: ${aliases.join(", ")})` : "";
      return `- ${r.name}${aliasStr} [${r.type}] — ${r.memory_count} memories`;
    });

    return `Entities (${rows.length}):\n\n${lines.join("\n")}`;
  },
};
