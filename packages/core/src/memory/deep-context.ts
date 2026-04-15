import { spawn } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { MemorySearch } from "./search.js";
import type { SearchResult } from "./types.js";

export interface DeepContextOptions {
  topic: string;
  limit?: number;
  namespace?: string;
  /** Max LLM gap-detection iterations (default 3) */
  maxIterations?: number;
  /** Hard cap on total unique memories returned (default 30) */
  maxResults?: number;
}

export interface DeepContextResult {
  results: SearchResult[];
  /** Number of follow-up query rounds executed */
  iterations: number;
  /** All queries run (initial + follow-ups) */
  queries: string[];
  /** Remaining gaps identified in final iteration (empty = fully converged) */
  gaps: string[];
  /** True if the codex LLM call for gap analysis failed */
  deepRetrievalFailed?: boolean;
}

interface GapAnalysis {
  gaps: string[];
  queries: string[];
  deepRetrievalFailed?: boolean;
}

interface CodexJsonEvent {
  type?: string;
  item?: { type?: string; text?: string };
}

const isWindows = process.platform === "win32";
const shellCmd = isWindows ? "cmd.exe" : "/bin/sh";
const shellArg = isWindows ? "/c" : "-c";

/**
 * Run a prompt through `codex exec` and return the text response.
 * Uses iterative LLM-guided retrieval with gap analysis.
 */
function runCodex(prompt: string, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const command = "codex exec --full-auto --skip-git-repo-check --json -";
    const proc = spawn(shellCmd, [shellArg, command], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, CLAUDECODE: "" },
    });

    proc.stdin!.write(prompt);
    proc.stdin!.end();

    let stdout = "";
    let stderr = "";

    proc.stdout!.on("data", (data: Buffer) => { stdout += data.toString(); });
    proc.stderr!.on("data", (data: Buffer) => { stderr += data.toString(); });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("codex exec timed out"));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        // Extract text from JSONL item.completed events
        const parts: string[] = [];
        for (const line of stdout.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event: CodexJsonEvent = JSON.parse(trimmed);
            if (event.type === "item.completed" && event.item?.text) {
              parts.push(event.item.text);
            }
          } catch { /* skip non-JSON lines */ }
        }
        resolve(parts.join("\n").trim());
      } else {
        reject(new Error(stderr.trim() || `codex exited with code ${code}`));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn codex: ${err.message}`));
    });
  });
}

/**
 * Ask an LLM (via codex CLI) to identify knowledge gaps in the retrieved
 * memories relative to the topic, and generate follow-up search queries.
 */
async function analyzeGaps(
  topic: string,
  memories: SearchResult[],
  previousQueries: string[],
): Promise<GapAnalysis> {
  const summaries = memories
    .slice(0, 20)
    .map((r, i) => {
      const tags = r.memory.tags?.length ? ` [${r.memory.tags.join(", ")}]` : "";
      const preview = r.memory.content.substring(0, 200).replace(/\n/g, " ");
      return `${i + 1}. ${preview}${r.memory.content.length > 200 ? "..." : ""}${tags}`;
    })
    .join("\n");

  const prevQueriesStr = previousQueries.length > 1
    ? `\nPrevious queries already run:\n${previousQueries.map((q) => `- ${q}`).join("\n")}\n\nDo NOT repeat these queries. Only suggest queries that explore genuinely different aspects.`
    : "";

  const prompt = `Given the topic: "${topic}"

Retrieved memories (${memories.length} total):
${summaries}
${prevQueriesStr}
What important aspects of this topic are NOT covered by the retrieved memories? Generate 1-3 targeted search queries that would find the missing information in a personal knowledge base. Queries should be short keyword phrases, not full sentences.

If the memories already provide comprehensive coverage, return empty arrays.

Respond with ONLY valid JSON, no markdown fences:
{"gaps": ["brief description of gap"], "queries": ["keyword search query"]}`;

  try {
    const responseText = await runCodex(prompt, 30_000);

    // Extract JSON from response (handles stray text around it)
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { gaps: [], queries: [] };

    const parsed = JSON.parse(jsonMatch[0]) as { gaps?: unknown[]; queries?: unknown[] };
    return {
      gaps: Array.isArray(parsed.gaps)
        ? (parsed.gaps.filter((g): g is string => typeof g === "string")).slice(0, 3)
        : [],
      queries: Array.isArray(parsed.queries)
        ? (parsed.queries.filter((q): q is string => typeof q === "string")).slice(0, 3)
        : [],
    };
  } catch {
    // codex call failed — degrade gracefully to no follow-up
    return { gaps: [], queries: [], deepRetrievalFailed: true };
  }
}

/**
 * Iterative chain-of-thought retrieval. Performs an initial search, then
 * uses codex CLI to identify gaps and generate follow-up queries until
 * convergence or max iterations.
 *
 * Degrades to single-pass search if codex CLI is unavailable.
 */
export async function deepContext(
  db: DatabaseSync,
  options: DeepContextOptions,
): Promise<DeepContextResult> {
  const search = new MemorySearch(db);
  const maxIterations = options.maxIterations ?? 3;
  const maxResults = options.maxResults ?? 30;
  const perQueryLimit = options.limit ?? 15;

  // Track all unique results by memory ID, keeping highest score
  const resultMap = new Map<string, SearchResult>();
  const allQueries: string[] = [options.topic];
  let lastGaps: string[] = [];
  let iterationCount = 0;

  // Round 1: initial search on the topic
  const initial = await search.search({
    query: options.topic,
    limit: perQueryLimit,
    namespace: options.namespace,
  });

  for (const r of initial) {
    resultMap.set(r.memory.id, r);
  }

  // Iterative deepening via LLM gap detection
  let deepRetrievalFailed = false;
  for (let i = 0; i < maxIterations; i++) {
    if (resultMap.size >= maxResults) break;

    const currentResults = Array.from(resultMap.values())
      .sort((a, b) => b.score - a.score);

    const analysis = await analyzeGaps(options.topic, currentResults, allQueries);
    iterationCount++;

    if (analysis.deepRetrievalFailed) {
      deepRetrievalFailed = true;
      break;
    }

    if (analysis.queries.length === 0) break; // Converged

    lastGaps = analysis.gaps;
    let foundNew = false;

    for (const q of analysis.queries) {
      if (resultMap.size >= maxResults) break;
      allQueries.push(q);

      const remaining = maxResults - resultMap.size;
      const followUp = await search.search({
        query: q,
        limit: Math.min(perQueryLimit, remaining),
        namespace: options.namespace,
      });

      for (const r of followUp) {
        if (!resultMap.has(r.memory.id)) {
          resultMap.set(r.memory.id, r);
          foundNew = true;
        } else {
          // Upgrade score if this query found it more relevant
          const existing = resultMap.get(r.memory.id)!;
          if (r.score > existing.score) {
            resultMap.set(r.memory.id, r);
          }
        }
      }
    }

    if (!foundNew) break; // No new results — converged
  }

  const results = Array.from(resultMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);

  return {
    results,
    iterations: iterationCount,
    queries: allQueries,
    gaps: lastGaps,
    ...(deepRetrievalFailed ? { deepRetrievalFailed: true } : {}),
  };
}
