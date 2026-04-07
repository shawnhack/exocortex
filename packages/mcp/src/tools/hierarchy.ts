import { z } from "zod";
import { buildPalace, compactPalace, buildWakeUpContext, runBenchmark, writeDiaryEntry, readDiary, listDiaryAgents } from "@exocortex/core";
import type { ToolRegistrationContext } from "./types.js";

export function registerHierarchyTools(ctx: ToolRegistrationContext): void {
  const { server, db } = ctx;

  server.tool(
    "memory_navigate",
    "Browse the memory palace — hierarchical view of all knowledge organized into wings (projects), " +
    "halls (categories like decisions, techniques, events), and rooms (entities/topics). " +
    "Use this BEFORE memory_search to narrow scope. A wing+room filter improves retrieval by ~34%.",
    {
      wing: z.string().optional().describe(
        "Filter to a specific wing (namespace/project). Omit for full palace overview."
      ),
      compact: z.boolean().optional().describe(
        "Return compressed AAAK-style output (default false)"
      ),
    },
    async (args) => {
      try {
        const palace = buildPalace(db);

        if (args.compact) {
          return { content: [{ type: "text", text: compactPalace(palace) }] };
        }

        const lines: string[] = [];

        if (args.wing) {
          // Show detail for one wing
          const wing = palace.wings.find(
            (w) => w.name.toLowerCase() === args.wing!.toLowerCase()
          );
          if (!wing) {
            const available = palace.wings.map((w) => w.name).join(", ");
            return {
              content: [{ type: "text", text: `Wing "${args.wing}" not found. Available: ${available}` }],
            };
          }

          lines.push(`# Wing: ${wing.name} (${wing.memoryCount} memories)\n`);

          lines.push("## Halls (categories)");
          for (const h of wing.halls) {
            lines.push(`  ${h.name}: ${h.memoryCount} memories`);
          }

          lines.push("\n## Rooms (topics)");
          for (const r of wing.rooms) {
            lines.push(`  ${r.name} (${r.memoryCount} memories)`);
            lines.push(`    ${r.closet}`);
          }

          // Show tunnels involving this wing
          const wingTunnels = palace.tunnels.filter((t) =>
            t.wings.includes(wing.name)
          );
          if (wingTunnels.length > 0) {
            lines.push("\n## Tunnels (cross-wing connections)");
            for (const t of wingTunnels) {
              const otherWings = t.wings.filter((w) => w !== wing.name);
              lines.push(`  ${t.entity} ↔ ${otherWings.join(", ")}`);
            }
          }
        } else {
          // Full palace overview
          lines.push(`# Memory Palace — ${palace.stats.totalMemories} memories\n`);
          lines.push(`Wings: ${palace.stats.totalWings} | Rooms: ${palace.stats.totalRooms} | Tunnels: ${palace.stats.totalTunnels}\n`);

          lines.push("## Wings");
          for (const w of palace.wings) {
            const halls = w.halls.map((h) => `${h.name}:${h.memoryCount}`).join(", ");
            const rooms = w.rooms.slice(0, 5).map((r) => r.name).join(", ");
            lines.push(`  ${w.name} (${w.memoryCount}) — halls: ${halls}`);
            if (rooms) lines.push(`    rooms: ${rooms}`);
          }

          if (palace.tunnels.length > 0) {
            lines.push("\n## Top Tunnels (cross-wing entities)");
            for (const t of palace.tunnels.slice(0, 15)) {
              lines.push(`  ${t.entity} ↔ ${t.wings.join(", ")}`);
            }
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Navigate failed: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    "memory_wakeup",
    "Load compressed wake-up context (~200 tokens). Returns identity, active projects, " +
    "goals, recent decisions, top techniques, and palace overview in AAAK-compressed format. " +
    "Call this ONCE at session start instead of multiple search calls.",
    {},
    async () => {
      try {
        const context = buildWakeUpContext(db);
        return { content: [{ type: "text", text: context }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Wake-up failed: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    "diary_write",
    "Record a diary entry for an agent. Call after each session to log what happened, " +
    "what was learned, and what matters. Entries are per-agent and queryable by topic.",
    {
      agent: z.string().describe("Agent name (e.g. 'sentinel', 'claude-code', 'codex')"),
      entry: z.string().describe("What happened this session — actions taken, lessons learned, what matters"),
      topic: z.string().optional().describe("Topic tag (default 'general'). Examples: 'debugging', 'architecture', 'goal-work'"),
    },
    async (args) => {
      try {
        const result = writeDiaryEntry(db, args.agent, args.entry, args.topic);
        return { content: [{ type: "text", text: `Diary entry ${result.id} recorded for ${result.agent} [${result.topic}]` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Diary write failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    "diary_read",
    "Read an agent's diary entries. Returns recent entries, optionally filtered by topic or date range.",
    {
      agent: z.string().describe("Agent name to read diary for"),
      last_n: z.number().min(1).max(50).optional().describe("Number of recent entries (default 10)"),
      topic: z.string().optional().describe("Filter by topic"),
      after: z.string().optional().describe("Only entries after this date (ISO format)"),
      before: z.string().optional().describe("Only entries before this date (ISO format)"),
    },
    async (args) => {
      try {
        const entries = readDiary(db, args.agent, {
          lastN: args.last_n,
          topic: args.topic,
          after: args.after,
          before: args.before,
        });

        if (entries.length === 0) {
          return { content: [{ type: "text", text: `No diary entries for agent "${args.agent}"` }] };
        }

        const lines = entries.map((e) =>
          `[${e.created_at}] [${e.topic}]\n${e.entry}`
        );
        return { content: [{ type: "text", text: `${args.agent}'s diary (${entries.length} entries):\n\n${lines.join("\n\n---\n\n")}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Diary read failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    "diary_list_agents",
    "List all agents that have diary entries, with entry counts and last entry date.",
    {},
    async () => {
      try {
        const agents = listDiaryAgents(db);
        if (agents.length === 0) {
          return { content: [{ type: "text", text: "No diary entries recorded yet." }] };
        }
        const lines = agents.map((a) => `${a.agent}: ${a.entries} entries, last: ${a.lastEntry}`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Diary list failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    "memory_benchmark",
    "Run a retrieval benchmark measuring recall@5, recall@10, and MRR. " +
    "Generates test queries from existing memories and checks if the search pipeline can find them. " +
    "Use to measure retrieval quality and track improvements over time.",
    {
      num_queries: z.number().min(5).max(200).optional().describe("Number of test queries (default 50)"),
      namespace: z.string().optional().describe("Filter to a specific project/namespace"),
      min_importance: z.number().min(0).max(1).optional().describe("Min importance for test memories (default 0.4)"),
    },
    async (args) => {
      try {
        const result = runBenchmark(db, {
          numQueries: args.num_queries,
          namespace: args.namespace,
          minImportance: args.min_importance,
        });

        const lines = [
          "=== Retrieval Benchmark ===\n",
          `Recall@5:  ${result.recallAt5}%`,
          `Recall@10: ${result.recallAt10}%`,
          `MRR:       ${result.mrr}`,
          `Queries:   ${result.totalQueries}`,
          `Duration:  ${result.durationMs}ms\n`,
        ];

        // Show missed queries (rank 0 or >10)
        const missed = result.queries.filter((q) => !q.foundAt10);
        if (missed.length > 0) {
          lines.push(`Missed (${missed.length}):`);
          for (const m of missed.slice(0, 10)) {
            lines.push(`  "${m.query}" → not found in top 10`);
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Benchmark failed: ${msg}` }], isError: true };
      }
    }
  );
}
