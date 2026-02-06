import type { Command } from "commander";
import {
  getDb,
  initializeSchema,
  MemorySearch,
  MemoryStore,
} from "@exocortex/core";

export function registerSearch(program: Command): void {
  program
    .command("search <query>")
    .description("Search memories using hybrid retrieval")
    .option("-l, --limit <n>", "Max results", "10")
    .option("--after <date>", "Only after this date (YYYY-MM-DD)")
    .option("--before <date>", "Only before this date (YYYY-MM-DD)")
    .option("-t, --tags <tags>", "Filter by tags (comma-separated)")
    .option("--type <type>", "Filter by content type")
    .option("-v, --verbose", "Show score breakdown")
    .action(async (query: string, opts) => {
      const ora = (await import("ora")).default;
      const chalk = (await import("chalk")).default;

      const spinner = ora("Searching...").start();

      try {
        const db = getDb();
        initializeSchema(db);
        const search = new MemorySearch(db);
        const store = new MemoryStore(db);

        const results = await search.search({
          query,
          limit: parseInt(opts.limit, 10),
          after: opts.after,
          before: opts.before,
          tags: opts.tags
            ? opts.tags.split(",").map((t: string) => t.trim())
            : undefined,
          content_type: opts.type,
        });

        spinner.stop();

        if (results.length === 0) {
          console.log(chalk.yellow("No results found."));
          return;
        }

        console.log(
          chalk.bold(`\n${results.length} result${results.length > 1 ? "s" : ""}:\n`)
        );

        for (const r of results) {
          // Record access
          await store.recordAccess(r.memory.id, query);

          const preview =
            r.memory.content.length > 120
              ? r.memory.content.substring(0, 120) + "..."
              : r.memory.content;

          console.log(
            `  ${chalk.cyan(r.memory.id.slice(0, 10))}  ${chalk.dim(
              `[${r.score.toFixed(3)}]`
            )}  ${preview}`
          );

          if (r.memory.tags?.length) {
            console.log(
              `    ${chalk.dim("tags:")} ${r.memory.tags.join(", ")}`
            );
          }

          if (opts.verbose) {
            console.log(
              `    ${chalk.dim("vec:")} ${r.vector_score.toFixed(3)}  ${chalk.dim(
                "fts:"
              )} ${r.fts_score.toFixed(3)}  ${chalk.dim(
                "rec:"
              )} ${r.recency_score.toFixed(3)}  ${chalk.dim(
                "freq:"
              )} ${r.frequency_score.toFixed(3)}`
            );
          }

          console.log();
        }
      } catch (err) {
        spinner.fail(
          `Search failed: ${err instanceof Error ? err.message : String(err)}`
        );
        process.exit(1);
      }
    });
}
