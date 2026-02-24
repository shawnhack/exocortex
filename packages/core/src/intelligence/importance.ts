import type { DatabaseSync } from "node:sqlite";
import { getSetting } from "../db/schema.js";
import { computeCentrality } from "../entities/graph.js";
import { qualityScore } from "../memory/scoring.js";

export interface ImportanceAdjustOptions {
  dryRun?: boolean;
  boostThreshold?: number;
  decayAgeDays?: number;
}

export interface ImportanceAdjustResult {
  boosted: number;
  decayed: number;
  dry_run: boolean;
  details: Array<{
    id: string;
    action: "boost" | "decay";
    old_importance: number;
    new_importance: number;
  }>;
}

/**
 * Adjust importance scores based on access patterns:
 * - Boost: frequently accessed memories (access_count >= threshold) get importance += 0.1
 * - Decay: never-accessed old memories get importance -= 0.05
 * - Pinned (importance = 1.0) are never touched
 */
export function adjustImportance(
  db: DatabaseSync,
  opts: ImportanceAdjustOptions = {}
): ImportanceAdjustResult {
  const dryRun = opts.dryRun ?? false;
  const boostThreshold =
    opts.boostThreshold ??
    parseInt(getSetting(db, "importance.boost_threshold") ?? "5", 10);
  const decayAgeDays =
    opts.decayAgeDays ??
    parseInt(getSetting(db, "importance.decay_age_days") ?? "30", 10);

  const details: ImportanceAdjustResult["details"] = [];

  // Boost: access_count >= threshold, importance < 0.8, importance != 1.0
  // Quality-aware: bigger boost for high-quality memories
  const boostCandidates = db
    .prepare(
      `SELECT m.id, m.importance, m.useful_count, m.access_count, m.created_at,
              (SELECT COUNT(*) FROM memory_links WHERE source_id = m.id OR target_id = m.id) as link_count
       FROM memories m
       WHERE m.is_active = 1
         AND m.access_count >= ?
         AND m.importance < 0.8
         AND ROUND(m.importance, 2) != 1.0`
    )
    .all(boostThreshold) as Array<{ id: string; importance: number; useful_count: number; access_count: number; created_at: string; link_count: number }>;

  const now = Date.now();
  for (const row of boostCandidates) {
    const ageDays = (now - new Date(row.created_at + "Z").getTime()) / (1000 * 60 * 60 * 24);
    const quality = qualityScore(row.importance, row.useful_count, row.access_count, row.link_count, ageDays);
    // Higher quality → bigger boost: +0.10 if quality >= 0.7, +0.05 otherwise
    const boost = quality >= 0.7 ? 0.10 : 0.05;
    const newImportance = Math.min(0.9, row.importance + boost);
    if (newImportance !== row.importance) {
      details.push({
        id: row.id,
        action: "boost",
        old_importance: row.importance,
        new_importance: Math.round(newImportance * 100) / 100,
      });
    }
  }

  // Decay: access_count = 0, age > decayAgeDays, importance > 0.3, importance != 1.0
  // Quality-aware: only decay if quality < 0.2 (protects memories with usefulness signals or links)
  const cutoffDate = new Date(
    Date.now() - decayAgeDays * 24 * 60 * 60 * 1000
  )
    .toISOString()
    .replace("T", " ")
    .replace("Z", "");

  const decayCandidates = db
    .prepare(
      `SELECT m.id, m.importance, m.useful_count, m.access_count, m.created_at,
              (SELECT COUNT(*) FROM memory_links WHERE source_id = m.id OR target_id = m.id) as link_count
       FROM memories m
       WHERE m.is_active = 1
         AND m.access_count = 0
         AND m.created_at < ?
         AND m.importance > 0.3
         AND ROUND(m.importance, 2) != 1.0`
    )
    .all(cutoffDate) as Array<{ id: string; importance: number; useful_count: number; access_count: number; created_at: string; link_count: number }>;

  for (const row of decayCandidates) {
    const ageDays = (now - new Date(row.created_at + "Z").getTime()) / (1000 * 60 * 60 * 24);
    const quality = qualityScore(row.importance, row.useful_count, row.access_count, row.link_count, ageDays);
    // Only decay if quality is low — protects memories with usefulness signals or links
    if (quality >= 0.2) continue;
    const newImportance = Math.max(0.1, row.importance - 0.05);
    details.push({
      id: row.id,
      action: "decay",
      old_importance: row.importance,
      new_importance: Math.round(newImportance * 100) / 100,
    });
  }

  // Graph-aware boost: memories linked to high-centrality entities get +0.05
  try {
    const centrality = computeCentrality(db);
    if (centrality.length > 0) {
      const top10pct = Math.max(1, Math.ceil(centrality.length * 0.1));
      const highCentralityIds = new Set(
        centrality.slice(0, top10pct).map((c) => c.entityId)
      );

      // Find active memories linked to high-centrality entities that aren't already in details
      const detailIds = new Set(details.map((d) => d.id));
      const placeholders = Array.from(highCentralityIds).map(() => "?").join(",");
      if (highCentralityIds.size > 0) {
        const candidates = db
          .prepare(
            `SELECT DISTINCT m.id, m.importance FROM memories m
             INNER JOIN memory_entities me ON m.id = me.memory_id
             WHERE m.is_active = 1
               AND ROUND(m.importance, 2) != 1.0
               AND m.importance < 0.9
               AND me.entity_id IN (${placeholders})`
          )
          .all(...highCentralityIds) as Array<{ id: string; importance: number }>;

        for (const row of candidates) {
          if (detailIds.has(row.id)) {
            // Already boosted/decayed — adjust the existing detail
            const existing = details.find((d) => d.id === row.id);
            if (existing) {
              existing.new_importance = Math.min(0.9, Math.round((existing.new_importance + 0.05) * 100) / 100);
            }
          } else {
            const newImportance = Math.min(0.9, Math.round((row.importance + 0.05) * 100) / 100);
            if (newImportance !== row.importance) {
              details.push({
                id: row.id,
                action: "boost",
                old_importance: row.importance,
                new_importance: newImportance,
              });
            }
          }
        }
      }
    }
  } catch {
    // Graph analysis is non-critical
  }

  // Apply changes
  if (!dryRun && details.length > 0) {
    const update = db.prepare(
      "UPDATE memories SET importance = ?, updated_at = ? WHERE id = ?"
    );
    const now = new Date().toISOString().replace("T", " ").replace("Z", "");

    db.exec("BEGIN");
    try {
      for (const d of details) {
        update.run(d.new_importance, now, d.id);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  return {
    boosted: details.filter((d) => d.action === "boost").length,
    decayed: details.filter((d) => d.action === "decay").length,
    dry_run: dryRun,
    details,
  };
}
