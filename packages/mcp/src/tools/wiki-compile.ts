import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { compileWiki, runBehavioralAudit } from "@exocortex/core";
import type { ToolRegistrationContext } from "./types.js";

const DEFAULT_WIKI_PATH = process.env.EXOCORTEX_WIKI_PATH
  || (process.env.OBSIDIAN_VAULT ? `${process.env.OBSIDIAN_VAULT}/wiki` : "./wiki");

export function registerWikiCompileTools(ctx: ToolRegistrationContext): void {
  const { server, db } = ctx;

  server.tool(
    "memory_compile",
    "Compile the memory system into a browsable wiki of interlinked markdown articles. " +
    "Groups memories by namespace (project), gathers linked entities, " +
    "and writes structured .md articles to the Obsidian vault. " +
    "Maintains _index.md (article catalog) and _log.md (operations log).",
    {
      wiki_path: z.string().optional().describe(
        `Output directory for wiki articles (default: ${DEFAULT_WIKI_PATH})`
      ),
      namespace: z.string().optional().describe(
        "Compile only a specific namespace/project"
      ),
      dry_run: z.boolean().optional().describe(
        "Preview what would be compiled without writing files (default false)"
      ),
      min_memories: z.number().min(1).optional().describe(
        "Min memories needed to produce an article (default 5)"
      ),
      max_memories: z.number().min(1).max(200).optional().describe(
        "Max memories per article (default 50)"
      ),
    },
    async (args) => {
      try {
        const result = compileWiki(db, {
          wikiPath: args.wiki_path ?? DEFAULT_WIKI_PATH,
          namespace: args.namespace,
          dryRun: args.dry_run ?? false,
          minMemories: args.min_memories,
          maxMemories: args.max_memories,
        });

        const lines: string[] = [];

        if (result.articles.length === 0) {
          lines.push("No articles compiled — not enough namespaces or memories meeting thresholds.");
          lines.push(result.logEntry);
        } else {
          lines.push(`Compiled ${result.articles.length} wiki articles:\n`);
          for (const a of result.articles) {
            const entityPreview = a.entities.slice(0, 4).join(", ") || "—";
            lines.push(`  ${a.title} — ${a.memoryCount} sources, ${a.wordCount} words [${entityPreview}]`);
          }
          lines.push(`\nTotal: ${result.articles.reduce((s, a) => s + a.wordCount, 0)} words`);
          lines.push(`Index updated: ${result.indexUpdated}`);
          lines.push(result.logEntry);

          if (args.dry_run) {
            lines.push("\n(dry run — no files written)");
          } else {
            lines.push(`\nWiki path: ${args.wiki_path ?? DEFAULT_WIKI_PATH}`);
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Wiki compilation failed: ${msg}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "wiki_write_article",
    "Write or update a synthesized wiki article. Use after reading an extractive article " +
    "and rewriting it into coherent prose. The content replaces the existing article file.",
    {
      slug: z.string().describe("Article slug (filename without .md, e.g. 'my-project', 'skills-and-techniques')"),
      content: z.string().describe("Full article content including frontmatter (---...---) and markdown body"),
      wiki_path: z.string().optional().describe(`Wiki directory (default: ${DEFAULT_WIKI_PATH})`),
    },
    async (args) => {
      try {
        const wikiDir = args.wiki_path ?? DEFAULT_WIKI_PATH;
        const filePath = path.join(wikiDir, `${args.slug}.md`);

        // Validate the slug targets the wiki dir
        if (!filePath.startsWith(wikiDir)) {
          return { content: [{ type: "text", text: "Error: slug must not contain path separators" }], isError: true };
        }

        // Ensure directory exists
        if (!fs.existsSync(wikiDir)) {
          fs.mkdirSync(wikiDir, { recursive: true });
        }

        fs.writeFileSync(filePath, args.content, "utf-8");
        const wordCount = args.content.split(/\s+/).length;

        return {
          content: [{ type: "text", text: `Written ${args.slug}.md (${wordCount} words) to ${wikiDir}` }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Write failed: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    "memory_security_audit",
    "Run a behavioral security audit on the memory store. " +
    "Detects: bulk external ingestion, high-influence external content, " +
    "rapid access patterns, and trust level mismatches.",
    {},
    async () => {
      try {
        const report = runBehavioralAudit(db);
        const lines: string[] = [
          "=== Memory Security Audit ===\n",
          `Total memories: ${report.stats.totalMemories}`,
          `External memories: ${report.stats.externalMemories} (${report.stats.externalPct}%)`,
          `Recent external (24h): ${report.stats.recentExternalCount}`,
          `High-influence external: ${report.stats.highInfluenceExternalCount}`,
        ];

        if (report.anomalies.length === 0) {
          lines.push("\nNo anomalies detected.");
        } else {
          lines.push(`\n${report.anomalies.length} anomaly(ies) found:\n`);
          for (const a of report.anomalies) {
            lines.push(`  [${a.severity.toUpperCase()}] ${a.type}${a.memoryId ? ` (${a.memoryId})` : ""}`);
            lines.push(`    ${a.detail}`);
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Security audit failed: ${msg}` }],
          isError: true,
        };
      }
    }
  );
}
