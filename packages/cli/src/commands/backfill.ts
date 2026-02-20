import type { Command } from "commander";
import {
  getDb,
  initializeSchema,
  backfillMemoryCanonicalization,
} from "@exocortex/core";

export function registerBackfill(program: Command): void {
  program
    .command("backfill")
    .description("Backfill canonical memory state (content hashes, normalized tags, metadata flag)")
    .option("--dry-run", "Report changes without writing")
    .option("--limit <n>", "Max memories to scan", "10000")
    .action(async (opts) => {
      const ora = (await import("ora")).default;
      const chalk = (await import("chalk")).default;
      const spinner = ora("Running canonical backfill...").start();

      try {
        const db = getDb();
        initializeSchema(db);

        const result = backfillMemoryCanonicalization(db, {
          dryRun: opts.dryRun === true,
          limit: parseInt(opts.limit, 10),
        });

        spinner.stop();
        const mode = result.dry_run ? chalk.blue("dry-run") : chalk.green("applied");
        console.log(chalk.bold(`\nBackfill (${mode})\n`));
        console.log(`  scanned: ${result.scanned}`);
        console.log(`  hashes updated: ${result.hashesUpdated}`);
        console.log(`  tags normalized: ${result.tagsUpdated}`);
        console.log(`  metadata flag updated: ${result.metadataFlagUpdated}`);
        console.log();
      } catch (err) {
        spinner.fail(
          `Backfill failed: ${err instanceof Error ? err.message : String(err)}`
        );
        process.exit(1);
      }
    });
}

