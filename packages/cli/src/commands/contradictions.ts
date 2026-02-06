import type { Command } from "commander";
import {
  getDb,
  initializeSchema,
  getContradictions,
  updateContradiction,
  detectContradictions,
  recordContradiction,
} from "@exocortex/core";

export function registerContradictions(program: Command): void {
  program
    .command("contradictions")
    .description("View and manage detected contradictions")
    .option("--status <status>", "Filter by status (pending/resolved/dismissed)")
    .option("--detect", "Run contradiction detection now")
    .option("--resolve <id>", "Resolve a contradiction by ID")
    .option("--dismiss <id>", "Dismiss a contradiction by ID")
    .action(async (opts) => {
      const chalk = (await import("chalk")).default;

      const db = getDb();
      initializeSchema(db);

      if (opts.detect) {
        console.log(chalk.bold("\nScanning for contradictions...\n"));

        const candidates = detectContradictions(db);

        if (candidates.length === 0) {
          console.log(chalk.dim("No contradictions detected."));
          return;
        }

        for (const candidate of candidates) {
          const recorded = recordContradiction(db, candidate);
          console.log(`  ${chalk.yellow("!")} ${chalk.dim(recorded.id)}`);
          console.log(`    Memory A: ${candidate.memory_a_id}`);
          console.log(`    Memory B: ${candidate.memory_b_id}`);
          console.log(`    Similarity: ${(candidate.similarity * 100).toFixed(1)}%`);
          console.log(`    Reason: ${candidate.reason}\n`);
        }

        console.log(chalk.cyan(`Detected ${candidates.length} contradiction(s).`));
        return;
      }

      if (opts.resolve) {
        const updated = updateContradiction(db, opts.resolve, {
          status: "resolved",
          resolution: "Resolved via CLI",
        });
        if (!updated) {
          console.error(chalk.red(`Contradiction not found: ${opts.resolve}`));
          process.exit(1);
        }
        console.log(chalk.green(`Resolved contradiction ${opts.resolve}`));
        return;
      }

      if (opts.dismiss) {
        const updated = updateContradiction(db, opts.dismiss, { status: "dismissed" });
        if (!updated) {
          console.error(chalk.red(`Contradiction not found: ${opts.dismiss}`));
          process.exit(1);
        }
        console.log(chalk.yellow(`Dismissed contradiction ${opts.dismiss}`));
        return;
      }

      // List contradictions
      const status = opts.status as "pending" | "resolved" | "dismissed" | undefined;
      const contradictions = getContradictions(db, status);

      if (contradictions.length === 0) {
        console.log(chalk.dim("\nNo contradictions found." + (status ? ` (filter: ${status})` : "")));
        return;
      }

      console.log(chalk.bold(`\nContradictions${status ? ` (${status})` : ""}: ${contradictions.length}\n`));

      const statusColors: Record<string, (s: string) => string> = {
        pending: chalk.yellow,
        resolved: chalk.green,
        dismissed: chalk.dim,
      };

      for (const c of contradictions) {
        const colorFn = statusColors[c.status] ?? chalk.white;
        console.log(`  ${chalk.dim(c.id)} [${colorFn(c.status)}]`);
        console.log(`    Memory A: ${c.memory_a_id}`);
        console.log(`    Memory B: ${c.memory_b_id}`);
        console.log(`    ${c.description}`);
        if (c.resolution) {
          console.log(`    Resolution: ${chalk.green(c.resolution)}`);
        }
        console.log();
      }
    });
}
