import type { Command } from "commander";
import {
  getDb,
  initializeSchema,
  getGoldenQueries,
  setGoldenQueries,
  runRetrievalRegression,
  compareRetrievalAgainstRun,
  getLatestRetrievalRegressionRunId,
  promoteGoldenBaselinesFromRun,
  resetGoldenBaselines,
} from "@exocortex/core";

function parseQueryList(input: string): string[] {
  return input
    .split("|")
    .map((q) => q.trim())
    .filter(Boolean);
}

function printResultRows(
  rows: Array<{
    query: string;
    overlap_at_10: number;
    avg_rank_shift: number;
    exact_order: boolean;
    alert: boolean;
    initialized?: boolean;
  }>,
  chalk: any
): void {
  for (const row of rows) {
    const state = row.initialized
      ? chalk.blue("init")
      : row.alert
        ? chalk.red("alert")
        : chalk.green("ok");
    console.log(
      `  ${state}  "${row.query}"  overlap=${(row.overlap_at_10 * 100).toFixed(
        1
      )}%  avgShift=${row.avg_rank_shift.toFixed(2)}  exact=${
        row.exact_order ? "yes" : "no"
      }`
    );
  }
}

export function registerRetrievalRegression(program: Command): void {
  program
    .command("retrieval-regression")
    .description("Run golden-query retrieval regression and drift checks")
    .option(
      "--set-queries <queries>",
      "Persist golden queries (pipe-separated), e.g. \"query a|query b|query c\""
    )
    .option(
      "--queries <queries>",
      "Override queries for this run only (pipe-separated)"
    )
    .option("--set-only", "Only persist --set-queries without running")
    .option("--limit <n>", "Top-k limit per query", "10")
    .option(
      "--min-overlap <n>",
      "Minimum overlap@k threshold (0-1)",
      "0.8"
    )
    .option(
      "--max-rank-shift <n>",
      "Maximum average rank shift threshold",
      "3"
    )
    .option("--update-baselines", "Update baselines after this run")
    .option("--include-metadata", "Include benchmark/progress metadata memories")
    .option(
      "--alerts-as-memory",
      "Store alert summary memory when thresholds are breached"
    )
    .option(
      "--fail-on-alert",
      "Exit with code 1 when regression alerts are present (CI gate)"
    )
    .option(
      "--compare-against <run-id>",
      "Compare current retrieval against a previous run id (or 'latest')"
    )
    .option(
      "--promote-run <run-id>",
      "Promote run current_ids to baselines for that run id (or 'latest')"
    )
    .option("--reset-baselines", "Clear all stored golden baselines")
    .option(
      "--reset-queries <queries>",
      "Reset baselines only for these pipe-separated queries"
    )
    .option("--json", "Print JSON output")
    .action(async (opts) => {
      const ora = (await import("ora")).default;
      const chalk = (await import("chalk")).default;

      const spinner = ora("Running retrieval regression...").start();

      try {
        const db = getDb();
        initializeSchema(db);

        if (opts.setQueries) {
          const parsed = parseQueryList(opts.setQueries);
          setGoldenQueries(db, parsed);
          if (opts.setOnly) {
            spinner.succeed(
              chalk.green(
                `Stored ${parsed.length} golden quer${parsed.length === 1 ? "y" : "ies"}`
              )
            );
            return;
          }
        }

        if (opts.resetBaselines || opts.resetQueries) {
          const queryList = opts.resetQueries
            ? parseQueryList(opts.resetQueries)
            : undefined;
          const reset = resetGoldenBaselines(db, queryList);
          spinner.stop();
          if (opts.json) {
            console.log(JSON.stringify(reset, null, 2));
          } else if (queryList && queryList.length > 0) {
            console.log(
              chalk.green(
                `Reset ${reset.removed} baseline row(s) for ${queryList.length} quer${queryList.length === 1 ? "y" : "ies"}.`
              )
            );
          } else {
            console.log(chalk.green(`Reset ${reset.removed} baseline row(s).`));
          }
          return;
        }

        if (opts.promoteRun) {
          const runId =
            opts.promoteRun === "latest"
              ? getLatestRetrievalRegressionRunId(db)
              : String(opts.promoteRun);
          if (!runId) {
            spinner.fail("No retrieval regression runs found to promote.");
            process.exit(1);
          }
          const promoted = promoteGoldenBaselinesFromRun(db, runId);
          spinner.stop();
          if (opts.json) {
            console.log(JSON.stringify(promoted, null, 2));
          } else {
            console.log(
              chalk.green(
                `Promoted ${promoted.promoted} baseline quer${promoted.promoted === 1 ? "y" : "ies"} from run ${runId}.`
              )
            );
          }
          return;
        }

        if (opts.compareAgainst) {
          const runId =
            opts.compareAgainst === "latest"
              ? getLatestRetrievalRegressionRunId(db)
              : String(opts.compareAgainst);
          if (!runId) {
            spinner.fail("No retrieval regression runs found for compare.");
            process.exit(1);
          }

          const compare = await compareRetrievalAgainstRun(db, {
            run_id: runId,
            limit: parseInt(opts.limit, 10),
            min_overlap_at_10: parseFloat(opts.minOverlap),
            max_avg_rank_shift: parseFloat(opts.maxRankShift),
            include_metadata: opts.includeMetadata === true,
          });

          spinner.stop();
          if (opts.json) {
            console.log(JSON.stringify(compare, null, 2));
          } else {
            console.log(
              chalk.bold(
                `\nRetrieval compare vs run ${runId}: ${compare.ran} queries | alerts: ${compare.alerts}\n`
              )
            );
            console.log(
              `  Thresholds: overlap@${compare.limit} >= ${(
                compare.min_overlap_at_10 * 100
              ).toFixed(1)}%, avg-rank-shift <= ${compare.max_avg_rank_shift.toFixed(
                2
              )}`
            );
            console.log();
            printResultRows(compare.results, chalk);
            console.log();
          }

          if (opts.failOnAlert === true && compare.alerts > 0) {
            process.exit(1);
          }
          return;
        }

        const configured = getGoldenQueries(db);
        const overrideQueries = opts.queries
          ? parseQueryList(opts.queries)
          : undefined;

        const result = await runRetrievalRegression(db, {
          queries: overrideQueries ?? configured,
          limit: parseInt(opts.limit, 10),
          min_overlap_at_10: parseFloat(opts.minOverlap),
          max_avg_rank_shift: parseFloat(opts.maxRankShift),
          update_baselines: opts.updateBaselines === true,
          include_metadata: opts.includeMetadata === true,
          create_alert_memory: opts.alertsAsMemory === true,
        });

        spinner.stop();

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          if (opts.failOnAlert === true && result.alerts > 0) {
            process.exit(1);
          }
          return;
        }

        if (result.ran === 0) {
          console.log(
            chalk.yellow("No golden queries configured. Use --set-queries to define them.")
          );
          return;
        }

        console.log(
          chalk.bold(
            `\nRetrieval regression: ${result.ran} queries | alerts: ${result.alerts} | initialized: ${result.initialized}\n`
          )
        );
        if (result.run_id) {
          console.log(`  Run ID: ${chalk.cyan(result.run_id)}`);
        }
        console.log(
          `  Thresholds: overlap@${result.limit} >= ${(
            result.min_overlap_at_10 * 100
          ).toFixed(1)}%, avg-rank-shift <= ${result.max_avg_rank_shift.toFixed(
            2
          )}`
        );
        if (result.alert_memory_id) {
          console.log(`  Alert memory: ${chalk.cyan(result.alert_memory_id)}`);
        }
        console.log();

        printResultRows(result.results, chalk);
        console.log();

        if (opts.failOnAlert === true && result.alerts > 0) {
          process.exit(1);
        }
      } catch (err) {
        spinner.fail(
          `Retrieval regression failed: ${err instanceof Error ? err.message : String(err)}`
        );
        process.exit(1);
      }
    });
}

