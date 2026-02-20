import type { DatabaseSync } from "node:sqlite";
import { ulid } from "ulid";
import { getSetting, setSetting } from "../db/schema.js";
import { MemorySearch } from "../memory/search.js";
import { MemoryStore } from "../memory/store.js";
import type { ContentType, SearchQuery } from "../memory/types.js";
import { incrementCounter } from "../observability/counters.js";

export interface GoldenQueryDefinition {
  query: string;
  tags?: string[];
  content_type?: ContentType;
  include_metadata?: boolean;
}

export interface RetrievalRegressionOptions {
  queries?: Array<string | GoldenQueryDefinition>;
  limit?: number;
  min_overlap_at_10?: number;
  max_avg_rank_shift?: number;
  update_baselines?: boolean;
  include_metadata?: boolean;
  create_alert_memory?: boolean;
}

export interface RetrievalRegressionQueryResult {
  query: string;
  baseline_ids: string[];
  current_ids: string[];
  overlap_at_10: number;
  avg_rank_shift: number;
  exact_order: boolean;
  alert: boolean;
  initialized: boolean;
}

export interface RetrievalRegressionResult {
  run_id?: string;
  ran: number;
  initialized: number;
  alerts: number;
  limit: number;
  min_overlap_at_10: number;
  max_avg_rank_shift: number;
  results: RetrievalRegressionQueryResult[];
  alert_memory_id?: string;
}

export interface RetrievalRunSnapshot {
  id: number;
  run_group_id: string;
  query: string;
  baseline_ids: string[];
  current_ids: string[];
  overlap_at_10: number;
  avg_rank_shift: number;
  exact_order: boolean;
  alert: boolean;
  created_at: string;
}

export interface RetrievalBaselineResetResult {
  removed: number;
  queries: string[];
}

export interface RetrievalBaselinePromoteResult {
  run_id: string;
  promoted: number;
  queries: string[];
}

export interface RetrievalRegressionCompareOptions {
  run_id: string;
  limit?: number;
  min_overlap_at_10?: number;
  max_avg_rank_shift?: number;
  include_metadata?: boolean;
}

export interface RetrievalRegressionCompareResult {
  run_id: string;
  ran: number;
  alerts: number;
  limit: number;
  min_overlap_at_10: number;
  max_avg_rank_shift: number;
  results: RetrievalRegressionQueryResult[];
}

function normalizeQueryDefinitions(
  queries: Array<string | GoldenQueryDefinition>
): GoldenQueryDefinition[] {
  return queries
    .map((q) => {
      if (typeof q === "string") {
        return { query: q.trim() };
      }
      return {
        query: q.query.trim(),
        tags: q.tags?.map((t) => t.trim()).filter(Boolean),
        content_type: q.content_type,
        include_metadata: q.include_metadata,
      };
    })
    .filter((q) => q.query.length > 0);
}

