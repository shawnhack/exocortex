import type { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import {
  getDb,
  initializeSchema,
  MemoryStore,
  decryptBackup,
  importData,
} from "@exocortex/core";
import type { BackupData } from "@exocortex/core";

interface JsonMemory {
  content: string;
  content_type?: string;
  source?: string;
  source_uri?: string;
  provider?: string;
  model_id?: string;
  model_name?: string;
  agent?: string;
  session_id?: string;
  conversation_id?: string;
  metadata?: Record<string, unknown>;
  importance?: number;
  tags?: string[];
  tier?: string;
}

function isBackupData(value: unknown): value is {
  version: 1;
  exported_at?: string;
  memories: unknown[];
  entities: unknown[];
  memory_entities: unknown[];
  settings: Record<string, string>;
} {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    Array.isArray(v.memories) &&
    Array.isArray(v.entities) &&
    Array.isArray(v.memory_entities) &&
    typeof v.settings === "object" &&
    v.settings !== null
  );
}

export function registerImport(program: Command): void {
  program
    .command("import <file>")
    .description("Import memories from a file")
    .option(
      "-f, --format <format>",
      "File format: json|markdown|chatexport|chatgpt|claude|obsidian",
      "json"
    )
    .option("--dry-run", "Preview without importing")
    .option("-d, --decrypt", "Decrypt an encrypted backup file")
    .action(async (file: string, opts) => {
      const ora = (await import("ora")).default;
      const chalk = (await import("chalk")).default;

      if (!fs.existsSync(file)) {
        console.error(chalk.red(`File not found: ${file}`));
        process.exit(1);
      }

      // Handle encrypted backup restore
      if (opts.decrypt || file.endsWith(".enc")) {
        const db = getDb();
        initializeSchema(db);

        const encrypted = fs.readFileSync(file);
        const { createInterface } = await import("node:readline");
        const rl = createInterface({ input: process.stdin, output: process.stderr });

        const password = await new Promise<string>((resolve) => {
          rl.question("Enter decryption password: ", (answer) => {
            rl.close();
            resolve(answer);
          });
        });

        try {
          const data = decryptBackup(encrypted, password);
          console.log(chalk.bold("\nRestoring from encrypted backup...\n"));
          console.log(`  Backup date: ${chalk.dim(data.exported_at)}`);
          console.log(`  Memories: ${data.memories.length}`);
          console.log(`  Entities: ${data.entities.length}`);

          if (opts.dryRun) {
            console.log(chalk.yellow("\n  Dry run — no changes made."));
            return;
          }

          const result = importData(db, data);
          console.log(chalk.green(`\n  Restored: ${result.memories} memories, ${result.entities} entities, ${result.links} links`));
        } catch (err: any) {
          console.error(chalk.red(`\n  Decryption failed: ${err.message}`));
          process.exit(1);
        }
        return;
      }

      const raw = fs.readFileSync(file, "utf-8");
      let items: JsonMemory[] = [];

      if (opts.format === "json") {
        const parsed = JSON.parse(raw);

        if (isBackupData(parsed)) {
          const db = getDb();
          initializeSchema(db);
          const backup: BackupData = {
            ...(parsed as Omit<BackupData, "exported_at">),
            exported_at: parsed.exported_at ?? new Date().toISOString(),
          };

          console.log(chalk.bold("\nImporting structured Exocortex backup...\n"));
          if (backup.exported_at) {
            console.log(`  Backup date: ${chalk.dim(backup.exported_at)}`);
          }
          console.log(`  Memories: ${backup.memories.length}`);
          console.log(`  Entities: ${backup.entities.length}`);
          if (Array.isArray((backup as any).goals)) {
            console.log(`  Goals: ${(backup as any).goals.length}`);
          }

          if (opts.dryRun) {
            console.log(chalk.yellow("\n  Dry run — no changes made."));
            return;
          }

          const result = importData(db, backup);
          console.log(
            chalk.green(
              `\n  Restored: ${result.memories} memories, ${result.entities} entities, ${result.links} links`
            )
          );
          return;
        }

        items = Array.isArray(parsed) ? parsed : [parsed];
      } else if (opts.format === "markdown") {
        // Split markdown by ## headers or --- separators
        const sections = raw
          .split(/^(?:## .+|---)$/m)
          .map((s) => s.trim())
          .filter(Boolean);
        items = sections.map((content) => ({ content }));
      } else if (opts.format === "chatgpt") {
        // ChatGPT conversations.json export
        const parsed = JSON.parse(raw);
        const conversations = Array.isArray(parsed) ? parsed : [parsed];
        for (const conv of conversations) {
          const title = conv.title ?? "Untitled";
          const created = conv.create_time
            ? new Date(conv.create_time * 1000).toISOString()
            : undefined;

          // Walk the message tree
          const mapping = conv.mapping ?? {};
          const messages: string[] = [];
          for (const node of Object.values(mapping) as any[]) {
            const msg = node?.message;
            if (!msg || !msg.content?.parts) continue;
            const role = msg.author?.role;
            if (role !== "user" && role !== "assistant") continue;
            const text = msg.content.parts
              .filter((p: unknown) => typeof p === "string")
              .join("\n")
              .trim();
            if (text) {
              messages.push(`**${role === "user" ? "User" : "Assistant"}**: ${text}`);
            }
          }

          if (messages.length > 0) {
            const content = `# ${title}\n\n${messages.join("\n\n")}`;
            const topicTags = extractTopicTags(content);
            items.push({
              content,
              content_type: "conversation",
              source: "chatgpt",
              tags: ["imported", "chatgpt", ...topicTags],
              metadata: created ? { original_date: created } : undefined,
              importance: messages.length > 10 ? 0.7 : 0.5,
            });
          }
        }
      } else if (opts.format === "claude") {
        // Claude conversation export (JSON array of conversations)
        const parsed = JSON.parse(raw);
        const conversations = Array.isArray(parsed) ? parsed : [parsed];
        for (const conv of conversations) {
          const title = conv.name ?? conv.title ?? "Untitled";
          const created = conv.created_at ?? conv.updated_at;

          const messages: string[] = [];
          const chatMessages = conv.chat_messages ?? conv.messages ?? [];
          for (const msg of chatMessages) {
            const role = msg.sender ?? msg.role;
            if (role !== "human" && role !== "assistant") continue;
            const text = typeof msg.text === "string"
              ? msg.text
              : Array.isArray(msg.content)
                ? msg.content
                    .filter((c: any) => c.type === "text")
                    .map((c: any) => c.text)
                    .join("\n")
                : typeof msg.content === "string"
                  ? msg.content
                  : "";
            if (text.trim()) {
              messages.push(
                `**${role === "human" ? "User" : "Assistant"}**: ${text.trim()}`
              );
            }
          }

          if (messages.length > 0) {
            const content = `# ${title}\n\n${messages.join("\n\n")}`;
            const topicTags = extractTopicTags(content);
            items.push({
              content,
              content_type: "conversation",
              source: "claude",
              tags: ["imported", "claude", ...topicTags],
              metadata: created ? { original_date: created } : undefined,
              importance: messages.length > 10 ? 0.7 : 0.5,
            });
          }
        }
      } else if (opts.format === "chatexport") {
        // Simple chat export: each message block separated by blank lines
        const blocks = raw.split(/\n\n+/).filter(Boolean);
        items = blocks.map((content) => ({
          content: content.trim(),
          content_type: "conversation",
        }));
      } else if (opts.format === "obsidian") {
        // Obsidian vault import — walks directory tree, parses YAML frontmatter and wikilinks
        const vaultPath = path.resolve(file);
        if (!fs.statSync(vaultPath).isDirectory()) {
          console.error(chalk.red("Obsidian format requires a vault directory path, not a file."));
          process.exit(1);
        }

        const mdFiles = walkVault(vaultPath);
        console.log(chalk.dim(`Found ${mdFiles.length} markdown files in vault`));

        let skipped = 0;
        for (const mdFile of mdFiles) {
          let content: string;
          try {
            content = fs.readFileSync(mdFile, "utf-8");
          } catch {
            skipped++;
            continue; // skip non-UTF-8 or unreadable files
          }
          const relPath = path.relative(vaultPath, mdFile).replace(/\\/g, "/");

          // Parse YAML frontmatter
          const { frontmatter, body } = parseFrontmatter(content);
          if (!body.trim()) continue;

          // Derive tags from frontmatter + folder path
          const tags = new Set<string>(["imported", "obsidian"]);
          if (frontmatter.tags) {
            const fmTags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [frontmatter.tags];
            for (const t of fmTags) {
              if (typeof t === "string") tags.add(t.replace(/^#/, "").toLowerCase());
            }
          }
          // Add folder path as tags (e.g., "Projects/Alpha" → "projects", "alpha")
          const folders = path.dirname(relPath).split("/").filter(f => f !== ".");
          for (const folder of folders) {
            const tag = folder.toLowerCase().replace(/\s+/g, "-");
            if (tag && tag !== ".") tags.add(tag);
          }

          // Resolve wikilinks to plain text
          const resolved = body.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target, alias) => alias ?? target);

          // Determine tier from folder structure
          const tier = inferTier(relPath, frontmatter);

          items.push({
            content: resolved,
            content_type: frontmatter.type === "note" ? "note" : "text",
            source: "import",
            source_uri: `obsidian://${relPath}`,
            tags: Array.from(tags),
            importance: typeof frontmatter.importance === "number" ? frontmatter.importance : undefined,
            tier,
            metadata: {
              obsidian_path: relPath,
              frontmatter: Object.keys(frontmatter).length > 0 ? frontmatter : undefined,
            },
          });
        }
        if (skipped > 0) {
          console.log(chalk.yellow(`Skipped ${skipped} unreadable file(s) (non-UTF-8 or binary)`));
        }
      }

      const normalized: JsonMemory[] = [];
      let invalid = 0;
      for (const item of items) {
        if (
          item &&
          typeof item.content === "string" &&
          item.content.trim().length > 0
        ) {
          normalized.push(item);
        } else {
          invalid++;
        }
      }
      items = normalized;

      console.log(
        `Found ${chalk.bold(String(items.length))} memories to import.`
      );
      if (invalid > 0) {
        console.log(
          chalk.yellow(
            `Skipped ${invalid} invalid item(s) with missing or empty content.`
          )
        );
      }

      if (opts.dryRun) {
        for (const item of items.slice(0, 5)) {
          const preview =
            item.content.length > 100
              ? item.content.substring(0, 100) + "..."
              : item.content;
          console.log(`  ${chalk.dim("•")} ${preview}`);
        }
        if (items.length > 5) {
          console.log(chalk.dim(`  ... and ${items.length - 5} more`));
        }
        return;
      }

      const spinner = ora("Importing...").start();
      const db = getDb();
      initializeSchema(db);
      const store = new MemoryStore(db);

      let imported = 0;
      let failed = 0;

      for (const item of items) {
        try {
          await store.create({
            content: item.content,
            content_type: (item.content_type as any) ?? "text",
            source: "import",
            source_uri: item.source_uri ?? file,
            provider: item.provider,
            model_id: item.model_id,
            model_name: item.model_name,
            agent: item.agent,
            session_id: item.session_id,
            conversation_id: item.conversation_id,
            metadata: item.metadata,
            importance: item.importance,
            tags: item.tags,
            tier: (item.tier as any) ?? undefined,
          });
          imported++;
          spinner.text = `Importing... ${imported}/${items.length}`;
        } catch {
          failed++;
        }
      }

      spinner.succeed(
        `Imported ${chalk.green(String(imported))} memories` +
          (failed > 0 ? ` (${chalk.red(String(failed))} failed)` : "")
      );
    });
}

// --- Obsidian vault import helpers ---

/** Recursively walk a directory and return all .md file paths (skips .obsidian/) */
function walkVault(dir: string, depth = 0, maxDepth = 20): string[] {
  if (depth > maxDepth) return []; // prevent stack overflow on deep/cyclic vaults
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue; // skip .obsidian, .trash, etc.
    if (entry.isSymbolicLink()) continue; // skip symlinks before type checks (prevents loops)
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkVault(fullPath, depth + 1, maxDepth));
    } else if (entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }
  return results;
}

