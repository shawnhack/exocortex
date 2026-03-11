import { z } from "zod";
import { MemoryStore, MemoryLinkStore } from "@exocortex/core";
import type { LinkType } from "@exocortex/core";
import type { ToolRegistrationContext } from "./types.js";

export function registerLinkTools(ctx: ToolRegistrationContext): void {
  const { server, db } = ctx;

  // memory_link
  server.tool(
    "memory_link",
    "Create or remove a link between two memories. Links enable graph-aware context retrieval — linked memories surface together during context loading.",
    {
      source_id: z.string().describe("Source memory ID"),
      target_id: z.string().describe("Target memory ID"),
      link_type: z.enum(["related", "elaborates", "contradicts", "supersedes", "supports", "derived_from"]).optional().describe("Link type (default 'related')"),
      strength: z.number().min(0).max(1).optional().describe("Link strength 0-1 (default 0.5)"),
      remove: z.boolean().optional().describe("Set to true to remove the link instead of creating it"),
    },
    async (args) => {
      try {
        const store = new MemoryStore(db);
        const linkStore = new MemoryLinkStore(db);

        const source = await store.getById(args.source_id);
        if (!source) {
          return { content: [{ type: "text", text: `Source memory ${args.source_id} not found.` }] };
        }
        const target = await store.getById(args.target_id);
        if (!target) {
          return { content: [{ type: "text", text: `Target memory ${args.target_id} not found.` }] };
        }

        if (args.remove) {
          const removed = linkStore.unlink(args.source_id, args.target_id);
          if (!removed) {
            return { content: [{ type: "text", text: `No link found between ${args.source_id} and ${args.target_id}.` }] };
          }
          return { content: [{ type: "text", text: `Removed link ${args.source_id} → ${args.target_id}` }] };
        }

        const linkType = (args.link_type ?? "related") as LinkType;
        const strength = args.strength ?? 0.5;
        linkStore.link(args.source_id, args.target_id, linkType, strength);

        const srcPreview = source.content.substring(0, 60) + (source.content.length > 60 ? "..." : "");
        const tgtPreview = target.content.substring(0, 60) + (target.content.length > 60 ? "..." : "");
        return {
          content: [{
            type: "text",
            text: `Linked: "${srcPreview}" —[${linkType}, ${strength}]→ "${tgtPreview}"`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );
}
