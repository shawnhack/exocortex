import type { Command } from "commander";
import {
  getDb,
  initializeSchema,
  findClusters,
  consolidateCluster,
  generateBasicSummary,
  getConsolidations,
} from "@exocortex/core";

export function registerConsolidate(program: Command): void {
  program
    .command("consolidate")
    .description("Find and consolidate similar memories")
    .option("--dry-run", "Show clusters without consolidating")
    .option("--similarity <threshold>", "Minimum similarity threshold", "0.75")
    .option("--min-size <size>", "Minimum cluster size", "3")
    .option("--history", "Show consolidation history")
    .action(async (opts) => {
      const chalk = (await import("chalk")).default;

      const db = getDb();
      initializeSchema(db);

      if (opts.history) {
        const history = getConsolidations(db);
        if (history.length === 0) {
          console.log(chalk.dim("No consolidations yet."));
          return;
        }

        console.log(chalk.bold("\nConsolidation History\n"));
        for (const c of history) {
          console.log(`  ${chalk.cyan(c.id)}`);
          console.log(`    Strategy: ${c.strategy}`);
          console.log(`    Merged: ${c.memories_merged} memories → ${chalk.green(c.summary_id)}`);
          console.log(`    Date: ${chalk.dim(c.created_at)}\n`);
        }
        return;
      }

      const minSimilarity = parseFloat(opts.similarity);
      const minClusterSize = parseInt(opts.minSize, 10);

      console.log(chalk.bold("\nScanning for similar memory clusters...\n"));

      const clusters = findClusters(db, { minSimilarity, minClusterSize });

      if (clusters.length === 0) {
        console.log(chalk.dim("No clusters found. Try lowering --similarity threshold."));
        return;
      }

      console.log(`Found ${chalk.cyan(String(clusters.length))} cluster(s):\n`);

      for (const cluster of clusters) {
        console.log(`  ${chalk.bold(cluster.topic)}`);
        console.log(`    Members: ${cluster.memberIds.length}`);
        console.log(`    Avg similarity: ${(cluster.avgSimilarity * 100).toFixed(1)}%`);
        console.log();
      }

      if (opts.dryRun) {
        console.log(chalk.yellow("Dry run — no changes made."));
        return;
      }

      let consolidated = 0;
      for (const cluster of clusters) {
        const summary = generateBasicSummary(db, cluster.memberIds);
        consolidateCluster(db, cluster, summary);
        consolidated++;
      }

      console.log(chalk.green(`Consolidated ${consolidated} cluster(s) into summary memories.`));
    });
}
