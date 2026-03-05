export type {
  BenchmarkReport,
  BenchmarkOptions,
  BenchmarkCategory,
  BenchmarkQuestion,
  QuestionResult,
  CategoryResult,
  DimensionScores,
} from "./types.js";
export { BENCHMARK_DATASET } from "./seed.js";
export { runQuestions } from "./runner.js";
export { buildReport, renderMarkdown } from "./report.js";
export { compositeScore, buildJudgePrompt, parseJudgeResponse } from "./judge.js";

import type { BenchmarkOptions, BenchmarkReport } from "./types.js";
import { BENCHMARK_DATASET } from "./seed.js";
import { runQuestions } from "./runner.js";
import { buildReport } from "./report.js";

/**
 * Run the full benchmark end-to-end.
 * Seeds an in-memory DB, runs all questions with/without memory,
 * judges answers, and returns a structured report.
 */
export async function runBenchmark(
  options: BenchmarkOptions = {},
): Promise<BenchmarkReport> {
  const model = options.model ?? "claude-sonnet-4-6";

  if (options.verbose) {
    process.stderr.write(`Running benchmark with ${BENCHMARK_DATASET.questions.length} questions (model: ${model})...\n`);
  }

  const results = await runQuestions(BENCHMARK_DATASET, options);
  return buildReport(results, model);
}
