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
  totalMemories: number;
  searches: number;
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
  granularity: "month" | "week" | "day" = "month",
  limit = 12
): QualityTrendEntry[] {
  const format =
    granularity === "day" ? "%Y-%m-%d" : granularity === "month" ? "%Y-%m" : "%Y-W%W";

  // Single query: per-period stats with window functions for cumulative totals
  const rows = db
    .prepare(
      `WITH active_period AS (
         SELECT
           strftime('${format}', created_at) as period,
           COUNT(*) as created,
           SUM(useful_count) as sum_useful,
           SUM(CASE WHEN access_count = 0 THEN 1 ELSE 0 END) as sum_never
         FROM memories WHERE is_active = 1
         GROUP BY period
       ),
       all_period AS (
         SELECT
           strftime('${format}', created_at) as period,
           COUNT(*) as created_all
         FROM memories
         GROUP BY period
       ),
       cumulative AS (
         SELECT
           a.period,
           a.created,
           SUM(COALESCE(t.created_all, a.created)) OVER (ORDER BY a.period) as total_memories,
           SUM(a.sum_useful) OVER (ORDER BY a.period) as cum_useful,
           SUM(a.created) OVER (ORDER BY a.period) as cum_count,
           SUM(a.sum_never) OVER (ORDER BY a.period) as cum_never
         FROM active_period a
         LEFT JOIN all_period t ON t.period = a.period
       ),
       searches AS (
         SELECT
           strftime('${format}', accessed_at) as period,
           COUNT(DISTINCT query || ':' || strftime('%Y-%m-%dT%H:%M', accessed_at)) as searches
         FROM access_log
         WHERE query IS NOT NULL
         GROUP BY period
       )
       SELECT
         c.period,
         c.created,
         c.total_memories,
         COALESCE(s.searches, 0) as searches,
         CASE WHEN c.cum_count > 0 THEN ROUND(1.0 * c.cum_useful / c.cum_count, 2) ELSE 0 END as avg_useful,
         CASE WHEN c.cum_count > 0 THEN ROUND(100.0 * c.cum_never / c.cum_count, 1) ELSE 0 END as never_accessed_pct
       FROM cumulative c
       LEFT JOIN searches s ON s.period = c.period
       ORDER BY c.period DESC
       LIMIT ?`
    )
    .all(limit) as Array<{
    period: string;
    created: number;
    total_memories: number;
    searches: number;
    avg_useful: number;
    never_accessed_pct: number;
  }>;

  return rows.map((r) => ({
    period: r.period,
    created: r.created,
    totalMemories: r.total_memories,
    searches: r.searches,
    avgUseful: r.avg_useful,
    neverAccessedPct: r.never_accessed_pct,
  }));
}

// --- Quality Histogram ---

export interface QualityHistogramBucket {
  bucket: string;
  count: number;
}

export function getQualityHistogram(db: DatabaseSync): QualityHistogramBucket[] {
  const buckets: QualityHistogramBucket[] = [];

  for (let i = 0; i < 10; i++) {
    const lo = i / 10;
    const hi = (i + 1) / 10;
    const label = `${lo.toFixed(1)}-${hi.toFixed(1)}`;

    // Last bucket is inclusive on the right: [0.9, 1.0]
    const op = i === 9 ? "<=" : "<";
    const row = db
      .prepare(
        `SELECT COUNT(*) as count FROM memories
         WHERE is_active = 1 AND quality_score IS NOT NULL
           AND quality_score >= ? AND quality_score ${op} ?`
      )
      .get(lo, hi) as { count: number };

    buckets.push({ bucket: label, count: row.count });
  }

  return buckets;
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

// --- Retrieval Stats ---

export interface RetrievalStats {
  hit_rate: number;
  top_underserved_queries: Array<{ query: string; count: number }>;
  most_accessed: Array<{ id: string; title: string; access_count: number }>;
  least_accessed_count: number;
  feedback_summary: {
    total_with_feedback: number;
    avg_useful_count: number;
  };
}

export function getRetrievalStats(db: DatabaseSync): RetrievalStats {
  // 1. hit_rate: % of access_log queries (searches) that led to a memory_get within 5 min
  //    A search logs an access_log entry for each returned memory.
  //    We approximate "search sessions" as distinct (query, 5-min window) groups.
  //    A "hit" is a search where the user later did memory_get (accessed again
  //    within 5 min with a NULL query -- but access_log always has a query from search).
  //    Better proxy: count distinct queries in access_log. Searches that return results
  //    are "hits" (the access was recorded). Searches with 0 results never appear in access_log.
  //    So hit_rate = searches with access_log entries / total search count from query_outcomes.
  const totalSearches = (
    db
      .prepare("SELECT SUM(search_count) as total FROM query_outcomes")
      .get() as { total: number | null }
  ).total ?? 0;

  const searchesWithResults = (
    db
      .prepare(
        "SELECT SUM(search_count) as total FROM query_outcomes WHERE result_count_avg > 0"
      )
      .get() as { total: number | null }
  ).total ?? 0;

  const hitRate =
    totalSearches > 0
      ? Math.round((searchesWithResults / totalSearches) * 1000) / 10
      : 0;

  // 2. top_underserved_queries: queries that produced 0 useful results (from search_misses)
  const underserved = db
    .prepare(
      `SELECT query, COUNT(*) as count
       FROM search_misses
       GROUP BY query
       ORDER BY count DESC
       LIMIT 10`
    )
    .all() as unknown as Array<{ query: string; count: number }>;

  // 3. most_accessed: top 10 memories by access_count
  const mostAccessed = (
    db
      .prepare(
        `SELECT id, content, access_count
         FROM memories
         WHERE is_active = 1
         ORDER BY access_count DESC
         LIMIT 10`
      )
      .all() as unknown as Array<{
      id: string;
      content: string;
      access_count: number;
    }>
  ).map((r) => ({
    id: r.id,
    title: r.content.length > 80 ? r.content.slice(0, 80) + "..." : r.content,
    access_count: r.access_count,
  }));

  // 4. least_accessed: count of memories with access_count = 0 older than 14 days
  const fourteenDaysAgo = new Date(Date.now() - 14 * 86400000)
    .toISOString()
    .replace("T", " ")
    .replace("Z", "");
  const leastAccessedCount = (
    db
      .prepare(
        `SELECT COUNT(*) as count FROM memories
         WHERE is_active = 1 AND access_count = 0 AND created_at <= ?`
      )
      .get(fourteenDaysAgo) as { count: number }
  ).count;

  // 5. feedback_summary: memories with useful_count > 0
  const feedback = db
    .prepare(
      `SELECT COUNT(*) as total, AVG(useful_count) as avg_useful
       FROM memories
       WHERE is_active = 1 AND useful_count > 0`
    )
    .get() as { total: number; avg_useful: number | null };

  return {
    hit_rate: hitRate,
    top_underserved_queries: underserved.map((r) => ({
      query: r.query,
      count: r.count,
    })),
    most_accessed: mostAccessed,
    least_accessed_count: leastAccessedCount,
    feedback_summary: {
      total_with_feedback: feedback.total,
      avg_useful_count:
        Math.round((feedback.avg_useful ?? 0) * 100) / 100,
    },
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
