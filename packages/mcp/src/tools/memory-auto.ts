/**
 * memory_auto — Single consolidated tool for all memory operations.
 * Takes a natural language intent and routes to the right internal operation.
 * Reduces cognitive load from 15+ tools to 1 for agent consumers.
 */

import { z } from "zod";
import { MemoryStore, MemorySearch, stripPrivateContent, validateStorageGate } from "@exocortex/core";
import { packByTokenBudget } from "../utils.js";
import { resolveAttribution } from "./helpers.js";
import type { ToolRegistrationContext } from "./types.js";

type Intent = "store" | "search" | "context" | "forget" | "update";

/** Simple intent classifier — routes natural language to operation */
function classifyIntent(input: string): Intent {
  const lower = input.toLowerCase();

  if (/^(remember|store|save|record|note|log)\b/i.test(lower)) return "store";
  if (/\b(remember that|note that|save this|store this)\b/i.test(lower)) return "store";
  if (/^(forget|delete|remove|deactivate)\b/i.test(lower)) return "forget";
  if (/^(update|change|modify|correct)\b/i.test(lower)) return "update";
  if (/^(what do (i|we|you) know about|context|background|brief me|catch me up|overview)\b/i.test(lower)) return "context";
  if (/^(what|when|where|who|how|why|find|search|look up|recall)\b/i.test(lower)) return "search";
  if (/\?$/.test(input.trim())) return "search";

  return "search";
}

/** Extract the content/query from the input based on intent */
function extractPayload(input: string): string {
  return input
    .replace(/^(remember|store|save|record|note|log|forget|delete|remove|search|find|look up|recall|what do (i|we|you) know about)\s+/i, "")
    .replace(/^that\s+/i, "")
    .trim() || input;
}

export function registerMemoryAutoTool(ctx: ToolRegistrationContext): void {
  const { server, db, defaultAttribution: DEFAULT_ATTRIBUTION, recordSearchResults } = ctx;

  server.tool(
    "memory_auto",
    'All-in-one memory tool. Understands natural language: "Remember that X", "What do I know about Y?", "Forget Z", "Context on project W". Routes to store/search/context/forget automatically.',
    {
      input: z.string().describe('Natural language instruction. Examples: "Remember that the deploy uses Jito MEV", "What do I know about auth?", "Context on chain-intel", "Forget the old pricing plan"'),
      namespace: z.string().optional().describe("Project namespace for scoped operations"),
      tags: z.array(z.string()).optional().describe("Tags (for store operations)"),
      importance: z.number().min(0).max(1).optional().describe("Importance 0-1 (for store operations)"),
      provider: z.string().optional().describe("Model provider for attribution"),
      model_id: z.string().optional().describe("Model ID for attribution"),
      model_name: z.string().optional().describe("Model name for attribution"),
      agent: z.string().optional().describe("Agent identifier for attribution"),
    },
    async (args) => {
      const intent = classifyIntent(args.input);
      const payload = extractPayload(args.input);

      try {
        switch (intent) {
          case "store": {
            const stripped = stripPrivateContent(payload);
            validateStorageGate(stripped, { tags: args.tags });

            const store = new MemoryStore(db);
            const result = await store.create({
              content: payload,
              content_type: "text",
              source: "mcp",
              importance: args.importance ?? 0.5,
              tags: args.tags,
              namespace: args.namespace,
              ...resolveAttribution(args, DEFAULT_ATTRIBUTION),
            });

            let msg = `Stored memory ${result.memory.id}`;
            if (result.dedup_action) msg += ` (${result.dedup_action})`;
            return { content: [{ type: "text" as const, text: msg }] };
          }

          case "search": {
            const search = new MemorySearch(db);
            const results = await search.search({
              query: payload,
              limit: 10,
              namespace: args.namespace,
              active_only: true,
            });

            if (results.length === 0) {
              return { content: [{ type: "text" as const, text: "No memories found matching that query." }] };
            }

            recordSearchResults(results.map(r => r.memory.id));

            const { formatted } = packByTokenBudget(
              results,
              4000,
              (r) => `[${r.memory.id}] (score: ${r.score.toFixed(3)})\n${r.memory.content}`,
            );

            return { content: [{ type: "text" as const, text: `Found ${results.length} memories:\n\n${formatted.join("\n\n")}` }] };
          }

          case "context": {
            const search = new MemorySearch(db);
            const results = await search.search({
              query: payload,
              limit: 15,
              namespace: args.namespace,
              active_only: true,
            });

            if (results.length === 0) {
              return { content: [{ type: "text" as const, text: `No context found for "${payload}".` }] };
            }

            recordSearchResults(results.map(r => r.memory.id));

            const { formatted } = packByTokenBudget(
              results,
              6000,
              (r) => r.memory.content,
            );

            return { content: [{ type: "text" as const, text: `Context for "${payload}":\n\n${formatted.join("\n\n")}` }] };
          }

          case "forget": {
            const search = new MemorySearch(db);
            const results = await search.search({
              query: payload,
              limit: 1,
              namespace: args.namespace,
              active_only: true,
            });

            if (results.length === 0) {
              return { content: [{ type: "text" as const, text: `No memory found matching "${payload}" to forget.` }] };
            }

            const store = new MemoryStore(db);
            await store.delete(results[0]!.memory.id);
            const preview = results[0]!.memory.content.slice(0, 100);

            return { content: [{ type: "text" as const, text: `Forgot memory ${results[0]!.memory.id}: ${preview}...` }] };
          }

          case "update": {
            const search = new MemorySearch(db);
            const results = await search.search({
              query: payload,
              limit: 1,
              namespace: args.namespace,
              active_only: true,
            });

            if (results.length === 0) {
              return { content: [{ type: "text" as const, text: `No memory found matching "${payload}" to update. Try storing a new memory instead.` }] };
            }

            const store = new MemoryStore(db);
            const updated = await store.update(results[0]!.memory.id, {
              content: payload,
              tags: args.tags,
            });

            if (!updated) {
              return { content: [{ type: "text" as const, text: `Failed to update memory ${results[0]!.memory.id}` }] };
            }

            return { content: [{ type: "text" as const, text: `Updated memory ${updated.id}` }] };
          }

          default:
            return { content: [{ type: "text" as const, text: `Unknown intent: ${intent}` }] };
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
      }
    },
  );
}
