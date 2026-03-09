import type { DatabaseSync } from "node:sqlite";
import { getSetting, setSetting } from "../db/schema.js";
import { MemorySearch } from "../memory/search.js";
import { getWeights } from "../memory/scoring.js";
import {
  getEmbeddingProvider,
  setEmbeddingProvider,
} from "../embedding/manager.js";
import type { EmbeddingProvider } from "../embedding/types.js";

// --- Types ---

export interface OptimizationConfig {
  /** Max coordinate descent cycles (default 3) */
  maxCycles?: number;
  /** Weight step size (default 0.05) */
  stepSize?: number;
  /** Min benchmark queries to proceed (default 10) */
  minQueries?: number;
  /** Max benchmark queries to use (default 50) */
  maxQueries?: number;
  /** NDCG evaluation depth (default 10) */
  topK?: number;
  /** Preview only, don't persist (default false) */
  dryRun?: boolean;
  /** Progress callback */
  onProgress?: (msg: string) => void;
}

export interface BenchmarkQuery {
  query: string;
  /** memory_id -> graded relevance (higher = more relevant) */
  relevantIds: Map<string, number>;
}

export interface OptimizationResult {
  initialNdcg: number;
  finalNdcg: number;
  testNdcg: number;
  testBaseline: number;
  improvement: number;
  cycles: number;
  evaluations: number;
  initialWeights: Record<string, number>;
  finalWeights: Record<string, number>;
  benchmarkSize: number;
  trainSize: number;
  testSize: number;
  dryRun: boolean;
  applied: boolean;
}

// --- Settings key map ---

const WEIGHT_KEYS: Record<string, string> = {
  vector: "scoring.vector_weight",
  fts: "scoring.fts_weight",
  recency: "scoring.recency_weight",
  frequency: "scoring.frequency_weight",
  graph: "scoring.graph_weight",
  usefulness: "scoring.usefulness_weight",
  valence: "scoring.valence_weight",
  quality: "scoring.quality_weight",
  goalGated: "scoring.goal_gated_weight",
  recencyDecay: "scoring.recency_decay",
};

// --- Embedding cache wrapper ---

class CachedEmbeddingProvider implements EmbeddingProvider {
  private cache = new Map<string, Float32Array>();
  constructor(private inner: EmbeddingProvider) {}

  dimensions(): number {
    return this.inner.dimensions();
  }

