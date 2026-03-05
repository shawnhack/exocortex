import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { runBenchmark, renderMarkdown } from "../packages/core/src/benchmark/index.ts";

// Load ~/.env if ANTHROPIC_API_KEY not already set
if (!process.env.ANTHROPIC_API_KEY) {
  try {
    const envFile = readFileSync(join(homedir(), ".env"), "utf-8");
    for (const line of envFile.split("\n")) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) process.env[match[1].trim()] = match[2].trim();
    }
  } catch {}
}

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const verbose = args.includes("--verbose");

try {
  const report = await runBenchmark({ verbose });

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderMarkdown(report));
  }

  // Exit with non-zero if with-memory didn't beat without-memory
  if (report.overall.with_memory <= report.overall.without_memory) {
    process.stderr.write(
      "WARNING: with-memory score did not exceed without-memory score\n",
    );
    process.exit(1);
  }
} catch (err) {
  process.stderr.write(
    `Benchmark failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}