function parseIdList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((id) => String(id).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function computeOverlapAtK(
  baseline: string[],
  current: string[],
  k: number
): { overlap: number; exact: boolean; avgShift: number } {
  const b = baseline.slice(0, k);
  const c = current.slice(0, k);
  const bSet = new Set(b);
  const overlapIds = c.filter((id) => bSet.has(id));
  const overlap = overlapIds.length / Math.max(1, k);
  const exact = b.length === c.length && b.every((id, i) => c[i] === id);

  let shiftTotal = 0;
  for (const id of overlapIds) {
    const from = b.indexOf(id);
    const to = c.indexOf(id);
    shiftTotal += Math.abs(from - to);
  }
  const avgShift = overlapIds.length > 0 ? shiftTotal / overlapIds.length : k;

  return {
    overlap,
    exact,
    avgShift,
  };
}

function getThresholds(
  db: DatabaseSync,
  options?: {
    limit?: number;
    min_overlap_at_10?: number;
    max_avg_rank_shift?: number;
  }
): {
  limit: number;
  minOverlap: number;
  maxAvgShift: number;
} {
  return {
    limit:
      options?.limit ??
      parseInt(getSetting(db, "retrieval_regression.limit") ?? "10", 10),
    minOverlap:
      options?.min_overlap_at_10 ??
      parseFloat(
        getSetting(db, "retrieval_regression.min_overlap_at_10") ?? "0.80"
      ),
    maxAvgShift:
      options?.max_avg_rank_shift ??
      parseFloat(
        getSetting(db, "retrieval_regression.max_avg_rank_shift") ?? "3"
      ),
  };
}

function getGoldenQueryMap(
  db: DatabaseSync
): Map<string, GoldenQueryDefinition> {
  const map = new Map<string, GoldenQueryDefinition>();
  for (const def of getGoldenQueries(db)) {
    map.set(def.query, def);
  }
  return map;
}

function getRunRows(db: DatabaseSync, runId: string): RetrievalRunSnapshot[] {
  const rows = db
    .prepare(
      `SELECT
        id,
        run_group_id,
        query,
        baseline_ids,
        current_ids,
        overlap_at_10,
        avg_rank_shift,
        exact_order,
        alert,
        created_at
       FROM retrieval_regression_runs
       WHERE run_group_id = ?
       ORDER BY id ASC`
    )
    .all(runId) as Array<{
    id: number;
    run_group_id: string;
    query: string;
    baseline_ids: string;
    current_ids: string;
    overlap_at_10: number;
    avg_rank_shift: number;
    exact_order: number;
    alert: number;
    created_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    run_group_id: row.run_group_id,
    query: row.query,
    baseline_ids: parseIdList(row.baseline_ids),
    current_ids: parseIdList(row.current_ids),
    overlap_at_10: row.overlap_at_10,
    avg_rank_shift: row.avg_rank_shift,
    exact_order: row.exact_order === 1,
    alert: row.alert === 1,
    created_at: row.created_at,
  }));
}

export function getGoldenQueries(db: DatabaseSync): GoldenQueryDefinition[] {
  const raw = getSetting(db, "retrieval_regression.queries") ?? "[]";
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return normalizeQueryDefinitions(
      parsed as Array<string | GoldenQueryDefinition>
    );
  } catch {
    return [];
  }
}

export function setGoldenQueries(
  db: DatabaseSync,
  queries: Array<string | GoldenQueryDefinition>
): void {
  const normalized = normalizeQueryDefinitions(queries);
  setSetting(db, "retrieval_regression.queries", JSON.stringify(normalized));
}

export function getLatestRetrievalRegressionRunId(
  db: DatabaseSync
): string | undefined {
  const row = db
    .prepare(
      `SELECT run_group_id
       FROM retrieval_regression_runs
       WHERE run_group_id != ''
       ORDER BY created_at DESC, id DESC
       LIMIT 1`
    )
    .get() as { run_group_id: string } | undefined;
  return row?.run_group_id;
}

export function resetGoldenBaselines(
  db: DatabaseSync,
  queries?: string[]
): RetrievalBaselineResetResult {
  if (!queries || queries.length === 0) {
    const result = db
      .prepare("DELETE FROM retrieval_regression_baselines")
      .run() as { changes: number };
    return { removed: result.changes, queries: [] };
  }

  const normalized = queries.map((q) => q.trim()).filter(Boolean);
  if (normalized.length === 0) return { removed: 0, queries: [] };
  const placeholders = normalized.map(() => "?").join(", ");
  const result = db
    .prepare(
      `DELETE FROM retrieval_regression_baselines WHERE query IN (${placeholders})`
    )
    .run(...normalized) as { changes: number };
  return { removed: result.changes, queries: normalized };
}

export function promoteGoldenBaselinesFromRun(
  db: DatabaseSync,
  runId: string,
  queries?: string[]
): RetrievalBaselinePromoteResult {
  const rows = getRunRows(db, runId);
  if (rows.length === 0) {
    throw new Error(`Run ${runId} not found`);
  }

  const allowed = new Set(
    (queries ?? []).map((q) => q.trim()).filter(Boolean)
  );
  const targets = allowed.size > 0
    ? rows.filter((row) => allowed.has(row.query))
    : rows;

  const now = new Date().toISOString().replace("T", " ").replace("Z", "");
  const upsert = db.prepare(`
    INSERT INTO retrieval_regression_baselines (query, top_ids, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(query) DO UPDATE
    SET top_ids = excluded.top_ids,
        updated_at = excluded.updated_at
  `);

  let promoted = 0;
  for (const row of targets) {
    upsert.run(row.query, JSON.stringify(row.current_ids), now, now);
    promoted++;
  }

  return {
    run_id: runId,
    promoted,
    queries: targets.map((r) => r.query),
  };
}

