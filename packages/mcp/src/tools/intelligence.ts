import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { MemoryStore, MemorySearch, GoalStore, getContradictions, updateContradiction, autoDismissContradictions, recordJobOutcome, getJobHealth, getJobAlerts, runLint, refreshWiki, ingestUrl, buildReasoningBrief, formatReasoningBrief, isRerankEnabled, getDefaultReranker } from "@exocortex/core";
import type { RerankerProvider } from "@exocortex/core";
import type { ToolRegistrationContext } from "./types.js";

export function registerIntelligenceTools(ctx: ToolRegistrationContext): void {
  const { server, db, checkAndSignalUsefulness } = ctx;

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

  // memory_lint — comprehensive knowledge-base health check
  server.tool(
    "memory_lint",
    "Run a comprehensive knowledge-base health check. Returns contradictions, stale claims, orphan entities, unlinked memories, and suggested wiki topics. Use periodically to maintain knowledge quality.",
    {},
    async () => {
      try {
        const report = runLint(db);

        const sections: string[] = [];
        sections.push(`Overall: ${report.overall.toUpperCase()}`);
        sections.push(`Memories: ${report.stats.total_memories} | Entities: ${report.stats.total_entities}`);

        if (report.issues.length === 0) {
          sections.push("\nNo issues found.");
        } else {
          sections.push(`\n${report.issues.length} issue(s):\n`);
          for (const issue of report.issues) {
            const icon = issue.severity === "critical" ? "!!" : issue.severity === "warn" ? "!" : "-";
            sections.push(`${icon} [${issue.category}] ${issue.message}`);
          }
        }

        if (report.stats.suggested_topics.length > 0) {
          sections.push(`\nSuggested wiki topics:\n${report.stats.suggested_topics.map(t => `  - ${t}`).join("\n")}`);
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // memory_wiki_refresh — incrementally update stale wiki articles
  server.tool(
    "memory_wiki_refresh",
    "Refresh wiki articles that have stale content (memories updated since last compile). Only recompiles affected articles instead of regenerating everything.",
    {
      wiki_path: z.string().optional().describe("Wiki output directory (default: EXOCORTEX_WIKI_PATH or vault/wiki)"),
      since: z.string().optional().describe("Only refresh articles with memories updated after this ISO date"),
      dry_run: z.boolean().optional().describe("Preview which articles would be refreshed without writing"),
    },
    async (args) => {
      try {
        const wikiPath = args.wiki_path
          ?? process.env.EXOCORTEX_WIKI_PATH
          ?? path.join(process.env.OBSIDIAN_VAULT ?? ".", "wiki");

        const result = refreshWiki(db, {
          wikiPath,
          dryRun: args.dry_run,
          since: args.since,
        });

        if (result.staleArticles.length === 0) {
          return { content: [{ type: "text", text: "Wiki is up to date — no stale articles found." }] };
        }

        const lines = [
          `Found ${result.staleArticles.length} stale article(s):`,
          ...result.staleArticles.map(a => `  - ${a}`),
          "",
          args.dry_run
            ? `Dry run — ${result.staleArticles.length} article(s) would be refreshed.`
            : `Refreshed ${result.refreshed} article(s), skipped ${result.skipped}.`,
        ];

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // memory_promote — promote search results or analysis into a wiki article
  server.tool(
    "memory_promote",
    "Promote a synthesis, analysis, or set of memories into a persistent wiki article. Use when a query result, comparison, or analysis is valuable enough to keep in the wiki rather than losing it to chat history.",
    {
      title: z.string().describe("Article title"),
      content: z.string().describe("Full article content (markdown)"),
      tags: z.array(z.string()).optional().describe("Tags for the article"),
      wiki_path: z.string().optional().describe("Wiki output directory"),
      source_memory_ids: z.array(z.string()).optional().describe("Memory IDs that contributed to this article"),
    },
    async (args) => {
      try {
        const wikiPath = args.wiki_path
          ?? process.env.EXOCORTEX_WIKI_PATH
          ?? path.join(process.env.OBSIDIAN_VAULT ?? ".", "wiki");

        // Root-confinement check: prevent arbitrary filesystem writes
        const allowedRoot = path.resolve(process.env.EXOCORTEX_WIKI_PATH ?? path.join(process.env.OBSIDIAN_VAULT ?? ".", "wiki"));
        const resolvedWikiPath = path.resolve(wikiPath);
        if (!resolvedWikiPath.startsWith(allowedRoot)) {
          return { content: [{ type: "text", text: `Error: wiki_path outside allowed root` }], isError: true };
        }

        // Ensure wiki directory exists
        if (!fs.existsSync(wikiPath)) {
          fs.mkdirSync(wikiPath, { recursive: true });
        }

        const slug = args.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 80);

        // Build frontmatter
        const fm = [
          "---",
          `title: "${args.title}"`,
          `created: "${new Date().toISOString().slice(0, 10)}"`,
          `source: promoted`,
        ];
        if (args.tags?.length) fm.push(`tags: [${args.tags.join(", ")}]`);
        if (args.source_memory_ids?.length) fm.push(`sources: ${args.source_memory_ids.length}`);
        fm.push("---\n");

        const fullContent = fm.join("\n") + args.content;
        const articlePath = path.join(wikiPath, `${slug}.md`);

        // Store memory FIRST — if DB write fails, don't leave orphaned wiki files
        const store = new MemoryStore(db);
        await store.create({
          content: args.content,
          content_type: "summary",
          source: "api",
          source_uri: `wiki://${slug}`,
          importance: 0.8,
          tier: "semantic",
          tags: [...(args.tags ?? []), "wiki-article", "promoted"],
          metadata: {
            wiki_slug: slug,
            wiki_path: articlePath,
            source_memory_ids: args.source_memory_ids,
          },
        });

        // Write wiki file after DB success
        fs.writeFileSync(articlePath, fullContent, "utf-8");

        return {
          content: [{ type: "text", text: `Article "${args.title}" written to ${articlePath} and stored as semantic memory.` }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // memory_correct — correct a memory with updated information
  server.tool(
    "memory_correct",
    "Correct a memory that contains wrong or outdated information. Creates a new memory with the corrected content, supersedes the old one, and links them. Use when a fact, decision, or technique has changed and the old memory would mislead future retrieval.",
    {
      memory_id: z.string().describe("ID of the memory to correct"),
      corrected_content: z.string().describe("The corrected content that replaces the old memory"),
      reason: z.string().optional().describe("Why the correction was needed (stored in metadata)"),
      preserve_tags: z.boolean().optional().describe("Copy tags from the old memory (default true)"),
    },
    async (args) => {
      try {
        const store = new MemoryStore(db);
        const old = await store.getById(args.memory_id);
        if (!old) {
          return { content: [{ type: "text", text: `Memory ${args.memory_id} not found.` }], isError: true };
        }

        // Preserve tags from old memory unless told not to
        const preserveTags = args.preserve_tags !== false;
        const oldTags = preserveTags ? (old.tags ?? []) : [];

        // Create corrected memory
        const result = await store.create({
          content: args.corrected_content,
          content_type: old.content_type,
          source: old.source,
          source_uri: old.source_uri ?? undefined,
          importance: Math.max(old.importance, 0.7), // corrections are at least moderately important
          tier: old.tier,
          namespace: old.namespace ?? undefined,
          tags: [...oldTags, "corrected"],
          metadata: {
            corrects: args.memory_id,
            correction_reason: args.reason,
            original_content_preview: old.content.slice(0, 200),
          },
        });

        // Supersede the old memory
        db.prepare(
          "UPDATE memories SET superseded_by = ?, is_active = 0, updated_at = ? WHERE id = ?"
        ).run(result.memory.id, new Date().toISOString().replace("T", " ").replace("Z", ""), args.memory_id);

        // Correcting a memory implies the original was useful enough to warrant correction
        checkAndSignalUsefulness([args.memory_id], db);

        const lines = [
          `Corrected memory ${args.memory_id}`,
          `New memory: ${result.memory.id}`,
          `Old memory superseded and deactivated.`,
        ];
        if (args.reason) lines.push(`Reason: ${args.reason}`);

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // memory_clip — one-click web clipper: ingest a URL into the knowledge base
  server.tool(
    "memory_clip",
    "Quick-ingest a URL into the knowledge base. Fetches the page, extracts content, chunks it, and stores with immutable source flag. Use when adding web articles, documentation, or research to your second brain.",
    {
      url: z.string().describe("URL to clip and ingest"),
      tags: z.array(z.string()).optional().describe("Tags to apply"),
      namespace: z.string().optional().describe("Project namespace"),
      importance: z.number().min(0).max(1).optional().describe("Importance (default 0.6)"),
    },
    async (args) => {
      try {
        const result = await ingestUrl(db, {
          url: args.url,
          tags: args.tags,
          namespace: args.namespace,
          importance: args.importance,
        });

        const lines = [
          `Clipped: ${result.title ?? args.url}`,
          `Stored: ${result.chunks_stored} chunk(s), ${result.total_chars} chars`,
          `Memory ID: ${result.parent_id}`,
        ];
        if (args.tags?.length) lines.push(`Tags: ${args.tags.join(", ")}`);
        if (args.namespace) lines.push(`Namespace: ${args.namespace}`);

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // memory_reason — assemble a structured evidence package for the calling agent to synthesize an answer
  server.tool(
    "memory_reason",
    "Assemble a structured reasoning brief from retrieved memories. Returns evidence + a synthesis rubric — the CALLING AGENT does the synthesis using its own intelligence (no nested LLM call). Use for questions like 'what's my best understanding of X', 'what should I do about Y given everything I know', 'what's the pattern in my decisions about Z'. Distinct from memory_search (gives candidates) and memory_context (gives free-form context dump): this returns a rubric-guided evidence package optimized for synthesis. After receiving the brief, follow the rubric to write a synthesis with [memory-id] inline citations and an explicit confidence calibration.",
    {
      question: z.string().min(1).describe("The question to reason about"),
      retrievalLimit: z.number().int().min(1).max(50).optional().describe("How many memories to retrieve as evidence (default 15)"),
      tags: z.array(z.string()).optional().describe("Filter retrieval by tags"),
      after: z.string().optional().describe("Only memories after this date (YYYY-MM-DD)"),
      before: z.string().optional().describe("Only memories before this date (YYYY-MM-DD)"),
      tier: z.enum(["working", "episodic", "semantic", "procedural", "reference"]).optional().describe("Filter by knowledge tier"),
      namespace: z.string().optional().describe("Filter to a specific project's memories"),
      expanded_query: z.string().optional().describe("Optional rephrasing/expansion to improve recall"),
      contentTruncate: z.number().int().min(100).max(4000).optional().describe("Truncate long memory content (default 800 chars)"),
    },
    async (args) => {
      try {
        const reranker: RerankerProvider | undefined = isRerankEnabled(db)
          ? getDefaultReranker()
          : undefined;
        const brief = await buildReasoningBrief(db, args.question, {
          retrievalLimit: args.retrievalLimit,
          tags: args.tags,
          after: args.after,
          before: args.before,
          tier: args.tier,
          namespace: args.namespace,
          expanded_query: args.expanded_query,
          contentTruncate: args.contentTruncate,
          reranker,
        });

        const text = formatReasoningBrief(brief);

        // Implicit usefulness signal — the agent is about to reason over these memories.
        if (brief.evidence.length > 0) {
          checkAndSignalUsefulness(brief.evidence.slice(0, 3).map((e) => e.id), db);
        }

        return {
          content: [{ type: "text", text }],
          structured_content: {
            question: brief.question,
            evidenceCount: brief.evidenceCount,
            evidence: brief.evidence.map((e) => ({
              id: e.id,
              rank: e.rank,
              score: e.score,
              tier: e.tier,
              tags: e.tags,
            })),
            retrieval_ms: brief.retrieval_ms,
          },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );
}
