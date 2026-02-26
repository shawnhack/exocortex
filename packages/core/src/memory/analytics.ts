import type { DatabaseSync } from "node:sqlite";
import { qualityScore } from "./scoring.js";

// --- Types ---

export interface AnalyticsSummary {
  totalActive: number;
  neverAccessedPct: number;
  usefulPct: number;
  medianAccessCount: number;
}

export interface AccessBucket {
  label: string;
  count: number;
}

export interface TagEffectiveness {
  tag: string;
  memoryCount: number;
  avgUsefulCount: number;
}

export interface ProducerQuality {
  producer: string;
  memoryCount: number;
  avgUsefulCount: number;
}

export interface QualityTrendEntry {
  period: string;
  created: number;
  avgUseful: number;
  neverAccessedPct: number;
}

// --- Queries ---

export function getAnalyticsSummary(db: DatabaseSync): AnalyticsSummary {
  const row = db
    .prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN access_count = 0 THEN 1 ELSE 0 END) as never_accessed,
        SUM(CASE WHEN useful_count > 0 THEN 1 ELSE 0 END) as useful
       FROM memories WHERE is_active = 1`
    )
    .get() as { total: number; never_accessed: number; useful: number };

  const total = row.total || 0;
  const neverAccessedPct =
    total > 0 ? Math.round((row.never_accessed / total) * 1000) / 10 : 0;
  const usefulPct =
    total > 0 ? Math.round((row.useful / total) * 1000) / 10 : 0;

  // Median access count via percentile
  const median = db
    .prepare(
      `SELECT access_count FROM memories
       WHERE is_active = 1
       ORDER BY access_count
       LIMIT 1 OFFSET (SELECT COUNT(*) / 2 FROM memories WHERE is_active = 1)`
    )
    .get() as { access_count: number } | undefined;

  return {
    totalActive: total,
    neverAccessedPct,
    usefulPct,
    medianAccessCount: median?.access_count ?? 0,
  };
}

export function getAccessDistribution(db: DatabaseSync): AccessBucket[] {
  const buckets = [
    { label: "0", min: 0, max: 0 },
    { label: "1-5", min: 1, max: 5 },
    { label: "6-20", min: 6, max: 20 },
    { label: "21-100", min: 21, max: 100 },
    { label: "100+", min: 101, max: 999999 },
  ];

  return buckets.map((b) => {
    const row = db
      .prepare(
        `SELECT COUNT(*) as count FROM memories
         WHERE is_active = 1 AND access_count >= ? AND access_count <= ?`
      )
      .get(b.min, b.max) as { count: number };
    return { label: b.label, count: row.count };
  });
}

export function getTagEffectiveness(
  db: DatabaseSync,
  limit = 20
): TagEffectiveness[] {
  const rows = db
    .prepare(
      `SELECT mt.tag, COUNT(*) as memory_count,
              ROUND(AVG(m.useful_count), 2) as avg_useful
       FROM memory_tags mt
       JOIN memories m ON m.id = mt.memory_id
       WHERE m.is_active = 1
       GROUP BY mt.tag
       HAVING COUNT(*) >= 3
       ORDER BY avg_useful DESC
       LIMIT ?`
    )
    .all(limit) as unknown as Array<{
    tag: string;
    memory_count: number;
    avg_useful: number;
  }>;

  return rows.map((r) => ({
    tag: r.tag,
    memoryCount: r.memory_count,
    avgUsefulCount: r.avg_useful,
  }));
}

export function getProducerQuality(
  db: DatabaseSync,
  by: "model" | "agent" = "model",
  limit = 15
): ProducerQuality[] {
  const column = by === "model" ? "model_id" : "agent";

  const rows = db
    .prepare(
      `SELECT ${column} as producer, COUNT(*) as memory_count,
              ROUND(AVG(useful_count), 2) as avg_useful
       FROM memories
       WHERE is_active = 1 AND ${column} IS NOT NULL
       GROUP BY ${column}
       HAVING COUNT(*) >= 3
       ORDER BY avg_useful DESC
       LIMIT ?`
    )
    .all(limit) as unknown as Array<{
    producer: string;
    memory_count: number;
    avg_useful: number;
  }>;

  return rows.map((r) => ({
    producer: r.producer,
    memoryCount: r.memory_count,
    avgUsefulCount: r.avg_useful,
  }));
}

export function getQualityTrend(
  db: DatabaseSync,
  granularity: "month" | "week" = "month",
  limit = 12
): QualityTrendEntry[] {
  const format =
    granularity === "month" ? "%Y-%m" : "%Y-W%W";

  const rows = db
    .prepare(
      `SELECT
        strftime('${format}', created_at) as period,
        COUNT(*) as created,
        ROUND(AVG(useful_count), 2) as avg_useful,
        ROUND(100.0 * SUM(CASE WHEN access_count = 0 THEN 1 ELSE 0 END) / COUNT(*), 1) as never_accessed_pct
       FROM memories
       WHERE is_active = 1
       GROUP BY period
       ORDER BY period DESC
       LIMIT ?`
    )
    .all(limit) as unknown as Array<{
    period: string;
    created: number;
    avg_useful: number;
    never_accessed_pct: number;
  }>;

  return rows.map((r) => ({
    period: r.period,
    created: r.created,
    avgUseful: r.avg_useful,
    neverAccessedPct: r.never_accessed_pct,
  }));
}

// --- Quality Distribution ---

export interface QualityDistribution {
  avg: number;
  median: number;
  p10: number;
  p90: number;
  highQuality: number;
  lowQuality: number;
  total: number;
}

export function getQualityDistribution(db: DatabaseSync): QualityDistribution {
  const rows = db
    .prepare(
      `SELECT m.importance, m.useful_count, m.access_count, m.created_at,
              (SELECT COUNT(*) FROM memory_links WHERE source_id = m.id OR target_id = m.id) as link_count
       FROM memories m
       WHERE m.is_active = 1`
    )
    .all() as Array<{
    importance: number;
    useful_count: number;
    access_count: number;
    created_at: string;
    link_count: number;
  }>;

  if (rows.length === 0) {
    return { avg: 0, median: 0, p10: 0, p90: 0, highQuality: 0, lowQuality: 0, total: 0 };
  }

  const now = Date.now();
  const scores = rows.map((r) => {
    const ageDays = (now - new Date(r.created_at + "Z").getTime()) / (1000 * 60 * 60 * 24);
    return qualityScore(r.importance, r.useful_count, r.access_count, r.link_count, ageDays);
  });

  scores.sort((a, b) => a - b);

  const avg = Math.round((scores.reduce((s, v) => s + v, 0) / scores.length) * 1000) / 1000;
  const percentile = (p: number) => {
    const idx = Math.floor((p / 100) * (scores.length - 1));
    return Math.round(scores[idx] * 1000) / 1000;
  };

  return {
    avg,
    median: percentile(50),
    p10: percentile(10),
    p90: percentile(90),
    highQuality: scores.filter((s) => s >= 0.5).length,
    lowQuality: scores.filter((s) => s < 0.2).length,
    total: scores.length,
  };
}

// --- Query Outcome Analytics ---

export interface QueryOutcome {
  query: string;
  search_count: number;
  result_count_avg: number;
  feedback_count: number;
  feedback_ratio: number;
  last_queried_at: string;
}

export function getQueryOutcomes(
  db: DatabaseSync,
  opts: {
    limit?: number;
    minSearches?: number;
    sortBy?: "searches" | "feedback_ratio" | "zero_feedback";
  } = {}
): QueryOutcome[] {
  const limit = opts.limit ?? 20;
  const minSearches = opts.minSearches ?? 1;
  const sortBy = opts.sortBy ?? "searches";

  let orderClause: string;
  let extraWhere = "";
  switch (sortBy) {
    case "feedback_ratio":
      orderClause = "ORDER BY (CAST(feedback_count AS REAL) / search_count) DESC";
      break;
    case "zero_feedback":
      extraWhere = " AND feedback_count = 0";
      orderClause = "ORDER BY search_count DESC";
      break;
    default:
      orderClause = "ORDER BY search_count DESC";
  }

  const rows = db
    .prepare(
      `SELECT query, search_count, result_count_avg, feedback_count, last_queried_at
       FROM query_outcomes
       WHERE search_count >= ?${extraWhere}
       ${orderClause}
       LIMIT ?`
    )
    .all(minSearches, limit) as unknown as Array<{
    query: string;
    search_count: number;
    result_count_avg: number;
    feedback_count: number;
    last_queried_at: string;
  }>;

  return rows.map((r) => ({
    query: r.query,
    search_count: r.search_count,
    result_count_avg: Math.round(r.result_count_avg * 10) / 10,
    feedback_count: r.feedback_count,
    feedback_ratio:
      r.search_count > 0
        ? Math.round((r.feedback_count / r.search_count) * 1000) / 10
        : 0,
    last_queried_at: r.last_queried_at,
  }));
}