export async function compareRetrievalAgainstRun(
  db: DatabaseSync,
  options: RetrievalRegressionCompareOptions
): Promise<RetrievalRegressionCompareResult> {
  const { limit, minOverlap, maxAvgShift } = getThresholds(db, options);
  const runRows = getRunRows(db, options.run_id);
  if (runRows.length === 0) {
    throw new Error(`Run ${options.run_id} not found`);
  }

  const includeMetadataDefault = options.include_metadata ?? false;
  const queryMap = getGoldenQueryMap(db);
  const search = new MemorySearch(db);

  const results: RetrievalRegressionQueryResult[] = [];
  let alerts = 0;

  for (const row of runRows) {
    const configured = queryMap.get(row.query);
    const searchQuery: SearchQuery = {
      query: row.query,
      limit,
      tags: configured?.tags,
      content_type: configured?.content_type,
      include_metadata: configured?.include_metadata ?? includeMetadataDefault,
    };
    const current = await search.search(searchQuery);
    const currentIds = current.map((r) => r.memory.id).slice(0, limit);
    const baselineIds = row.current_ids.slice(0, limit);
    const comparison = computeOverlapAtK(baselineIds, currentIds, limit);
    const isAlert =
      comparison.overlap < minOverlap ||
      comparison.avgShift > maxAvgShift;
    if (isAlert) alerts++;

    results.push({
      query: row.query,
      baseline_ids: baselineIds,
      current_ids: currentIds,
      overlap_at_10: comparison.overlap,
      avg_rank_shift: comparison.avgShift,
      exact_order: comparison.exact,
      alert: isAlert,
      initialized: false,
    });
  }

  return {
    run_id: options.run_id,
    ran: results.length,
    alerts,
    limit,
    min_overlap_at_10: minOverlap,
    max_avg_rank_shift: maxAvgShift,
    results,
  };
}

