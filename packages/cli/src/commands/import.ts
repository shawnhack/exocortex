import type { Command } from "commander";
import fs from "node:fs";
import {
  getDb,
  initializeSchema,
  MemoryStore,
  decryptBackup,
  importData,
} from "@exocortex/core";

interface JsonMemory {
  content: string;
  content_type?: string;
  source?: string;
  source_uri?: string;
  importance?: number;
  tags?: string[];
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
      "File format: json|markdown|chatexport",
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

          console.log(chalk.bold("\nImporting structured Exocortex backup...\n"));
          if (parsed.exported_at) {
            console.log(`  Backup date: ${chalk.dim(parsed.exported_at)}`);
          }
          console.log(`  Memories: ${parsed.memories.length}`);
          console.log(`  Entities: ${parsed.entities.length}`);
          if (Array.isArray((parsed as any).goals)) {
            console.log(`  Goals: ${(parsed as any).goals.length}`);
          }

          if (opts.dryRun) {
            console.log(chalk.yellow("\n  Dry run — no changes made."));
            return;
          }

          const result = importData(db, parsed);
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
      } else if (opts.format === "chatexport") {
        // Simple chat export: each message block separated by blank lines
        const blocks = raw.split(/\n\n+/).filter(Boolean);
        items = blocks.map((content) => ({
          content: content.trim(),
          content_type: "conversation",
        }));
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
            source_uri: file,
            importance: item.importance,
            tags: item.tags,
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
