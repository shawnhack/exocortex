import type { Command } from "commander";
import { readFileSync } from "node:fs";
import {
  getDb,
  initializeSchema,
  decryptBackup,
  verifyBackup,
} from "@exocortex/core";
import type { BackupData } from "@exocortex/core";

export function registerVerifyBackup(program: Command): void {
  program
    .command("verify-backup <file>")
    .description("Verify integrity of a backup file against the current database")
    .option("-d, --decrypt", "Decrypt an encrypted backup (.enc file)")
    .option("--check-embeddings", "Sample memories and verify non-empty content")
    .option("--sample-size <n>", "Number of memories to sample for embedding check", "10")
    .action(async (file, opts) => {
      const chalk = (await import("chalk")).default;

      const db = getDb();
      initializeSchema(db);

      console.log(chalk.bold("\nVerifying backup...\n"));

      let data: BackupData;
      try {
        const raw = readFileSync(file);
        if (opts.decrypt || file.endsWith(".enc")) {
          const { createInterface } = await import("node:readline");
          const rl = createInterface({ input: process.stdin, output: process.stderr });
          const password = await new Promise<string>((resolve) => {
            rl.question("  Enter decryption password: ", (answer) => {
              rl.close();
              resolve(answer);
            });
          });
          data = decryptBackup(raw, password);
        } else {
          data = JSON.parse(raw.toString("utf-8"));
        }
      } catch (err) {
        console.error(chalk.red(`  Failed to read backup: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }

      const result = verifyBackup(db, data, {
        checkEmbeddings: opts.checkEmbeddings,
        sampleSize: parseInt(opts.sampleSize, 10),
      });

      console.log("  Table Counts:\n");
      console.log("  " + "Table".padEnd(22) + "Backup".padEnd(10) + "Imported".padEnd(10) + "Source".padEnd(10) + "Status");
      console.log("  " + "-".repeat(62));
      for (const row of result.counts) {
        const status = row.backup === row.imported ? chalk.green("ok") : chalk.red("MISMATCH");
        console.log(
          "  " +
          row.table.padEnd(22) +
          String(row.backup).padEnd(10) +
          String(row.imported).padEnd(10) +
          String(row.source).padEnd(10) +
          status
        );
      }

      if (result.discrepancies.length > 0) {
        console.log(chalk.yellow("\n  Discrepancies:"));
        for (const d of result.discrepancies) {
          console.log(chalk.yellow(`    - ${d}`));
        }
      }

      if (result.embeddingCheck) {
        console.log(`\n  Embedding check: ${result.embeddingCheck.withContent}/${result.embeddingCheck.sampled} samples have content`);
      }

      if (result.valid) {
        console.log(chalk.green("\n  Backup is valid\n"));
      } else {
        console.log(chalk.red("\n  Backup has issues\n"));
        process.exit(1);
      }
    });
}
