import type { DatabaseSync } from "node:sqlite";
import { findClusters } from "./consolidation.js";

export interface HealthCheck {
  name: string;
  status: "ok" | "warn" | "critical";
  message: string;
  value?: number;
  threshold?: number;
}

export interface HealthReport {
  overall: "ok" | "warn" | "critical";
  checks: HealthCheck[];
}

function checkEmbeddingGap(db: DatabaseSync): HealthCheck {
  const total = (
    db.prepare("SELECT COUNT(*) as n FROM memories WHERE is_active = 1").get() as { n: number }
  ).n;

  if (total === 0) {
    return { name: "Embedding gap", status: "ok", message: "No active memories", value: 0, threshold: 10 };
  }

  const missing = (
    db.prepare("SELECT COUNT(*) as n FROM memories WHERE is_active = 1 AND embedding IS NULL").get() as { n: number }
  ).n;

  const pct = Math.round((missing / total) * 100);

  if (pct > 30) return { name: "Embedding gap", status: "critical", message: `${pct}% of active memories have no embedding (${missing}/${total})`, value: pct, threshold: 30 };
  if (pct > 10) return { name: "Embedding gap", status: "warn", message: `${pct}% of active memories have no embedding (${missing}/${total})`, value: pct, threshold: 10 };
  return { name: "Embedding gap", status: "ok", message: `${pct}% missing embeddings (${missing}/${total})`, value: pct, threshold: 10 };
}

function checkTagSparsity(db: DatabaseSync): HealthCheck {
  const total = (
    db.prepare("SELECT COUNT(*) as n FROM memories WHERE is_active = 1").get() as { n: number }
  ).n;

  if (total === 0) {
    return { name: "Tag sparsity", status: "ok", message: "No active memories", value: 0, threshold: 30 };
  }

  const withTags = (
    db.prepare("SELECT COUNT(DISTINCT memory_id) as n FROM memory_tags mt INNER JOIN memories m ON mt.memory_id = m.id WHERE m.is_active = 1").get() as { n: number }
  ).n;

  const untagged = total - withTags;
  const pct = Math.round((untagged / total) * 100);

  if (pct > 60) return { name: "Tag sparsity", status: "critical", message: `${pct}% of active memories have no tags (${untagged}/${total})`, value: pct, threshold: 60 };
  if (pct > 30) return { name: "Tag sparsity", status: "warn", message: `${pct}% of active memories have no tags (${untagged}/${total})`, value: pct, threshold: 30 };
  return { name: "Tag sparsity", status: "ok", message: `${pct}% untagged (${untagged}/${total})`, value: pct, threshold: 30 };
}

function checkEntityOrphans(db: DatabaseSync): HealthCheck {
  const orphans = (
    db.prepare("SELECT COUNT(*) as n FROM entities e WHERE NOT EXISTS (SELECT 1 FROM memory_entities me WHERE me.entity_id = e.id)").get() as { n: number }
  ).n;

  if (orphans > 50) return { name: "Entity orphans", status: "critical", message: `${orphans} entities with no linked memories`, value: orphans, threshold: 50 };
  if (orphans > 20) return { name: "Entity orphans", status: "warn", message: `${orphans} entities with no linked memories`, value: orphans, threshold: 20 };
  return { name: "Entity orphans", status: "ok", message: `${orphans} orphan entities`, value: orphans, threshold: 20 };
}

function checkRetrievalDesert(db: DatabaseSync): HealthCheck {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace("T", " ")
    .replace("Z", "");

  const eligible = (
    db.prepare("SELECT COUNT(*) as n FROM memories WHERE is_active = 1 AND created_at < ?").get(cutoff) as { n: number }
  ).n;

  if (eligible === 0) {
    return { name: "Retrieval desert", status: "ok", message: "No memories older than 30 days", value: 0, threshold: 50 };
  }

  const neverAccessed = (
    db.prepare("SELECT COUNT(*) as n FROM memories WHERE is_active = 1 AND access_count = 0 AND created_at < ?").get(cutoff) as { n: number }
  ).n;

  const pct = Math.round((neverAccessed / eligible) * 100);

  if (pct > 80) return { name: "Retrieval desert", status: "critical", message: `${pct}% of memories older than 30d never accessed (${neverAccessed}/${eligible})`, value: pct, threshold: 80 };
  if (pct > 50) return { name: "Retrieval desert", status: "warn", message: `${pct}% of memories older than 30d never accessed (${neverAccessed}/${eligible})`, value: pct, threshold: 50 };
  return { name: "Retrieval desert", status: "ok", message: `${pct}% never accessed (${neverAccessed}/${eligible} older than 30d)`, value: pct, threshold: 50 };
}