  async embed(text: string): Promise<Float32Array> {
    const cached = this.cache.get(text);
    if (cached) return cached;
    const result = await this.inner.embed(text);
    this.cache.set(text, result);
    return result;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  get cacheSize(): number {
    return this.cache.size;
  }
}

// --- Ground truth mining ---

export function mineBenchmarkQueries(
  db: DatabaseSync,
  opts?: { minAccessedMemories?: number; maxQueries?: number }
): BenchmarkQuery[] {
  const minAccessed = opts?.minAccessedMemories ?? 2;
  const maxQueries = opts?.maxQueries ?? 200;

  const rows = db
    .prepare(
      `SELECT al.query, al.memory_id, m.useful_count
       FROM access_log al
       JOIN memories m ON m.id = al.memory_id
       WHERE al.query IS NOT NULL AND al.query != '' AND m.is_active = 1
       ORDER BY al.query`
    )
    .all() as Array<{
    query: string;
    memory_id: string;
    useful_count: number;
  }>;

  const queryMap = new Map<string, Map<string, number>>();
  for (const row of rows) {
    if (!queryMap.has(row.query)) queryMap.set(row.query, new Map());
    const rel = queryMap.get(row.query)!;
    // Graded relevance: base 1 for accessed + useful_count bonus
    const grade = Math.max(
      rel.get(row.memory_id) ?? 0,
      1 + Math.max(0, row.useful_count)
    );
    rel.set(row.memory_id, grade);
  }

  const benchmarks: BenchmarkQuery[] = [];
  for (const [query, relevantIds] of queryMap) {
    if (relevantIds.size >= minAccessed) {
      benchmarks.push({ query, relevantIds });
    }
  }

  // Sort by richness (most relevant memories first) for train/test split
  benchmarks.sort((a, b) => b.relevantIds.size - a.relevantIds.size);
  return benchmarks.slice(0, maxQueries);
}

// --- NDCG computation ---

function dcgAtK(
  ids: string[],
  rel: Map<string, number>,
  k: number
): number {
  let dcg = 0;
  for (let i = 0; i < Math.min(ids.length, k); i++) {
    const r = rel.get(ids[i]) ?? 0;
    dcg += (Math.pow(2, r) - 1) / Math.log2(i + 2);
  }
  return dcg;
}

function ndcgAtK(
  ids: string[],
  rel: Map<string, number>,
  k: number
): number {
  const dcg = dcgAtK(ids, rel, k);
  if (dcg === 0) return 0;
  const idealIds = [...rel.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
  const idcg = dcgAtK(idealIds, rel, k);
  return idcg === 0 ? 0 : dcg / idcg;
}

// --- Weight I/O ---

function applyWeightsToDb(
  db: DatabaseSync,
  w: Record<string, number>
): void {
  for (const [key, settingKey] of Object.entries(WEIGHT_KEYS)) {
    if (key in w) setSetting(db, settingKey, w[key].toString());
  }
  if ("rrf_k" in w) {
    setSetting(db, "scoring.rrf_k", Math.round(w.rrf_k).toString());
  }
}

function readWeightsFromDb(db: DatabaseSync): Record<string, number> {
  const w = getWeights(db);
  const r: Record<string, number> = {};
  for (const key of Object.keys(WEIGHT_KEYS)) {
    r[key] = (w as unknown as Record<string, number>)[key];
  }
  r.rrf_k = parseInt(getSetting(db, "scoring.rrf_k") ?? "60", 10);
  return r;
}

// --- Evaluation ---

async function evalNdcg(
  search: MemorySearch,
  benchmarks: BenchmarkQuery[],
  topK: number
): Promise<number> {
  let total = 0;
  for (const bq of benchmarks) {
    const results = await search.search({ query: bq.query, limit: topK });
    total += ndcgAtK(
      results.map((r) => r.memory.id),
      bq.relevantIds,
      topK
    );
  }
  return total / benchmarks.length;
}

// --- Optimizer ---

export async function optimizeRetrieval(
  db: DatabaseSync,
  config?: OptimizationConfig
): Promise<OptimizationResult> {
  const maxCycles = config?.maxCycles ?? 3;
  const step = config?.stepSize ?? 0.05;
  const minQ = config?.minQueries ?? 10;
  const maxQ = config?.maxQueries ?? 50;
  const topK = config?.topK ?? 10;
  const dryRun = config?.dryRun ?? false;
  const log = config?.onProgress ?? (() => {});

  // Install embedding cache — queries are repeated across evaluations
  const rawProvider = await getEmbeddingProvider();
  const cachedProvider = new CachedEmbeddingProvider(rawProvider);
  setEmbeddingProvider(cachedProvider);

  try {
    return await runOptimization(db, {
      maxCycles,
      step,
      minQ,
      maxQ,
      topK,
      dryRun,
      log,
      cachedProvider,
    });
  } finally {
    // Restore original provider
    setEmbeddingProvider(rawProvider);
  }
}

async function runOptimization(
  db: DatabaseSync,
  opts: {
    maxCycles: number;
    step: number;
    minQ: number;
    maxQ: number;
    topK: number;
    dryRun: boolean;
    log: (msg: string) => void;
    cachedProvider: CachedEmbeddingProvider;
  }
): Promise<OptimizationResult> {
  const { maxCycles, step, minQ, maxQ, topK, dryRun, log, cachedProvider } =
    opts;

  // Mine ground truth from real usage
  log("Mining benchmark queries from access history...");
  const all = mineBenchmarkQueries(db, { maxQueries: maxQ });
  if (all.length < minQ) {
    throw new Error(
      `Insufficient data: ${all.length} queries (need ${minQ}+). ` +
        `Build up more access_log data by using memory_search + memory_get.`
    );
  }

  // 80/20 train/test split
  const splitIdx = Math.max(1, Math.floor(all.length * 0.8));
  const train = all.slice(0, splitIdx);
  const test = all.slice(splitIdx);
  const totalJudgments = all.reduce((s, b) => s + b.relevantIds.size, 0);
  log(
    `Benchmark: ${all.length} queries, ${totalJudgments} judgments (${train.length} train, ${test.length} test)`
  );

  // Snapshot original weights
  const original = readWeightsFromDb(db);
  const current = { ...original };
  const search = new MemorySearch(db);
  let evals = 0;

  // Baseline
  log("Evaluating baseline...");
  const initialNdcg = await evalNdcg(search, train, topK);
  evals++;
  log(
    `Baseline NDCG@${topK}: ${initialNdcg.toFixed(4)} (${cachedProvider.cacheSize} embeddings cached)`
  );

  let bestNdcg = initialNdcg;
  let actualCycles = 0;

  const params = [...Object.keys(WEIGHT_KEYS), "rrf_k"];

  // Coordinate descent
  for (let cycle = 0; cycle < maxCycles; cycle++) {
    let improved = false;
    actualCycles++;
    log(`\nCycle ${cycle + 1}/${maxCycles}`);

    for (const param of params) {
      const cur = current[param];
      const candidates: number[] = [];

      if (param === "rrf_k") {
        for (const v of [10, 20, 30, 40, 60, 80, 100, 150, 200]) {
          if (v !== cur) candidates.push(v);
        }
      } else {
        for (let d = -3; d <= 3; d++) {
          if (d === 0) continue;
          const v = Math.round((cur + d * step) * 100) / 100;
          if (v >= 0.02 && v <= 0.60) candidates.push(v);
        }
      }

      let bestVal = cur;
      let bestParamNdcg = bestNdcg;

      for (const c of candidates) {
        current[param] = c;
        applyWeightsToDb(db, current);
        const ndcg = await evalNdcg(search, train, topK);
        evals++;
        // Epsilon to avoid noise-driven changes
        if (ndcg > bestParamNdcg + 0.0001) {
          bestParamNdcg = ndcg;
          bestVal = c;
        }
      }

      if (bestVal !== cur) {
        log(
          `  ${param}: ${param === "rrf_k" ? cur : cur.toFixed(2)} -> ${param === "rrf_k" ? bestVal : bestVal.toFixed(2)} (NDCG: ${bestParamNdcg.toFixed(4)})`
        );
        current[param] = bestVal;
        bestNdcg = bestParamNdcg;
        improved = true;
      } else {
        current[param] = cur;
      }
      applyWeightsToDb(db, current);
    }

    if (!improved) {
      log(`Converged after cycle ${cycle + 1}.`);
      break;
    }
  }

  // Validate on held-out test set
  log("\nValidating on test set...");
  applyWeightsToDb(db, current);
  const testNdcg =
    test.length > 0 ? await evalNdcg(search, test, topK) : bestNdcg;
  evals++;

  applyWeightsToDb(db, original);
  const testBaseline =
    test.length > 0 ? await evalNdcg(search, test, topK) : initialNdcg;
  evals++;

  // Allow tiny test regression (0.01) to avoid over-conservative behavior
  const testImproved = testNdcg >= testBaseline - 0.01;

  log(
    `Test NDCG@${topK}: ${testBaseline.toFixed(4)} -> ${testNdcg.toFixed(4)} (${testImproved ? "OK" : "REGRESSION"})`
  );

  // Apply or rollback
  const shouldApply = !dryRun && bestNdcg > initialNdcg && testImproved;
  const optimizedWeights = { ...current };
  applyWeightsToDb(db, shouldApply ? optimizedWeights : original);

  if (dryRun) {
    log("\nDry run — original weights restored.");
  } else if (shouldApply) {
    log("\nOptimized weights persisted.");
  } else {
    log("\nNo net improvement — original weights kept.");
  }

  const improvement =
    initialNdcg > 0
      ? ((bestNdcg - initialNdcg) / initialNdcg) * 100
      : 0;

  return {
    initialNdcg,
    finalNdcg: bestNdcg,
    testNdcg,
    testBaseline,
    improvement,
    cycles: actualCycles,
    evaluations: evals,
    initialWeights: original,
    finalWeights: optimizedWeights,
    benchmarkSize: all.length,
    trainSize: train.length,
    testSize: test.length,
    dryRun,
    applied: shouldApply,
  };
}
