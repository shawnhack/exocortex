import type { DatabaseSync } from "node:sqlite";
import { getSetting } from "../db/schema.js";

export interface PurgeOptions {
  /** Days in trash before permanent deletion (default: from setting or 30) */
  days?: number;
  /** If true, return candidates without deleting (default: false) */
  dryRun?: boolean;
}

export interface PurgeCandidate {
  id: string;
  content: string;
  updated_at: string;
  superseded_by: string | null;
}

export interface PurgeResult {
  /** Number of trash candidates directly DELETEd. */
  purged: number;
  /**
   * Number of additional rows removed by SQLite ON DELETE CASCADE
   * (most commonly chunks whose parent was in the candidate set).
   * Without this field the log line under-reports total disk impact —
   * a single parent with 70 chunks looks like "1 purged" but is actually 71.
   */
  cascaded: number;
  /** purged + cascaded — true number of memory rows removed. */
  total_deleted: number;
  candidates: PurgeCandidate[];
  dry_run: boolean;
}

/**
 * Find trashed memories eligible for permanent deletion.
 *
 * Criteria: is_active = 0 AND updated_at older than threshold.
 * Skips memories whose superseded_by points to an active memory
 * (preserves diff history in the dashboard).
 */
export function getPurgeCandidates(
  db: DatabaseSync,
  opts: PurgeOptions = {}
): PurgeCandidate[] {
  const settingDays = getSetting(db, "trash.auto_purge_days");
  const days = opts.days ?? (settingDays ? parseInt(settingDays, 10) : 30);

  // Setting value "0" disables auto-purge
  if (days <= 0) return [];

  const threshold = new Date();
  threshold.setDate(threshold.getDate() - days);
  const thresholdStr = threshold.toISOString().slice(0, 19).replace("T", " ");

  const candidates = db
    .prepare(
      `SELECT id, content, updated_at, superseded_by
       FROM memories
       WHERE is_active = 0
         AND updated_at < ?
       ORDER BY updated_at ASC`
    )
    .all(thresholdStr) as unknown as PurgeCandidate[];

  // Batch-fetch active status for all superseded_by targets
  const supersededIds = candidates
    .map((c) => c.superseded_by)
    .filter((id): id is string => id !== null);

  const activeTargets = new Set<string>();
  if (supersededIds.length > 0) {
    const placeholders = supersededIds.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT id FROM memories WHERE id IN (${placeholders}) AND is_active = 1`)
      .all(...supersededIds) as Array<{ id: string }>;
    for (const row of rows) {
      activeTargets.add(row.id);
    }
  }

  // Filter out memories whose superseded_by target is still active
  return candidates.filter((c) => {
    if (!c.superseded_by) return true;
    return !activeTargets.has(c.superseded_by);
  });
}

/**
 * Permanently delete trashed memories older than the threshold.
 * FK cascades handle memory_tags, memory_entities, access_log cleanup.
 */
export function purgeTrash(
  db: DatabaseSync,
  opts: PurgeOptions = {}
): PurgeResult {
  const dryRun = opts.dryRun ?? false;
  const candidates = getPurgeCandidates(db, opts);

  if (dryRun || candidates.length === 0) {
    return { purged: 0, cascaded: 0, total_deleted: 0, candidates, dry_run: dryRun };
  }

  // Snapshot total row count before deletes so we can measure FK cascades
  // (ON DELETE CASCADE on parent_id removes child chunks transparently —
  // those rows never pass through the JS DELETE loop).
  const countStmt = db.prepare("SELECT COUNT(*) as n FROM memories");
  const beforeCount = (countStmt.get() as { n: number }).n;

  const stmt = db.prepare("DELETE FROM memories WHERE id = ?");
  const skipped: Array<{ id: string; error: string }> = [];

  db.exec("BEGIN");
  try {
    for (const candidate of candidates) {
      try {
        stmt.run(candidate.id);
      } catch (err) {
        skipped.push({
          id: candidate.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  if (skipped.length > 0) {
    console.error(
      `[purge] ${skipped.length} candidate(s) skipped due to errors:`,
      skipped
    );
  }

  const purged = candidates.length - skipped.length;
  const afterCount = (countStmt.get() as { n: number }).n;
  const total_deleted = beforeCount - afterCount;
  // total_deleted should equal purged + cascaded; clamp at 0 to avoid weird
  // negatives if some other process also wrote between snapshots.
  const cascaded = Math.max(0, total_deleted - purged);
  return { purged, cascaded, total_deleted, candidates, dry_run: false };
}
