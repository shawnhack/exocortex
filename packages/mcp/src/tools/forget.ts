import { getDb, initializeSchema, MemoryStore } from "@exocortex/core";

export const forgetTool = {
  name: "memory_forget",
  description:
    "Delete a memory from Exocortex by its ID. Use this when information is no longer relevant or was stored incorrectly.",
  inputSchema: {
    type: "object" as const,
    properties: {
      id: {
        type: "string",
        description: "The memory ID to delete (ULID format)",
      },
    },
    required: ["id"],
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const id = args.id as string;

    const db = getDb();
    initializeSchema(db);
    const store = new MemoryStore(db);

    const existing = await store.getById(id);
    if (!existing) {
      return `Memory ${id} not found.`;
    }

    await store.delete(id);
    return `Deleted memory ${id}: "${existing.content.substring(0, 80)}${existing.content.length > 80 ? "..." : ""}"`;
  },
};
