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

      console.log(
        `Found ${chalk.bold(String(items.length))} memories to import.`
      );

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
