import type { Command } from "commander";
import { getDb, initializeSchema } from "@exocortex/core";

export function registerReembed(program: Command): void {
  program
    .command("reembed")
    .description("Re-embed memories with a new or updated embedding model")
    .option("--missing", "Only embed memories that lack embeddings (default)")
    .option("--all", "Re-embed ALL memories (use when switching models)")
    .option("--model <name>", "Embedding model name to record (e.g. bge-small-en-v1.5)")
    .option("--batch-size <n>", "Batch size for embedding calls (default 50)", "50")
    .option("--limit <n>", "Max memories to process (default 10000)", "10000")
    .option("--dry-run", "Preview what would be re-embedded without changes")
    .action(async (opts) => {
      const ora = (await import("ora")).default;
      const chalk = (await import("chalk")).default;

      try {
        const db = getDb();
        initializeSchema(db);

        const { reembedMissing, reembedAll, getEmbeddingProvider } =
          await import("@exocortex/core");

        const provider = await getEmbeddingProvider(opts.model);
        const batchSize = parseInt(opts.batchSize, 10);
        const limit = parseInt(opts.limit, 10);
        const dryRun = opts.dryRun === true;

        const mode = opts.all ? "all" : "missing";
        const spinner = ora(
          `Re-embedding ${mode} memories${dryRun ? " (dry run)" : ""}...`
        ).start();

        if (opts.all) {
          const result = await reembedAll(db, provider, {
            dryRun,
            batchSize,
            limit,
            modelName: opts.model ?? `${provider.dimensions()}d`,
          });

          spinner.stop();
          console.log(chalk.bold("\n  Re-embed All Results\n"));
          console.log(`  Processed: ${result.processed}`);
          console.log(`  Failed:    ${result.failed}`);
          console.log(`  Skipped:   ${result.skipped}`);
          if (dryRun) {
            console.log(chalk.yellow("\n  (dry run — no changes made)"));
          }
        } else {
          const result = await reembedMissing(db, provider, {
            dryRun,
            batchSize,
            limit,
          });

          spinner.stop();
          console.log(chalk.bold("\n  Re-embed Missing Results\n"));
          console.log(`  Processed: ${result.processed}`);
          console.log(`  Failed:    ${result.failed}`);
          console.log(`  Skipped:   ${result.skipped}`);
          if (dryRun) {
            console.log(chalk.yellow("\n  (dry run — no changes made)"));
          }
        }
        console.log();
      } catch (err) {
        console.error(
          `Error: ${err instanceof Error ? err.message : String(err)}`
        );
        process.exit(1);
      }
    });
}
