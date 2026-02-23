import type { DatabaseSync } from "node:sqlite";

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
