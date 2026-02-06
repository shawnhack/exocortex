import type { Command } from "commander";
import { writeFileSync } from "node:fs";
import {
  getDb,
  initializeSchema,
  exportData,
  encryptBackup,
} from "@exocortex/core";

export function registerExport(program: Command): void {
  program
    .command("export")
    .description("Export all memories to a backup file")
    .option("-o, --output <path>", "Output file path", "exocortex-backup.json")
    .option("-e, --encrypt", "Encrypt the backup with a password")
    .action(async (opts) => {
      const chalk = (await import("chalk")).default;

      const db = getDb();
      initializeSchema(db);

      console.log(chalk.bold("\nExporting Exocortex data...\n"));

      const data = exportData(db);
      console.log(`  Memories: ${chalk.cyan(String(data.memories.length))}`);
      console.log(`  Entities: ${chalk.cyan(String(data.entities.length))}`);
      console.log(`  Entity links: ${chalk.cyan(String(data.memory_entities.length))}`);

      if (opts.encrypt) {
        const { createInterface } = await import("node:readline");
        const rl = createInterface({ input: process.stdin, output: process.stderr });

        const password = await new Promise<string>((resolve) => {
          rl.question("\n  Enter encryption password: ", (answer) => {
            rl.close();
            resolve(answer);
          });
        });

        if (!password || password.length < 8) {
          console.error(chalk.red("\n  Password must be at least 8 characters."));
          process.exit(1);
        }

        const encrypted = encryptBackup(data, password);
        const outputPath = opts.output.replace(/\.json$/, ".enc");
        writeFileSync(outputPath, encrypted);
        console.log(chalk.green(`\n  Encrypted backup saved to ${chalk.bold(outputPath)}`));
        console.log(chalk.dim(`  Size: ${(encrypted.length / 1024).toFixed(1)} KB`));
      } else {
        const json = JSON.stringify(data, null, 2);
        writeFileSync(opts.output, json, "utf-8");
        console.log(chalk.green(`\n  Backup saved to ${chalk.bold(opts.output)}`));
        console.log(chalk.dim(`  Size: ${(json.length / 1024).toFixed(1)} KB`));
      }

      console.log();
    });
}
