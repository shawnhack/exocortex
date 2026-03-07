import type { Command } from "commander";
import {
  getDb,
  initializeSchema,
  exportToObsidian,
} from "@exocortex/core";

export function registerObsidianExport(program: Command): void {
  program
    .command("obsidian-export")
    .description("Export curated knowledge as an Obsidian vault")
    .requiredOption("--vault <path>", "Path to Obsidian vault directory")
    .option("--clean", "Wipe vault contents before exporting (preserves .obsidian config)")
    .action(async (opts) => {
      const chalk = (await import("chalk")).default;

      const db = getDb();
      initializeSchema(db);

      console.log(chalk.bold("\nExporting to Obsidian vault...\n"));

      const result = await exportToObsidian(db, {
        vaultPath: opts.vault,
        clean: opts.clean ?? false,
      });

      for (const [section, count] of Object.entries(result.sections)) {
        const label = section.charAt(0).toUpperCase() + section.slice(1);
        console.log(`  ${label.padEnd(16)} ${chalk.cyan(String(count))}`);
      }
      console.log(`  ${"Total files".padEnd(16)} ${chalk.cyan(String(result.files))}`);
      console.log(chalk.green(`\n  Vault: ${chalk.bold(opts.vault)}\n`));
    });
}
