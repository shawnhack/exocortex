import type {
  BenchmarkCategory,
  BenchmarkReport,
  CategoryResult,
  QuestionResult,
} from "./types.js";

const CATEGORY_LABELS: Record<BenchmarkCategory, string> = {
  factual_recall: "Factual Recall",
  decision_continuity: "Decision Continuity",
  context_awareness: "Context Awareness",
  cross_reference: "Cross-Reference",
  technique_application: "Technique Application",
};

/**
 * Build a structured BenchmarkReport from raw question results.
 */
export function buildReport(
  questions: QuestionResult[],
  model: string,
): BenchmarkReport {
  // Overall aggregates
  const withComposites = questions.map((q) => q.with_memory.composite);
  const withoutComposites = questions.map((q) => q.without_memory.composite);
  const avgWith = avg(withComposites);
  const avgWithout = avg(withoutComposites);

  const totalTokens = questions.reduce(
    (acc, q) => ({
      input:
        acc.input + q.with_memory.tokens.input + q.without_memory.tokens.input,
      output:
        acc.output +
        q.with_memory.tokens.output +
        q.without_memory.tokens.output,
    }),
    { input: 0, output: 0 },
  );

  // By category
  const categories = new Map<BenchmarkCategory, QuestionResult[]>();
  for (const q of questions) {
    const cat = q.question.category;
    if (!categories.has(cat)) categories.set(cat, []);
    categories.get(cat)!.push(q);
  }

  const byCategory: CategoryResult[] = [];
  for (const [cat, qs] of categories) {
    const catWith = avg(qs.map((q) => q.with_memory.composite));
    const catWithout = avg(qs.map((q) => q.without_memory.composite));
    byCategory.push({
      category: cat,
      with_memory_avg: catWith,
      without_memory_avg: catWithout,
      improvement_pct:
        catWithout > 0 ? ((catWith - catWithout) / catWithout) * 100 : 0,
      question_count: qs.length,
    });
  }

  return {
    timestamp: new Date().toISOString(),
    model,
    overall: {
      with_memory: avgWith,
      without_memory: avgWithout,
      improvement_pct:
        avgWithout > 0 ? ((avgWith - avgWithout) / avgWithout) * 100 : 0,
      total_tokens: totalTokens,
      avg_latency_ms: {
        with_memory: avg(questions.map((q) => q.with_memory.latency_ms)),
        without_memory: avg(questions.map((q) => q.without_memory.latency_ms)),
      },
    },
    by_category: byCategory,
    questions,
  };
}

/**
 * Render the benchmark report as Markdown.
 */
export function renderMarkdown(report: BenchmarkReport): string {
  const lines: string[] = [];

  lines.push("# Exocortex Memory Benchmark Report");
  lines.push("");
  lines.push(`**Date**: ${report.timestamp}`);
  lines.push(`**Model**: ${report.model}`);
  lines.push("");

  // Overall
  lines.push("## Overall Results");
  lines.push("");
  lines.push("| Metric | With Memory | Without Memory | Improvement |");
  lines.push("|--------|-------------|----------------|-------------|");
  lines.push(
    `| Composite Score | ${report.overall.with_memory.toFixed(1)}/10 | ${report.overall.without_memory.toFixed(1)}/10 | +${report.overall.improvement_pct.toFixed(0)}% |`,
  );
  lines.push(
    `| Total Tokens | ${fmtNum(report.overall.total_tokens.input + report.overall.total_tokens.output)} | — | — |`,
  );
  lines.push(
    `| Avg Latency | ${(report.overall.avg_latency_ms.with_memory / 1000).toFixed(1)}s | ${(report.overall.avg_latency_ms.without_memory / 1000).toFixed(1)}s | +${pctDiff(report.overall.avg_latency_ms.with_memory, report.overall.avg_latency_ms.without_memory)}% |`,
  );
  lines.push("");

  // By category
  lines.push("## By Category");
  lines.push("");
  lines.push(
    "| Category | With Memory | Without Memory | Improvement | Questions |",
  );
  lines.push(
    "|----------|-------------|----------------|-------------|-----------|",
  );
  for (const cat of report.by_category) {
    lines.push(
      `| ${CATEGORY_LABELS[cat.category]} | ${cat.with_memory_avg.toFixed(1)} | ${cat.without_memory_avg.toFixed(1)} | +${cat.improvement_pct.toFixed(0)}% | ${cat.question_count} |`,
    );
  }
  lines.push("");

  // Per-question detail
  lines.push("## Per-Question Detail");
  lines.push("");
  for (const q of report.questions) {
    lines.push(`### ${q.question.id}: ${q.question.question}`);
    lines.push("");
    lines.push("**With Memory:**");
    lines.push(`> ${q.with_memory.answer.replace(/\n/g, "\n> ")}`);
    lines.push("");
    lines.push(
      `Scores: accuracy=${q.with_memory.scores.accuracy} specificity=${q.with_memory.scores.specificity} continuity=${q.with_memory.scores.continuity} hallucination=${q.with_memory.scores.hallucination} | **composite=${q.with_memory.composite.toFixed(1)}**`,
    );
    lines.push("");
    lines.push("**Without Memory:**");
    lines.push(`> ${q.without_memory.answer.replace(/\n/g, "\n> ")}`);
    lines.push("");
    lines.push(
      `Scores: accuracy=${q.without_memory.scores.accuracy} specificity=${q.without_memory.scores.specificity} continuity=${q.without_memory.scores.continuity} hallucination=${q.without_memory.scores.hallucination} | **composite=${q.without_memory.composite.toFixed(1)}**`,
    );
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

function pctDiff(a: number, b: number): string {
  if (b === 0) return "0";
  return (((a - b) / b) * 100).toFixed(0);
}