function checkImportanceCollapse(db: DatabaseSync): HealthCheck {
  const row = db.prepare("SELECT AVG(importance) as avg FROM memories WHERE is_active = 1").get() as { avg: number | null };
  const avg = row.avg ?? 0.5;
  const rounded = Math.round(avg * 100) / 100;

  if (avg < 0.2) return { name: "Importance collapse", status: "critical", message: `Average importance is ${rounded} — most memories are low-value`, value: rounded, threshold: 0.2 };
  if (avg < 0.3) return { name: "Importance collapse", status: "warn", message: `Average importance is ${rounded} — trending low`, value: rounded, threshold: 0.3 };
  return { name: "Importance collapse", status: "ok", message: `Average importance: ${rounded}`, value: rounded, threshold: 0.3 };
}

function checkConsolidationBacklog(db: DatabaseSync): HealthCheck {
  let clusterCount: number;
  try {
    const clusters = findClusters(db);
    clusterCount = clusters.length;
  } catch {
    return { name: "Consolidation backlog", status: "ok", message: "Could not compute clusters", value: 0, threshold: 5 };
  }

  if (clusterCount > 15) return { name: "Consolidation backlog", status: "critical", message: `${clusterCount} clusters awaiting consolidation`, value: clusterCount, threshold: 15 };
  if (clusterCount > 5) return { name: "Consolidation backlog", status: "warn", message: `${clusterCount} clusters awaiting consolidation`, value: clusterCount, threshold: 5 };
  return { name: "Consolidation backlog", status: "ok", message: `${clusterCount} pending clusters`, value: clusterCount, threshold: 5 };
}

function checkGrowthStall(db: DatabaseSync): HealthCheck {
  const row = db.prepare("SELECT MAX(created_at) as newest FROM memories WHERE is_active = 1").get() as { newest: string | null };

  if (!row.newest) {
    return { name: "Growth stall", status: "ok", message: "No active memories", value: 0, threshold: 14 };
  }

  const newestDate = new Date(row.newest.replace(" ", "T") + "Z");
  const daysSince = Math.floor((Date.now() - newestDate.getTime()) / (24 * 60 * 60 * 1000));

  if (daysSince > 30) return { name: "Growth stall", status: "critical", message: `${daysSince} days since last new memory`, value: daysSince, threshold: 30 };
  if (daysSince > 14) return { name: "Growth stall", status: "warn", message: `${daysSince} days since last new memory`, value: daysSince, threshold: 14 };
  return { name: "Growth stall", status: "ok", message: `Last memory: ${daysSince} day(s) ago`, value: daysSince, threshold: 14 };
}

function checkStaleAccess(db: DatabaseSync): HealthCheck {
  const row = db.prepare("SELECT MAX(accessed_at) as latest FROM access_log").get() as { latest: string | null };

  if (!row.latest) {
    return { name: "Stale access", status: "warn", message: "No access log entries found", value: 999, threshold: 14 };
  }

  const latestDate = new Date(row.latest.replace(" ", "T") + "Z");
  const daysSince = Math.floor((Date.now() - latestDate.getTime()) / (24 * 60 * 60 * 1000));

  if (daysSince > 30) return { name: "Stale access", status: "critical", message: `${daysSince} days since last memory access`, value: daysSince, threshold: 30 };
  if (daysSince > 14) return { name: "Stale access", status: "warn", message: `${daysSince} days since last memory access`, value: daysSince, threshold: 14 };
  return { name: "Stale access", status: "ok", message: `Last access: ${daysSince} day(s) ago`, value: daysSince, threshold: 14 };
}

export function runHealthChecks(db: DatabaseSync): HealthReport {
  const checks: HealthCheck[] = [
    checkEmbeddingGap(db),
    checkTagSparsity(db),
    checkEntityOrphans(db),
    checkRetrievalDesert(db),
    checkImportanceCollapse(db),
    checkConsolidationBacklog(db),
    checkGrowthStall(db),
    checkStaleAccess(db),
  ];

  const statusPriority: Record<string, number> = { ok: 0, warn: 1, critical: 2 };
  let worstStatus: "ok" | "warn" | "critical" = "ok";

  for (const check of checks) {
    if (statusPriority[check.status] > statusPriority[worstStatus]) {
      worstStatus = check.status;
    }
  }

  return { overall: worstStatus, checks };
}
