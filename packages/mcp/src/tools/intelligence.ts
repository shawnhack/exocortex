import { z } from "zod";
import path from "node:path";
import { MemoryStore, MemorySearch, GoalStore, getContradictions, updateContradiction, autoDismissContradictions, recordJobOutcome, getJobHealth, getJobAlerts } from "@exocortex/core";
import type { ToolRegistrationContext } from "./types.js";

export function registerIntelligenceTools(ctx: ToolRegistrationContext): void {
  const { server, db } = ctx;

  // memory_project_snapshot
  server.tool(
    "memory_project_snapshot",
    "Get a quick project snapshot: recent activity, active goals, recent decisions, open threads, and learned techniques. Use at start of a project session.",
    {
      project: z.string().optional().describe("Project name to snapshot (auto-detected from cwd if omitted)"),
      cwd: z.string().optional().describe("Working directory for auto-detecting project name via path.basename()"),
      days: z.number().optional().describe("Lookback days (default 14)"),
    },
    async (args) => {
      try {
        const projectName = args.project || (args.cwd ? path.basename(args.cwd) : undefined);
        if (!projectName) {
          return { content: [{ type: "text", text: "Error: provide either 'project' or 'cwd' parameter" }], isError: true };
        }

        const days = args.days ?? 14;
        const since = new Date();
        since.setDate(since.getDate() - days);
        const sinceStr = since.toISOString();

        const search = new MemorySearch(db);
        const goalStore = new GoalStore(db);

        const [recentResults, decisionResults, goals, openThreadResults, techniqueResults] = await Promise.all([
          search.search({
            query: projectName,
            limit: 10,
            after: sinceStr,
          }),
          search.search({
            query: `${projectName} decision`,
            limit: 5,
            tags: ["decision"],
            after: sinceStr,
          }),
          Promise.resolve(goalStore.list("active")),
          search.search({
            query: projectName,
            limit: 5,
            tags: ["plan", "todo", "next-steps", "in-progress"],
            after: sinceStr,
          }),
          search.search({
            query: projectName,
            limit: 5,
            tags: ["technique"],
          }),
        ]);

        const sections: string[] = [];

        sections.push(`# Project Snapshot: ${projectName}\n*Last ${days} days*\n`);

        sections.push("## Recent Activity");
        if (recentResults.length === 0) {
          sections.push("No recent activity found.\n");
        } else {
          for (const r of recentResults) {
            const preview = r.memory.content.slice(0, 150).replace(/\n/g, " ");
            sections.push(`- **${r.memory.id}** (${r.memory.created_at.slice(0, 10)}, imp=${r.memory.importance}): ${preview}...`);
          }
          sections.push("");
        }

        sections.push("## Active Goals");
        if (goals.length === 0) {
          sections.push("No active goals.\n");
        } else {
          for (const g of goals) {
            const deadline = g.deadline ? ` (due: ${g.deadline})` : "";
            sections.push(`- **${g.title}** [${g.priority}]${deadline}`);
            if (g.description) sections.push(`  ${g.description.slice(0, 100)}`);
          }
          sections.push("");
        }

        sections.push("## Recent Decisions");
        if (decisionResults.length === 0) {
          sections.push("No recent decisions found.\n");
        } else {
          for (const d of decisionResults) {
            const preview = d.memory.content.slice(0, 200).replace(/\n/g, " ");
            sections.push(`- (${d.memory.created_at.slice(0, 10)}) ${preview}`);
          }
          sections.push("");
        }

        sections.push("## Open Threads");
        if (openThreadResults.length === 0) {
          sections.push("No open threads.\n");
        } else {
          for (const t of openThreadResults) {
            const preview = t.memory.content.slice(0, 150).replace(/\n/g, " ");
            sections.push(`- (${t.memory.created_at.slice(0, 10)}) ${preview}`);
          }
          sections.push("");
        }

        sections.push("## Learned Techniques");
        if (techniqueResults.length === 0) {
          sections.push("No techniques recorded.\n");
        } else {
          for (const t of techniqueResults) {
            const preview = t.memory.content.slice(0, 150).replace(/\n/g, " ");
            sections.push(`- (imp=${t.memory.importance}) ${preview}`);
          }
          sections.push("");
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // memory_diff
  server.tool(
    "memory_diff",
    "See what changed since a timestamp — new, updated, and archived memories.",
    {
      since: z.string().describe("ISO timestamp to diff from (e.g. 2026-02-24T00:00:00Z)"),
      limit: z.number().optional().describe("Max results per category (default 50)"),
      namespace: z.string().optional().describe("Optional namespace filter"),
    },
    async (args) => {
      try {
        const store = new MemoryStore(db);
        const diff = await store.getDiff(args.since, args.limit ?? 50, args.namespace);

        const sections: string[] = [];
        sections.push(`# Changes since ${args.since}\n`);

        sections.push(`## Created (${diff.created.length})`);
        for (const m of diff.created) {
          const preview = m.content.slice(0, 120).replace(/\n/g, " ");
          sections.push(`- **${m.id}** (${m.created_at.slice(0, 10)}): ${preview}`);
        }
        sections.push("");

        sections.push(`## Updated (${diff.updated.length})`);
        for (const m of diff.updated) {
          const preview = m.content.slice(0, 120).replace(/\n/g, " ");
          sections.push(`- **${m.id}** (${m.updated_at.slice(0, 10)}): ${preview}`);
        }
        sections.push("");

        sections.push(`## Archived (${diff.archived.length})`);
        for (const m of diff.archived) {
          const preview = m.content.slice(0, 120).replace(/\n/g, " ");
          sections.push(`- **${m.id}** (${m.updated_at.slice(0, 10)}): ${preview}`);
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // memory_contradictions
  server.tool(
    "memory_contradictions",
    "List or resolve detected contradictions between memories. Contradictions are detected nightly and can be dismissed or resolved inline.",
    {
      status: z.enum(["pending", "resolved", "dismissed"]).optional().describe("Filter by status (default: pending)"),
      limit: z.number().optional().describe("Max results (default 10)"),
      resolve_id: z.string().optional().describe("Contradiction ID to resolve/dismiss"),
      resolution: z.string().optional().describe("Resolution text (required when resolving, optional when dismissing)"),
      resolve_status: z.enum(["resolved", "dismissed"]).optional().describe("New status for resolve_id (default: resolved)"),
      auto_dismiss: z.boolean().optional().describe("Auto-dismiss low-signal contradictions (deleted sources, consolidation artifacts, low quality, version/date changes)"),
    },
    async (args) => {
      try {
        if (args.auto_dismiss) {
          const result = autoDismissContradictions(db);
          const summary = Object.entries(result.reasons)
            .map(([k, v]) => `${k}: ${v}`)
            .join(", ");
          return {
            content: [{ type: "text", text: `Auto-dismissed ${result.dismissed} contradictions.${summary ? `\nReasons: ${summary}` : ""}` }],
          };
        }

        if (args.resolve_id) {
          const newStatus = args.resolve_status ?? "resolved";
          const result = updateContradiction(db, args.resolve_id, {
            status: newStatus,
            resolution: args.resolution,
          });
          if (!result) {
            return { content: [{ type: "text", text: `Contradiction ${args.resolve_id} not found.` }], isError: true };
          }
          return {
            content: [{ type: "text", text: `Contradiction ${args.resolve_id} marked as ${newStatus}.${args.resolution ? ` Resolution: ${args.resolution}` : ""}` }],
          };
        }

        const status = args.status ?? "pending";
        const limit = args.limit ?? 10;
        const contradictions = getContradictions(db, status, limit);

        if (contradictions.length === 0) {
          return { content: [{ type: "text", text: `No ${status} contradictions found.` }] };
        }

        const store = new MemoryStore(db);
        const lines = await Promise.all(contradictions.map(async (c) => {
          const memA = await store.getById(c.memory_a_id);
          const memB = await store.getById(c.memory_b_id);
          const previewA = memA ? memA.content.substring(0, 120).replace(/\n/g, " ") : "(deleted)";
          const previewB = memB ? memB.content.substring(0, 120).replace(/\n/g, " ") : "(deleted)";
          const parts = [
            `**${c.id}** (${c.status}) — ${c.created_at.slice(0, 10)}`,
            `  A [${c.memory_a_id}]: ${previewA}`,
            `  B [${c.memory_b_id}]: ${previewB}`,
            `  Reason: ${c.description}`,
          ];
          if (c.resolution) parts.push(`  Resolution: ${c.resolution}`);
          return parts.join("\n");
        }));

        return {
          content: [{ type: "text", text: `${status} contradictions (${contradictions.length}):\n\n${lines.join("\n\n")}` }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // memory_job_health — record job outcomes and query health
  server.tool(
    "memory_job_health",
    "Record job execution outcomes and query job health. Use record_outcome to log a job run, or omit it to get a health summary. Jobs below 70% success rate over 3+ runs are flagged as alerts.",
    {
      record_outcome: z.object({
        job_name: z.string(),
        success: z.boolean(),
        duration_ms: z.number().optional(),
        error: z.string().optional(),
      }).optional().describe("Record a job execution outcome"),
      alerts_only: z.boolean().optional().describe("Only return jobs in alert state (default false)"),
      window_days: z.number().optional().describe("Lookback window in days (default 14)"),
      alert_threshold: z.number().optional().describe("Success rate threshold for alerts (default 0.70)"),
    },
    async (args) => {
      try {
        if (args.record_outcome) {
          recordJobOutcome(db, args.record_outcome);
          return {
            content: [{ type: "text", text: `Recorded ${args.record_outcome.success ? "success" : "failure"} for ${args.record_outcome.job_name}` }],
          };
        }

        const opts = {
          windowDays: args.window_days,
          alertThreshold: args.alert_threshold,
        };
        const jobs = args.alerts_only
          ? getJobAlerts(db, opts)
          : getJobHealth(db, opts);

        if (jobs.length === 0) {
          return {
            content: [{ type: "text", text: args.alerts_only ? "No job alerts." : "No job outcomes recorded." }],
          };
        }

        const lines = jobs.map(j => {
          const pct = (j.success_rate * 100).toFixed(0);
          const status = j.alert ? "⚠ ALERT" : "OK";
          return `${status} ${j.job_name}: ${pct}% success (${j.successes}/${j.total_runs}) — last: ${j.last_run.slice(0, 16)}${j.last_error ? `\n  Last error: ${j.last_error.slice(0, 120)}` : ""}`;
        });

        const alertCount = jobs.filter(j => j.alert).length;
        const header = args.alerts_only
          ? `Job alerts (${alertCount}):`
          : `Job health (${jobs.length} jobs, ${alertCount} alerts):`;

        return {
          content: [{ type: "text", text: `${header}\n\n${lines.join("\n")}` }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );
}
