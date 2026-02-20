import type { Command } from "commander";
import {
  getDb,
  initializeSchema,
  MemoryStore,
} from "@exocortex/core";
import type { MemorySource } from "@exocortex/core";

export function registerAdd(program: Command): void {
  program
    .command("add <content>")
    .description("Add a new memory")
    .option("-t, --tags <tags>", "Comma-separated tags")
    .option("-i, --importance <n>", "Importance 0-1", parseFloat)
    .option(
      "--type <type>",
      "Content type: text|conversation|note|summary",
      "text"
    )
    .option("--source <source>", "Source: manual|cli|api|mcp|import", "cli")
    .option("--metadata", "Mark memory as metadata/system artifact")
    .option("--benchmark", "Store as benchmark artifact (low importance, reduced indexing)")
    .action(async (content: string, opts) => {
      const ora = (await import("ora")).default;
      const chalk = (await import("chalk")).default;

      const spinner = ora("Storing memory...").start();

      try {
        const db = getDb();
        initializeSchema(db);
        const store = new MemoryStore(db);

        const result = await store.create({
          content,
          content_type: opts.type,
          source: opts.source as MemorySource,
          importance: opts.importance,
          tags: opts.tags
            ? opts.tags.split(",").map((t: string) => t.trim())
            : undefined,
          is_metadata: opts.metadata === true,
          benchmark: opts.benchmark === true,
        });
        const { memory } = result;

        spinner.succeed(chalk.green("Memory stored"));
        console.log(`  ID: ${chalk.cyan(memory.id)}`);
        console.log(`  Type: ${memory.content_type}`);
        if (memory.tags?.length) {
          console.log(`  Tags: ${memory.tags.join(", ")}`);
        }
        if (result.dedup_action === "skipped" && result.superseded_id) {
          console.log(
            `  Dedup: reused ${chalk.cyan(result.superseded_id)} (${Math.round(
              (result.dedup_similarity ?? 0) * 100
            )}% similar)`
          );
        }
        console.log(
          `  Embedding: ${memory.embedding ? "yes" : chalk.yellow("pending")}`
        );
      } catch (err) {
        spinner.fail(
          `Failed: ${err instanceof Error ? err.message : String(err)}`
        );
        process.exit(1);
      }
    });
}