export async function runRetrievalRegression(
  db: DatabaseSync,
  options?: RetrievalRegressionOptions
): Promise<RetrievalRegressionResult> {
  const configuredQueries = options?.queries ?? getGoldenQueries(db);
  const queries = normalizeQueryDefinitions(configuredQueries);
  const thresholds = getThresholds(db, options);
  if (queries.length === 0) {
    return {
      ran: 0,
      initialized: 0,
      alerts: 0,
      limit: thresholds.limit,
      min_overlap_at_10: thresholds.minOverlap,
      max_avg_rank_shift: thresholds.maxAvgShift,
      results: [],
    };
  }

  const runId = ulid();
  const includeMetadataDefault = options?.include_metadata ?? false;
  const updateBaselines = options?.update_baselines ?? false;
  const createAlertMemory =
    options?.create_alert_memory ??
    (getSetting(db, "retrieval_regression.create_alert_memory") !== "false");

  const search = new MemorySearch(db);
  const now = new Date().toISOString().replace("T", " ").replace("Z", "");
  const baselineUpsert = db.prepare(`
    INSERT INTO retrieval_regression_baselines (query, top_ids, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(query) DO UPDATE
    SET top_ids = excluded.top_ids,
        updated_at = excluded.updated_at
  `);
  const runInsert = db.prepare(`
    INSERT INTO retrieval_regression_runs
      (run_group_id, query, baseline_ids, current_ids, overlap_at_10, avg_rank_shift, exact_order, alert, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const results: RetrievalRegressionQueryResult[] = [];
  let initialized = 0;
  let alerts = 0;

  for (const queryDef of queries) {
    const searchQuery: SearchQuery = {
      query: queryDef.query,
      limit: thresholds.limit,
      tags: queryDef.tags,
      content_type: queryDef.content_type,
      include_metadata: queryDef.include_metadata ?? includeMetadataDefault,
    };
    const current = await search.search(searchQuery);
    const currentIds = current.map((r) => r.memory.id).slice(0, thresholds.limit);

    const baselineRow = db
      .prepare("SELECT top_ids FROM retrieval_regression_baselines WHERE query = ?")
      .get(queryDef.query) as { top_ids: string } | undefined;
    const baselineIds = parseIdList(baselineRow?.top_ids).slice(
      0,
      thresholds.limit
    );

    if (!baselineRow) {
      baselineUpsert.run(queryDef.query, JSON.stringify(currentIds), now, now);
      runInsert.run(
        runId,
        queryDef.query,
        JSON.stringify([]),
        JSON.stringify(currentIds),
        1,
        0,
        1,
        0,
        now
      );
      initialized++;
      results.push({
        query: queryDef.query,
        baseline_ids: [],
        current_ids: currentIds,
        overlap_at_10: 1,
        avg_rank_shift: 0,
        exact_order: true,
        alert: false,
        initialized: true,
      });
      continue;
    }

    const comparison = computeOverlapAtK(
      baselineIds,
      currentIds,
      thresholds.limit
    );
    const isAlert =
      comparison.overlap < thresholds.minOverlap ||
      comparison.avgShift > thresholds.maxAvgShift;
    if (isAlert) alerts++;

    runInsert.run(
      runId,
      queryDef.query,
      JSON.stringify(baselineIds),
      JSON.stringify(currentIds),
      comparison.overlap,
      comparison.avgShift,
      comparison.exact ? 1 : 0,
      isAlert ? 1 : 0,
      now
    );

    if (updateBaselines) {
      baselineUpsert.run(queryDef.query, JSON.stringify(currentIds), now, now);
    }

    results.push({
      query: queryDef.query,
      baseline_ids: baselineIds,
      current_ids: currentIds,
      overlap_at_10: comparison.overlap,
      avg_rank_shift: comparison.avgShift,
      exact_order: comparison.exact,
      alert: isAlert,
      initialized: false,
    });
  }

  const summary: RetrievalRegressionResult = {
    run_id: runId,
    ran: results.length,
    initialized,
    alerts,
    limit: thresholds.limit,
    min_overlap_at_10: thresholds.minOverlap,
    max_avg_rank_shift: thresholds.maxAvgShift,
    results,
  };

  incrementCounter(db, "retrieval_regression.runs");
  incrementCounter(db, "retrieval_regression.queries", results.length);
  if (initialized > 0) {
    incrementCounter(db, "retrieval_regression.initialized_queries", initialized);
  }
  if (alerts > 0) {
    incrementCounter(db, "retrieval_regression.alerts", alerts);
  }

  if (alerts > 0 && createAlertMemory) {
    const alertLines = results
      .filter((r) => r.alert)
      .map(
        (r) =>
          `- ${r.query}: overlap@${thresholds.limit}=${(
            r.overlap_at_10 * 100
          ).toFixed(1)}%, avg-rank-shift=${r.avg_rank_shift.toFixed(2)}`
      );
    const report = [
      `Retrieval regression alerts (${now})`,
      "",
      `Run ID: ${runId}`,
      `Thresholds: overlap@${thresholds.limit} >= ${(
        thresholds.minOverlap * 100
      ).toFixed(1)}% and avg-rank-shift <= ${thresholds.maxAvgShift.toFixed(2)}`,
      "",
      ...alertLines,
    ].join("\n");

    const store = new MemoryStore(db);
    const created = await store.create({
      content: report,
      content_type: "summary",
      source: "consolidation",
      importance: 0.2,
      tags: ["retrieval-regression", "alert"],
      benchmark: true,
      metadata: {
        kind: "retrieval-regression-alert",
        run_id: runId,
        alerts,
        ran: results.length,
      },
    });
    summary.alert_memory_id = created.memory.id;
    incrementCounter(db, "retrieval_regression.alert_memories");
  }

  return summary;
}

