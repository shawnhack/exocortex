import type { Command } from "commander";
import {
  getDb,
  initializeSchema,
} from "@exocortex/core";

export function registerOptimize(program: Command): void {
  program
    .command("optimize")
    .description(
      "Auto-optimize retrieval scoring weights via coordinate descent on real usage data"
    )
    .option("--max-cycles <n>", "Max optimization cycles (default 3)", "3")
    .option("--step-size <n>", "Weight step size (default 0.05)", "0.05")
    .option(
      "--min-queries <n>",
      "Min benchmark queries needed (default 10)",
      "10"
    )
    .option("--top-k <n>", "NDCG evaluation depth (default 10)", "10")
    .option("--max-queries <n>", "Max benchmark queries (default 50)", "50")
    .option("--dry-run", "Preview results without persisting weights")
    .option("--info", "Show benchmark data stats without optimizing")
    .option("--json", "JSON output")
    .action(async (opts) => {
      const ora = (await import("ora")).default;
      const chalk = (await import("chalk")).default;

      try {
        const db = getDb();
        initializeSchema(db);

        // Lazy import to avoid loading optimizer on every CLI invocation
        const { optimizeRetrieval, mineBenchmarkQueries } = await import(
          "@exocortex/core"
        );

        if (opts.info) {
          const benchmarks = mineBenchmarkQueries(db);
          const totalJudgments = benchmarks.reduce(
            (s: number, b: { relevantIds: Map<string, number> }) =>
              s + b.relevantIds.size,
            0
          );

          if (opts.json) {
            console.log(
              JSON.stringify(
                {
                  queries: benchmarks.length,
                  judgments: totalJudgments,
                  topQueries: benchmarks.slice(0, 10).map((b: { query: string; relevantIds: Map<string, number> }) => ({
                    query: b.query,
                    relevant: b.relevantIds.size,
                  })),
                },
                null,
                2
              )
            );
          } else {
            console.log(chalk.bold("\nBenchmark Data\n"));
            console.log(`  Queries with relevance data: ${benchmarks.length}`);
            console.log(`  Total relevance judgments: ${totalJudgments}`);
            if (benchmarks.length > 0) {
              console.log("\n  Top queries by relevance data:");
              for (const b of benchmarks.slice(0, 10)) {
                console.log(
                  `    "${b.query}" — ${b.relevantIds.size} relevant memories`
                );
              }
            }
            if (benchmarks.length < 10) {
              console.log(
                chalk.yellow(
                  `\n  Need at least 10 queries for optimization. Current: ${benchmarks.length}.`
                )
              );
              console.log(
                chalk.dim(
                  "  Relevance data accumulates from memory_search -> memory_get usage."
                )
              );
            }
            console.log();
          }
          return;
        }

        const spinner = ora("Starting retrieval optimization...").start();

        const result = await optimizeRetrieval(db, {
          maxCycles: parseInt(opts.maxCycles, 10),
          stepSize: parseFloat(opts.stepSize),
          minQueries: parseInt(opts.minQueries, 10),
          maxQueries: parseInt(opts.maxQueries, 10),
          topK: parseInt(opts.topK, 10),
          dryRun: opts.dryRun === true,
          onProgress: (msg: string) => {
            spinner.text = msg;
          },
        });

        spinner.stop();

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(chalk.bold("\n  Retrieval Optimization Results\n"));
        console.log(
          `  Benchmark: ${result.benchmarkSize} queries (${result.trainSize} train, ${result.testSize} test)`
        );
        console.log(
          `  Cycles: ${result.cycles} | Evaluations: ${result.evaluations}`
        );
        console.log(
          `  Train NDCG@${opts.topK}: ${result.initialNdcg.toFixed(4)} -> ${result.finalNdcg.toFixed(4)} (${result.improvement >= 0 ? "+" : ""}${result.improvement.toFixed(1)}%)`
        );
        console.log(
          `  Test  NDCG@${opts.topK}: ${result.testBaseline.toFixed(4)} -> ${result.testNdcg.toFixed(4)}`
        );

        if (result.improvement > 0) {
          console.log(chalk.bold("\n  Weight changes:"));
          for (const key of Object.keys(result.initialWeights)) {
            const old = result.initialWeights[key];
            const neu = result.finalWeights[key];
            if (old !== neu) {
              const arrow =
                neu > old ? chalk.green("^") : chalk.red("v");
              const format =
                key === "rrf_k"
                  ? (v: number) => String(v)
                  : (v: number) => v.toFixed(2);
              console.log(
                `    ${key.padEnd(12)} ${format(old)} -> ${format(neu)} ${arrow}`
              );
            }
          }
        }

        if (result.dryRun) {
          console.log(
            chalk.yellow("\n  (dry run — weights not persisted)")
          );
        } else if (result.applied) {
          console.log(chalk.green("\n  Optimized weights persisted."));
        } else {
          console.log(
            chalk.dim("\n  No net improvement — original weights kept.")
          );
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
