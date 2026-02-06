import { z } from "zod";
import { getDb, initializeSchema, MemoryStore } from "@exocortex/core";
import type { ContentType } from "@exocortex/core";

export const rememberTool = {
  name: "memory_store",
  description:
    "Store a new memory in Exocortex. Use this to save important information, facts, preferences, decisions, or context that should be remembered for future conversations.",
  inputSchema: {
    type: "object" as const,
    properties: {
      content: {
        type: "string",
        description: "The content to remember",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Optional tags for categorization (e.g. ['project', 'decision'])",
      },
      importance: {
        type: "number",
        description: "Importance score 0-1. Default 0.5. Use 0.8+ for critical facts, preferences, or decisions.",
      },
      content_type: {
        type: "string",
        enum: ["text", "conversation", "note", "summary"],
        description: "Type of content. Default 'text'.",
      },
      model: {
        type: "string",
        description: "AI model that created this memory (e.g. 'claude-opus-4-6')",
      },
    },
    required: ["content"],
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const content = args.content as string;
    const tags = args.tags as string[] | undefined;
    const importance = args.importance as number | undefined;
    const content_type = (args.content_type as ContentType) ?? "text";
    const model = args.model as string | undefined;

    const db = getDb();
    initializeSchema(db);
    const store = new MemoryStore(db);

    const metadata: Record<string, unknown> | undefined = model ? { model } : undefined;

    const { memory } = await store.create({
      content,
      content_type,
      source: "mcp",
      importance: importance ?? 0.5,
      tags,
      metadata,
    });

    return `Stored memory ${memory.id}${tags?.length ? ` [tags: ${tags.join(", ")}]` : ""}${importance ? ` [importance: ${importance}]` : ""}`;
  },
};
