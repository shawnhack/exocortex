import type { DatabaseSync } from "node:sqlite";
import { runHealthChecks } from "./health.js";
import type { HealthCheck } from "./health.js";
import { getContradictions } from "./contradictions.js";

export interface LintIssue {
  category: string;
  severity: "info" | "warn" | "critical";
  message: string;
  count?: number;
  ids?: string[];
}

export interface LintReport {
  overall: "ok" | "warn" | "critical";
  issues: LintIssue[];
  stats: {
    total_memories: number;
    total_entities: number;
    contradictions_pending: number;
    stale_claims: number;
    orphan_entities: number;
    unlinked_memories: number;
    suggested_topics: string[];
  };
}

/**
 * Comprehensive knowledge-base lint: health checks + knowledge-specific audits.
 * Finds contradictions, stale claims, orphan entities, unlinked memories,
 * and suggests new topics for wiki articles.
 */
export function runLint(db: DatabaseSync): LintReport {
  const issues: LintIssue[] = [];

  // 1. Run existing health checks
  const health = runHealthChecks(db);
  for (const check of health.checks) {
    if (check.status !== "ok") {
      issues.push({
        category: "health",
        severity: check.status,
        message: check.message,
        count: check.value,
      });
    }
  }

  // 2. Pending contradictions
  let contradictionCount = 0;
  try {
    const contradictions = getContradictions(db, "pending", 100);
    contradictionCount = contradictions.length;
    if (contradictionCount > 0) {
      issues.push({
        category: "contradictions",
        severity: contradictionCount > 5 ? "critical" : "warn",
        message: `${contradictionCount} unresolved contradiction(s)`,
        count: contradictionCount,
      });
    }
  } catch { /* contradictions table may not exist */ }

  // 3. Stale claims — memories superseded but still active
  let staleClaims = 0;
  try {
    const staleRows = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM memories
         WHERE is_active = 1 AND superseded_by IS NOT NULL`
      )
      .get() as { cnt: number };
    staleClaims = staleRows.cnt;
    if (staleClaims > 0) {
      issues.push({
        category: "stale-claims",
        severity: staleClaims > 10 ? "warn" : "info",
        message: `${staleClaims} superseded memor${staleClaims === 1 ? "y" : "ies"} still active`,
        count: staleClaims,
      });
    }
  } catch { /* superseded_by column may not exist */ }

  // 4. Orphan entities — entities with no linked active memories
  let orphanEntities = 0;
  try {
    const orphanRow = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM entities e
         WHERE NOT EXISTS (
           SELECT 1 FROM memory_entities me
           JOIN memories m ON me.memory_id = m.id
           WHERE me.entity_id = e.id AND m.is_active = 1
         )`
      )
      .get() as { cnt: number };
    orphanEntities = orphanRow.cnt;
  } catch { /* entities table may not exist */ }

  // 5. Unlinked memories — active memories with no entity links
  let unlinkedMemories = 0;
  try {
    const unlinkedRow = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM memories m
         WHERE m.is_active = 1 AND m.parent_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM memory_entities me WHERE me.memory_id = m.id
           )`
      )
      .get() as { cnt: number };
    unlinkedMemories = unlinkedRow.cnt;
    const totalRow = db
      .prepare("SELECT COUNT(*) as cnt FROM memories WHERE is_active = 1 AND parent_id IS NULL")
      .get() as { cnt: number };
    const pct = totalRow.cnt > 0 ? Math.round((unlinkedMemories / totalRow.cnt) * 100) : 0;
    if (pct > 50) {
      issues.push({
        category: "unlinked",
        severity: "warn",
        message: `${pct}% of memories have no entity links (${unlinkedMemories}/${totalRow.cnt})`,
        count: unlinkedMemories,
      });
    }
  } catch { /* skip on error */ }

  // 6. Orphaned chunks — active children of inactive parents
  let orphanChunks = 0;
  try {
    const orphanChunkRow = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM memories c
         WHERE c.parent_id IS NOT NULL AND c.is_active = 1
         AND EXISTS (SELECT 1 FROM memories p WHERE p.id = c.parent_id AND p.is_active = 0)`
      )
      .get() as { cnt: number };
    orphanChunks = orphanChunkRow.cnt;
    if (orphanChunks > 0) {
      issues.push({
        category: "orphan-chunks",
        severity: orphanChunks > 50 ? "warn" : "info",
        message: `${orphanChunks} active chunk(s) under inactive parents — will be cleaned up by nightly maintenance`,
        count: orphanChunks,
      });
    }
  } catch { /* skip */ }

  // 7. Suggested wiki topics — high-frequency tags without wiki articles
  const suggestedTopics: string[] = [];
  try {
    const topTags = db
      .prepare(
        `SELECT tag, COUNT(*) as cnt
         FROM memory_tags mt
         JOIN memories m ON mt.memory_id = m.id
         WHERE m.is_active = 1 AND m.parent_id IS NULL
         GROUP BY tag
         HAVING COUNT(*) >= 5
         ORDER BY COUNT(*) DESC
         LIMIT 20`
      )
      .all() as Array<{ tag: string; cnt: number }>;

    // Check which tags already have namespace-based articles
    const existingNamespaces = new Set<string>();
    try {
      const nsRows = db
        .prepare(
          `SELECT DISTINCT namespace FROM memories
           WHERE is_active = 1 AND namespace IS NOT NULL AND namespace != ''`
        )
        .all() as Array<{ namespace: string }>;
      for (const r of nsRows) existingNamespaces.add(r.namespace.toLowerCase());
    } catch { /* skip */ }

    for (const { tag, cnt } of topTags) {
      if (!existingNamespaces.has(tag.toLowerCase()) && cnt >= 5) {
        suggestedTopics.push(`${tag} (${cnt} memories)`);
      }
    }

    if (suggestedTopics.length > 0) {
      issues.push({
        category: "suggested-topics",
        severity: "info",
        message: `${suggestedTopics.length} tag(s) with 5+ memories could become wiki articles`,
        count: suggestedTopics.length,
      });
    }
  } catch { /* skip */ }

  // 8. Total stats
  let totalMemories = 0;
  try {
    totalMemories = (db.prepare("SELECT COUNT(*) as cnt FROM memories WHERE is_active = 1").get() as { cnt: number }).cnt;
  } catch { /* skip */ }
  let totalEntities = 0;
  try {
    totalEntities = (db.prepare("SELECT COUNT(*) as cnt FROM entities").get() as { cnt: number }).cnt;
  } catch { /* skip */ }

  // Overall severity
  const severityOrder: Record<string, number> = { info: 0, ok: 0, warn: 1, critical: 2 };
  let worst: "ok" | "warn" | "critical" = "ok";
  for (const issue of issues) {
    if (severityOrder[issue.severity] > severityOrder[worst]) {
      worst = issue.severity as "warn" | "critical";
    }
  }

  return {
    overall: worst,
    issues,
    stats: {
      total_memories: totalMemories,
      total_entities: totalEntities,
      contradictions_pending: contradictionCount,
      stale_claims: staleClaims,
      orphan_entities: orphanEntities,
      unlinked_memories: unlinkedMemories,
      suggested_topics: suggestedTopics,
    },
  };
}
