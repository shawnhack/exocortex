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
  purged: number;
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
    return { purged: 0, candidates, dry_run: dryRun };
  }

  const stmt = db.prepare("DELETE FROM memories WHERE id = ?");

  db.exec("BEGIN");
  try {
    for (const candidate of candidates) {
      stmt.run(candidate.id);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return { purged: candidates.length, candidates, dry_run: false };
}
