import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { MemoryStore, ingestFiles, ingestUrl, researchTopic, digestTranscript, checkUrl, sanitizeContent } from "@exocortex/core";
import type { ContentType } from "@exocortex/core";
import type { ToolRegistrationContext } from "./types.js";

export function registerMemoryIngestTools(ctx: ToolRegistrationContext): void {
  const { server, db, defaultAttribution: DEFAULT_ATTRIBUTION } = ctx;

  // memory_ingest — unified tool for text/file, URL, and session transcript ingestion
  server.tool(
    "memory_ingest",
    "Ingest content into Exocortex from files, URLs, or session transcripts.",
    {
      source: z.enum(["text", "url", "session"]).describe("Source type: text (files), url (web page), session (transcript)"),

      // text source params
      path: z.union([z.string(), z.array(z.string())]).optional().describe("File path(s) with glob support (source: text)"),

      // url source params
      url: z.string().optional().describe("URL to fetch and ingest (source: url)"),
      content: z.string().optional().describe("Pre-fetched content, skips HTTP fetch (source: url)"),
      title: z.string().optional().describe("Document title, auto-extracted if omitted (source: url)"),
      namespace: z.string().optional().describe("Namespace for organization (source: url)"),
      chunk_size: z.number().min(100).max(5000).optional().describe("Target chunk size in chars (source: url)"),
      chunk_overlap: z.number().min(0).max(500).optional().describe("Chunk overlap in chars (source: url, default 50)"),

      // session source params
      transcript_path: z.string().optional().describe("Path to session transcript JSONL (source: session)"),

      // shared params
      tags: z.array(z.string()).optional().describe("Tags to apply to ingested memories"),
      importance: z.number().min(0).max(1).optional().describe("Importance score (default varies by source)"),
      content_type: z.enum(["text", "conversation", "note", "summary"]).optional().describe("Content type (default 'note')"),
      tier: z.enum(["working", "episodic", "semantic", "procedural", "reference"]).optional().describe("Knowledge tier (default 'reference')"),
    },
    async (args) => {
      // === SOURCE: text (file ingestion) ===
      if (args.source === "text") {
        if (!args.path) {
          return { content: [{ type: "text", text: "path is required for source: text" }], isError: true };
        }

        const inputPaths = Array.isArray(args.path) ? args.path : [args.path];

        const resolvedPaths: string[] = [];
        for (const p of inputPaths) {
          if (p.includes("*") || p.includes("?")) {
            const dir = path.dirname(p);
            const pattern = path.basename(p);
            const regex = new RegExp(
              "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
            );
            try {
              const absDir = path.resolve(dir);
              const entries = fs.readdirSync(absDir);
              for (const entry of entries) {
                if (regex.test(entry)) {
                  resolvedPaths.push(path.join(absDir, entry));
                }
              }
            } catch (err) {
              return {
                content: [{ type: "text" as const, text: `Error reading directory "${dir}": ${err instanceof Error ? err.message : String(err)}` }],
              };
            }
          } else {
            resolvedPaths.push(path.resolve(p));
          }
        }

        if (resolvedPaths.length === 0) {
          return { content: [{ type: "text", text: "No files matched the provided path(s)." }] };
        }

        const missing = resolvedPaths.filter((p) => !fs.existsSync(p));
        if (missing.length > 0) {
          return {
            content: [{ type: "text", text: `File(s) not found: ${missing.join(", ")}` }],
          };
        }

        try {
          const result = await ingestFiles(db, resolvedPaths, {
            tags: args.tags,
            importance: args.importance,
            content_type: args.content_type as ContentType | undefined,
            tier: args.tier as import("@exocortex/core").MemoryTier | undefined,
          });

          const lines = result.files.map((f) => {
            const name = path.basename(f.file);
            const replacedStr = f.replaced > 0 ? `, replaced ${f.replaced} existing` : "";
            return `- ${name}: ${f.stored} memories stored (${f.sections} sections, ${f.skipped} skipped${replacedStr})`;
          });

          const replacedStr = result.totalReplaced > 0 ? ` (replaced ${result.totalReplaced} existing)` : "";
          return {
            content: [{
              type: "text",
              text: `Ingested ${result.totalStored} memories from ${result.files.length} file(s)${replacedStr}:\n\n${lines.join("\n")}`,
            }],
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `Ingest error: ${err instanceof Error ? err.message : String(err)}` }],
          };
        }
      }

      // === SOURCE: url ===
      if (args.source === "url") {
        if (!args.url) {
          return { content: [{ type: "text", text: "url is required for source: url" }], isError: true };
        }

        const ingestUrlStr = args.url;

        // Security: check URL reputation before fetching
        const urlCheck = checkUrl(ingestUrlStr);
        if (!urlCheck.allowed) {
          return {
            content: [{ type: "text", text: `URL blocked: ${urlCheck.reason} (${ingestUrlStr})` }],
            isError: true,
          };
        }

        // Security: sanitize pre-fetched content if provided
        let ingestContent = args.content;
        if (ingestContent) {
          const sanitized = sanitizeContent(ingestContent);
          if (sanitized.threats.length > 0) {
            ingestContent = sanitized.content;
          }
        }

        try {
          const result = await ingestUrl(db, {
            url: ingestUrlStr,
            content: ingestContent,
            title: args.title,
            tags: args.tags,
            importance: args.importance,
            tier: args.tier as import("@exocortex/core").MemoryTier | undefined,
            namespace: args.namespace,
            chunk_size: args.chunk_size,
            chunk_overlap: args.chunk_overlap,
            ...DEFAULT_ATTRIBUTION,
          });

          const replacedStr = result.replaced > 0 ? ` (replaced ${result.replaced} existing)` : "";
          const riskNote = urlCheck.riskLevel === "suspicious" ? `\n- ⚠ URL risk: ${urlCheck.reason}` : "";
          return {
            content: [{
              type: "text",
              text: `Ingested "${result.title}" from ${result.url}${replacedStr}\n\n` +
                `- Parent ID: ${result.parent_id}\n` +
                `- Chunks stored: ${result.chunks_stored}\n` +
                `- Total characters: ${result.total_chars.toLocaleString()}\n` +
                `- Tier: ${result.tier}\n` +
                (result.description ? `- Description: ${result.description}\n` : "") +
                riskNote,
            }],
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `Ingest error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      }

      // === SOURCE: session ===
      if (args.source === "session") {
        if (!args.transcript_path) {
          return { content: [{ type: "text", text: "transcript_path is required for source: session" }], isError: true };
        }

        try {
          if (!fs.existsSync(args.transcript_path)) {
            return { content: [{ type: "text", text: `Transcript not found: ${args.transcript_path}` }] };
          }

          const result = await digestTranscript(args.transcript_path);

          if (result.actions.length === 0) {
            return { content: [{ type: "text", text: "No actionable tool uses found in transcript." }] };
          }

          const store = new MemoryStore(db);
          const digestExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
          const { memory } = await store.create({
            content: result.summary,
            content_type: "summary",
            source: "mcp",
            importance: 0.5,
            tags: ["session-digest", ...(result.project ? [result.project] : []), ...(args.tags ?? [])],
            expires_at: digestExpiresAt,
          });

          let factsStored = 0;
          for (const fact of result.facts) {
            try {
              await store.create({
                content: fact.text,
                content_type: "text",
                source: "mcp",
                importance: 0.6,
                tags: [
                  "session-fact",
                  fact.type,
                  ...(result.project ? [result.project] : []),
                  ...(args.tags ?? []),
                ],
              });
              factsStored++;
            } catch {
              // Non-critical
            }
          }

          const factStr = factsStored > 0 ? ` + ${factsStored} facts extracted` : "";
          return {
            content: [{
              type: "text",
              text: `Stored session digest (${result.actions.length} actions, project: ${result.project ?? "unknown"})${factStr}.\nID: ${memory.id}`,
            }],
          };
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
      }

      return { content: [{ type: "text", text: `Unknown source: ${args.source}` }], isError: true };
    }
  );

  // memory_research
  server.tool(
    "memory_research",
    "Search the web for a topic and ingest best sources as chunked reference knowledge.",
    {
      topic: z.string().describe("Topic to research"),
      queries: z.array(z.string()).optional().describe("Custom search queries (auto-generated if omitted)"),
      max_sources: z.number().min(1).max(20).optional().describe("Max sources to ingest (default 5)"),
      tags: z.array(z.string()).optional().describe("Tags for all ingested content"),
      importance: z.number().min(0).max(1).optional().describe("Importance score (default 0.6)"),
      tier: z.enum(["working", "episodic", "semantic", "procedural", "reference"]).optional().describe("Knowledge tier (default 'reference')"),
      namespace: z.string().optional().describe("Namespace for organization"),
    },
    async (args) => {
      try {
        const result = await researchTopic(db, {
          topic: args.topic,
          queries: args.queries,
          max_sources: args.max_sources,
          tags: args.tags,
          importance: args.importance,
          tier: args.tier as import("@exocortex/core").MemoryTier | undefined,
          namespace: args.namespace,
          ...DEFAULT_ATTRIBUTION,
        });

        const sourceLines = result.sources.map((s) => {
          if (s.status === "ingested") {
            return `  [OK] ${s.title} (${s.chunks_stored} chunks, ${(s.total_chars ?? 0).toLocaleString()} chars)\n       ${s.url}`;
          } else if (s.status === "skipped") {
            return `  [SKIP] ${s.title} — ${s.error}\n         ${s.url}`;
          } else {
            return `  [FAIL] ${s.title} — ${s.error}\n         ${s.url}`;
          }
        });

        return {
          content: [{
            type: "text",
            text: `Research complete: "${result.topic}"\n\n` +
              `Queries: ${result.queries_run.join(", ")}\n` +
              `Sources found: ${result.sources_found}\n` +
              `Ingested: ${result.sources_ingested} | Failed: ${result.sources_failed} | Skipped: ${result.sources_skipped}\n` +
              `Total: ${result.total_chunks} chunks, ${result.total_chars.toLocaleString()} chars\n\n` +
              `Sources:\n${sourceLines.join("\n")}`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Research error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );
}