/** Parse YAML frontmatter from markdown content */
function parseFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } {
  // Strip UTF-8 BOM — common on Windows files, breaks the ^ anchor
  const cleaned = content.replace(/^\uFEFF/, "");
  const match = cleaned.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: cleaned };

  const yamlBlock = match[1];
  const body = match[2];
  const frontmatter: Record<string, any> = {};
  const lines = yamlBlock.split("\n");

  // Simple YAML parser for common frontmatter fields (avoids adding a dep)
  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  for (const line of lines) {
    // Block-list item: "  - value" (belongs to the current key)
    const listItemMatch = line.match(/^\s+-\s+(.+)$/);
    if (listItemMatch && currentKey && currentList) {
      currentList.push(listItemMatch[1].trim().replace(/^["']|["']$/g, ""));
      continue;
    }

    // If we were collecting a block-list, flush it
    if (currentKey && currentList) {
      frontmatter[currentKey] = currentList;
      currentKey = null;
      currentList = null;
    }

    // Key with no value (start of block-list): "tags:"
    const bareKeyMatch = line.match(/^(\w[\w-]*)\s*:\s*$/);
    if (bareKeyMatch) {
      currentKey = bareKeyMatch[1];
      currentList = [];
      continue;
    }

    // Key-value pair: "key: value"
    const kvMatch = line.match(/^(\w[\w-]*)\s*:\s*(.+)$/);
    if (!kvMatch) continue;
    const [, key, rawVal] = kvMatch;
    let value: any = rawVal.trim();

    // Parse inline arrays: [a, b, c]
    if (value.startsWith("[") && value.endsWith("]")) {
      value = value.slice(1, -1).split(",").map((s: string) => s.trim().replace(/^["']|["']$/g, ""));
    }
    // Parse numbers
    else if (/^\d+(\.\d+)?$/.test(value)) {
      value = parseFloat(value);
    }
    // Parse booleans
    else if (value === "true") value = true;
    else if (value === "false") value = false;
    // Strip quotes
    else value = value.replace(/^["']|["']$/g, "");

    frontmatter[key] = value;
  }

  // Flush any trailing block-list
  if (currentKey && currentList) {
    frontmatter[currentKey] = currentList;
  }

  return { frontmatter, body };
}

/**
 * Extract topic tags from conversation content using keyword detection.
 * Scans for common technology, domain, and activity terms.
 */
function extractTopicTags(content: string): string[] {
  const lower = content.toLowerCase();
  const tags = new Set<string>();

  const TOPIC_KEYWORDS: Record<string, string[]> = {
    coding: ["function", "variable", "class ", "import ", "export ", "const ", "async ", "await "],
    debugging: ["error", "bug", "fix", "stack trace", "exception", "crash"],
    architecture: ["architecture", "design pattern", "microservice", "monolith", "api design"],
    database: ["database", "sql", "query", "migration", "schema", "postgres", "sqlite", "mongodb"],
    devops: ["docker", "kubernetes", "deploy", "ci/cd", "pipeline", "terraform"],
    frontend: ["react", "css", "component", "ui ", "ux ", "tailwind", "html"],
    backend: ["server", "endpoint", "middleware", "route", "api"],
    testing: ["test", "jest", "vitest", "coverage", "assertion", "mock"],
    ai: ["llm", "claude", "gpt", "prompt", "embedding", "model", "anthropic", "openai"],
    security: ["auth", "token", "password", "encrypt", "vulnerability", "cors"],
    performance: ["optimize", "performance", "latency", "cache", "benchmark"],
  };

  for (const [tag, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) {
      tags.add(tag);
    }
  }

  // Cap at 5 topic tags to avoid noise
  return Array.from(tags).slice(0, 5);
}

/** Infer memory tier from Obsidian vault path and frontmatter */
function inferTier(relPath: string, frontmatter: Record<string, any>): string {
  if (frontmatter.tier) return frontmatter.tier;

  const lower = relPath.toLowerCase();
  if (lower.includes("reference") || lower.includes("docs")) return "reference";
  if (lower.includes("technique") || lower.includes("how-to")) return "procedural";
  if (lower.includes("daily") || lower.includes("journal")) return "episodic";
  if (lower.includes("knowledge") || lower.includes("concept")) return "semantic";
  return "episodic";
}
