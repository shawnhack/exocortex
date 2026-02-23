import type { Command } from "commander";
import {
  getDb,
  initializeSchema,
  exportToObsidian,
} from "@exocortex/core";

export function registerObsidianExport(program: Command): void {
  program
    .command("obsidian-export")
    .description("Export memories, entities, and goals as an Obsidian vault")
    .requiredOption("--vault <path>", "Path to Obsidian vault directory")
    .option("--full", "Full export (ignore incremental state)")
    .action(async (opts) => {
      const chalk = (await import("chalk")).default;

      const db = getDb();
      initializeSchema(db);

      console.log(chalk.bold("\nExporting to Obsidian vault...\n"));

      const result = await exportToObsidian(db, {
        vaultPath: opts.vault,
        fullExport: opts.full ?? false,
      });

      console.log(`  Memories:       ${chalk.cyan(String(result.memoriesExported))}`);
      console.log(`  Entities:       ${chalk.cyan(String(result.entitiesExported))}`);
      console.log(`  Goals:          ${chalk.cyan(String(result.goalsExported))}`);
      console.log(`  Contradictions: ${chalk.cyan(String(result.contradictionsExported))}`);
      console.log(`  Dashboard:      ${chalk.cyan(result.dashboardUpdated ? "updated" : "skipped")}`);
      console.log(chalk.green(`\n  Vault: ${chalk.bold(opts.vault)}\n`));
    });
}
