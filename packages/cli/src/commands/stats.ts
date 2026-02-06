import type { Command } from "commander";
import { getDb, initializeSchema, MemoryStore } from "@exocortex/core";

export function registerStats(program: Command): void {
  program
    .command("stats")
    .description("Show memory statistics")
    .action(async () => {
      const chalk = (await import("chalk")).default;

      const db = getDb();
      initializeSchema(db);
      const store = new MemoryStore(db);
      const stats = await store.getStats();

      console.log(chalk.bold("\nExocortex Stats\n"));
      console.log(`  Total memories:  ${chalk.cyan(String(stats.total_memories))}`);
      console.log(`  Active:          ${chalk.green(String(stats.active_memories))}`);
      console.log(`  Entities:        ${String(stats.total_entities)}`);
      console.log(`  Tags:            ${String(stats.total_tags)}`);

      if (Object.keys(stats.by_content_type).length > 0) {
        console.log(chalk.bold("\n  By Type:"));
        for (const [type, count] of Object.entries(stats.by_content_type)) {
          console.log(`    ${type}: ${count}`);
        }
      }

      if (Object.keys(stats.by_source).length > 0) {
        console.log(chalk.bold("\n  By Source:"));
        for (const [source, count] of Object.entries(stats.by_source)) {
          console.log(`    ${source}: ${count}`);
        }
      }

      if (stats.oldest_memory) {
        console.log(`\n  Oldest: ${chalk.dim(stats.oldest_memory)}`);
      }
      if (stats.newest_memory) {
        console.log(`  Newest: ${chalk.dim(stats.newest_memory)}`);
      }

      console.log();
    });
}
