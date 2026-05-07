import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { compileWiki, runBehavioralAudit, syncToObsidian } from "@exocortex/core";
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
    "and rewriting it into coherent prose. The content replaces the existing article file. " +
    "Slug may contain forward-slash subfolders (e.g. 'Briefings/Research-2026-05-07') — " +
    "intermediate directories are created automatically.",
    {
      slug: z.string().describe("Article slug (filename without .md). Subfolders allowed via '/', e.g. 'my-project' or 'Briefings/Research-2026-05-07'"),
      content: z.string().describe("Full article content including frontmatter (---...---) and markdown body"),
      wiki_path: z.string().optional().describe(`Wiki directory (default: ${DEFAULT_WIKI_PATH})`),
    },
    async (args) => {
      try {
        const wikiDir = args.wiki_path ?? DEFAULT_WIKI_PATH;
        const filePath = path.resolve(wikiDir, `${args.slug}.md`);
        const resolvedDir = path.resolve(wikiDir) + path.sep;

        // Traversal guard: filePath must stay inside wikiDir.
        // Subfolders within wikiDir are allowed (e.g. 'Briefings/...'),
        // but '..' escapes are rejected.
        if (!filePath.startsWith(resolvedDir)) {
          return { content: [{ type: "text", text: "Error: slug escapes wiki directory (use forward-slash subfolders only, no '..' segments)" }], isError: true };
        }

        // Ensure the target file's parent directory exists, including any
        // subfolders introduced by slugs like 'Briefings/Foo'.
        fs.mkdirSync(path.dirname(filePath), { recursive: true });

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
    "wiki_append_article",
    "Append or replace a dated section in a journal-style wiki article. " +
    "Idempotent — calling with the same section_heading replaces that section " +
    "rather than duplicating it. Use for monthly accumulation files like " +
    "'Research/2026-05' or 'Decisions/2026-05'. Most-recent sections appear " +
    "first in the file (reverse-chronological).",
    {
      slug: z.string().describe("Article slug, may contain subfolders (e.g. 'Research/2026-05')"),
      section_heading: z.string().describe("Section heading starting with '## ' (e.g. '## 2026-05-07' or '## Week of 2026-05-10'). Used as the idempotence key — same heading replaces the existing section."),
      content: z.string().describe("Section body content (markdown, without the heading itself)"),
      wiki_path: z.string().optional().describe(`Wiki directory (default: ${DEFAULT_WIKI_PATH})`),
      max_sections: z.number().min(1).optional().describe("Optional cap; if the file would exceed this many sections after the operation, oldest sections are trimmed"),
    },
    async (args) => {
      try {
        const wikiDir = args.wiki_path ?? DEFAULT_WIKI_PATH;
        const filePath = path.resolve(wikiDir, `${args.slug}.md`);
        const resolvedDir = path.resolve(wikiDir) + path.sep;

        if (!filePath.startsWith(resolvedDir)) {
          return { content: [{ type: "text", text: "Error: slug escapes wiki directory (use forward-slash subfolders only, no '..' segments)" }], isError: true };
        }

        if (!/^##\s+\S/.test(args.section_heading)) {
          return { content: [{ type: "text", text: "Error: section_heading must start with '## ' followed by a label (e.g. '## 2026-05-07')" }], isError: true };
        }

        fs.mkdirSync(path.dirname(filePath), { recursive: true });

        const today = new Date().toISOString().slice(0, 10);
        let frontmatter = "";
        let title = "";
        let body = "";

        if (fs.existsSync(filePath)) {
          const existing = fs.readFileSync(filePath, "utf-8");
          const fmMatch = existing.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/);
          if (fmMatch) {
            frontmatter = fmMatch[0].replace(/(updated:\s*)[^\r\n]+/, `$1${today}`);
            body = existing.slice(fmMatch[0].length);
          } else {
            body = existing;
          }
          const titleMatch = body.match(/^#\s+[^\r\n]+\r?\n+/);
          if (titleMatch) {
            title = titleMatch[0];
            body = body.slice(titleMatch[0].length);
          }
        } else {
          const baseName = args.slug.split('/').pop() ?? args.slug;
          frontmatter = `---\ntype: journal\nupdated: ${today}\n---\n\n`;
          title = `# ${baseName}\n\n`;
          body = "";
        }

        // Locate the start index of every '## ' heading line in body using matchAll
        const headingMatches = Array.from(body.matchAll(/^##\s+[^\r\n]*$/gm));
        const sectionStarts: number[] = headingMatches.map((m) => m.index ?? 0);

        type Section = { heading: string; content: string };
        const sections: Section[] = [];
        for (let i = 0; i < sectionStarts.length; i++) {
          const start = sectionStarts[i];
          const end = i + 1 < sectionStarts.length ? sectionStarts[i + 1] : body.length;
          const chunk = body.slice(start, end);
          const nl = chunk.indexOf('\n');
          const heading = (nl === -1 ? chunk : chunk.slice(0, nl)).trim();
          const content = (nl === -1 ? "" : chunk.slice(nl + 1)).replace(/\s+$/, '');
          sections.push({ heading, content });
        }

        const newSection: Section = {
          heading: args.section_heading.trim(),
          content: args.content.replace(/\s+$/, ''),
        };

        const existingIdx = sections.findIndex((s) => s.heading === newSection.heading);
        if (existingIdx >= 0) {
          sections.splice(existingIdx, 1);
        }
        // Most-recent first (reverse-chronological journal)
        sections.unshift(newSection);

        if (args.max_sections && sections.length > args.max_sections) {
          sections.length = args.max_sections;
        }

        const newBody = sections.map((s) => `${s.heading}\n${s.content}`).join('\n\n') + '\n';
        const finalContent = frontmatter + title + newBody;
        fs.writeFileSync(filePath, finalContent, "utf-8");

        const replaced = existingIdx >= 0;
        const wordCount = finalContent.split(/\s+/).length;
        return {
          content: [{ type: "text", text: `${replaced ? "Replaced" : "Appended"} section "${newSection.heading}" in ${args.slug}.md (${sections.length} sections, ${wordCount} words total)` }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Append failed: ${msg}` }], isError: true };
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

  // memory_obsidian_sync — incrementally sync memories to Obsidian vault
  server.tool(
    "memory_obsidian_sync",
    "Incrementally sync memories to an Obsidian vault. Only writes files for memories created or updated since the last sync. Each memory becomes a .md file with frontmatter, organized by namespace and tier.",
    {
      vault_path: z.string().optional().describe("Obsidian vault path (default: OBSIDIAN_VAULT env)"),
      dry_run: z.boolean().optional().describe("Preview changes without writing files"),
    },
    async (args) => {
      try {
        const vaultPath = args.vault_path
          ?? process.env.OBSIDIAN_VAULT
          ?? path.join(process.env.HOME ?? process.env.USERPROFILE ?? ".", "obsidian-vault");

        const result = syncToObsidian(db, {
          vaultPath,
          dryRun: args.dry_run,
        });

        if (result.newMemories === 0) {
          return { content: [{ type: "text", text: `Vault is up to date (last synced: ${result.lastSyncAt}).` }] };
        }

        const lines = [
          `Sync ${args.dry_run ? "preview" : "complete"}:`,
          `  Memories changed: ${result.newMemories}`,
          `  Files ${args.dry_run ? "to write" : "written"}: ${result.updatedFiles}`,
          `  Files ${args.dry_run ? "to delete" : "deleted"}: ${result.deletedFiles}`,
          `  Vault: ${vaultPath}/exocortex/`,
        ];

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Sync failed: ${msg}` }],
          isError: true,
        };
      }
    }
  );
}
