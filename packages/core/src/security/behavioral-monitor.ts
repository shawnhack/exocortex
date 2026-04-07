/**
 * Behavioral Monitor — detect anomalous patterns in memory access and storage
 * that could indicate memory poisoning or manipulation.
 *
 * Tracks baselines and flags deviations: sudden topic shifts, unusual
 * storage patterns from external sources, or memories that get accessed
 * disproportionately often after ingestion.
 */

import type { DatabaseSync } from "node:sqlite";

export interface AnomalyReport {
  anomalies: Anomaly[];
  stats: MonitorStats;
}

export interface Anomaly {
  type: AnomalyType;
  severity: "low" | "medium" | "high";
  memoryId?: string;
  detail: string;
}

export type AnomalyType =
  | "external_influence_spike"
  | "rapid_access_pattern"
  | "trust_level_mismatch"
  | "high_influence_external"
  | "bulk_external_ingestion";

export interface MonitorStats {
  totalMemories: number;
  externalMemories: number;
  externalPct: number;
  recentExternalCount: number;
  highInfluenceExternalCount: number;
}

/**
 * Run behavioral analysis on the memory store.
 * Checks for patterns that suggest manipulation or poisoning.
 */
export function runBehavioralAudit(db: DatabaseSync): AnomalyReport {
  const anomalies: Anomaly[] = [];

  // 1. Count total vs external memories
  const totalRow = db.prepare(
    "SELECT COUNT(*) as cnt FROM memories WHERE is_active = 1 AND parent_id IS NULL"
  ).get() as { cnt: number };
  const total = totalRow.cnt;

  const externalRow = db.prepare(
    `SELECT COUNT(*) as cnt FROM memories
     WHERE is_active = 1 AND parent_id IS NULL
       AND (source = 'url' OR source = 'import'
            OR json_extract(metadata, '$.trust_level') IN ('external', 'untrusted'))`
  ).get() as { cnt: number };
  const externalCount = externalRow.cnt;

  const externalPct = total > 0 ? (externalCount / total) * 100 : 0;

  // 2. Check for recent burst of external ingestion (last 24h)
  const recentExternalRow = db.prepare(
    `SELECT COUNT(*) as cnt FROM memories
     WHERE is_active = 1 AND parent_id IS NULL
       AND created_at >= datetime('now', '-1 day')
       AND (source = 'url' OR source = 'import'
            OR json_extract(metadata, '$.trust_level') IN ('external', 'untrusted'))`
  ).get() as { cnt: number };

  if (recentExternalRow.cnt > 20) {
    anomalies.push({
      type: "bulk_external_ingestion",
      severity: "medium",
      detail: `${recentExternalRow.cnt} external memories ingested in the last 24h — review for quality`,
    });
  }

  // 3. Check for high-influence external content
  const highInfluenceRows = db.prepare(
    `SELECT id, content, metadata FROM memories
     WHERE is_active = 1 AND parent_id IS NULL
       AND (source = 'url' OR source = 'import'
            OR json_extract(metadata, '$.trust_level') IN ('external', 'untrusted'))
       AND json_extract(metadata, '$.influence_score') > 0.4
     ORDER BY json_extract(metadata, '$.influence_score') DESC
     LIMIT 10`
  ).all() as Array<{ id: string; content: string; metadata: string }>;

  for (const row of highInfluenceRows) {
    const score = JSON.parse(row.metadata || "{}").influence_score ?? 0;
    anomalies.push({
      type: "high_influence_external",
      severity: score > 0.6 ? "high" : "medium",
      memoryId: row.id,
      detail: `External memory with influence score ${score}: "${row.content.slice(0, 80)}..."`,
    });
  }

  // 4. Check for memories accessed disproportionately soon after creation
  // (could indicate planted content designed to be retrieved by specific queries)
  const rapidAccessRows = db.prepare(
    `SELECT id, content, access_count, created_at, last_accessed_at FROM memories
     WHERE is_active = 1 AND parent_id IS NULL
       AND access_count > 5
       AND (julianday(last_accessed_at) - julianday(created_at)) < 1
       AND (source = 'url' OR source = 'import'
            OR json_extract(metadata, '$.trust_level') IN ('external', 'untrusted'))
     ORDER BY access_count DESC
     LIMIT 5`
  ).all() as Array<{ id: string; content: string; access_count: number; created_at: string; last_accessed_at: string }>;

  for (const row of rapidAccessRows) {
    anomalies.push({
      type: "rapid_access_pattern",
      severity: "medium",
      memoryId: row.id,
      detail: `External memory accessed ${row.access_count}x within first day: "${row.content.slice(0, 80)}..."`,
    });
  }

  // 5. Check for trust level mismatches — internal-tagged memories with external provenance
  const mismatchRows = db.prepare(
    `SELECT id, content, metadata FROM memories
     WHERE is_active = 1 AND parent_id IS NULL
       AND json_extract(metadata, '$.trust_level') = 'internal'
       AND json_extract(metadata, '$.provenance.source_trust') IN ('external', 'untrusted')
     LIMIT 5`
  ).all() as Array<{ id: string; content: string; metadata: string }>;

  for (const row of mismatchRows) {
    anomalies.push({
      type: "trust_level_mismatch",
      severity: "high",
      memoryId: row.id,
      detail: `Memory tagged 'internal' but provenance traces to external source: "${row.content.slice(0, 80)}..."`,
    });
  }

  return {
    anomalies,
    stats: {
      totalMemories: total,
      externalMemories: externalCount,
      externalPct: Math.round(externalPct * 10) / 10,
      recentExternalCount: recentExternalRow.cnt,
      highInfluenceExternalCount: highInfluenceRows.length,
    },
  };
}
