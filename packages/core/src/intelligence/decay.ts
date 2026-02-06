import type { DatabaseSync } from "node:sqlite";

export interface ArchiveOptions {
  /** Minimum days since creation for low-importance memories (default: 90) */
  staleDays?: number;
  /** Maximum importance for stale-memory archival (default: 0.3) */
  maxImportance?: number;
  /** Maximum access count for stale-memory archival (default: 2) */
  maxAccessCount?: number;
  /** Days with zero access before unconditional archival (default: 365) */
  abandonedDays?: number;
  /** If true, return candidates without archiving (default: false) */
  dryRun?: boolean;
}

export interface ArchiveCandidate {
  id: string;
  content: string;
  importance: number;
  access_count: number;
  created_at: string;
  last_accessed_at: string | null;
  reason: "stale" | "abandoned";
}

export interface ArchiveResult {
  archived: number;
  candidates: ArchiveCandidate[];
  dry_run: boolean;
}

/**
 * Find memories that are candidates for archival.
 *
 * Two criteria:
 * 1. Stale: low importance + old + rarely accessed
 *    (importance < maxImportance AND age > staleDays AND access_count < maxAccessCount)
 * 2. Abandoned: created over abandonedDays ago with zero accesses
 *    (age > abandonedDays AND access_count = 0)
 */
export function getArchiveCandidates(
  db: DatabaseSync,
  opts: ArchiveOptions = {}
): ArchiveCandidate[] {
  const staleDays = opts.staleDays ?? 90;
  const maxImportance = opts.maxImportance ?? 0.3;
  const maxAccessCount = opts.maxAccessCount ?? 2;
  const abandonedDays = opts.abandonedDays ?? 365;

  const now = new Date();

  const staleDate = new Date(now);
  staleDate.setDate(staleDate.getDate() - staleDays);
  const staleDateStr = staleDate.toISOString().slice(0, 19).replace("T", " ");

  const abandonedDate = new Date(now);
  abandonedDate.setDate(abandonedDate.getDate() - abandonedDays);
  const abandonedDateStr = abandonedDate.toISOString().slice(0, 19).replace("T", " ");

  // Stale memories: low importance + old + rarely accessed
  const staleRows = db
    .prepare(
      `SELECT id, content, importance, access_count, created_at, last_accessed_at
       FROM memories
       WHERE is_active = 1
         AND importance < ?
         AND created_at < ?
         AND access_count < ?
       ORDER BY created_at ASC`
    )
    .all(maxImportance, staleDateStr, maxAccessCount) as unknown as Array<{
    id: string;
    content: string;
    importance: number;
    access_count: number;
    created_at: string;
    last_accessed_at: string | null;
  }>;

  // Abandoned memories: very old with zero access
  const abandonedRows = db
    .prepare(
      `SELECT id, content, importance, access_count, created_at, last_accessed_at
       FROM memories
       WHERE is_active = 1
         AND created_at < ?
         AND access_count = 0
       ORDER BY created_at ASC`
    )
    .all(abandonedDateStr) as unknown as Array<{
    id: string;
    content: string;
    importance: number;
    access_count: number;
    created_at: string;
    last_accessed_at: string | null;
  }>;

  // Deduplicate (abandoned may overlap with stale)
  const seen = new Set<string>();
  const candidates: ArchiveCandidate[] = [];

  for (const row of staleRows) {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      candidates.push({ ...row, reason: "stale" });
    }
  }

  for (const row of abandonedRows) {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      candidates.push({ ...row, reason: "abandoned" });
    }
  }

  return candidates;
}

/**
 * Archive stale memories by setting is_active = 0.
 * Returns the list of archived candidates.
 */
export function archiveStaleMemories(
  db: DatabaseSync,
  opts: ArchiveOptions = {}
): ArchiveResult {
  const dryRun = opts.dryRun ?? false;
  const candidates = getArchiveCandidates(db, opts);

  if (dryRun || candidates.length === 0) {
    return { archived: 0, candidates, dry_run: dryRun };
  }

  const stmt = db.prepare("UPDATE memories SET is_active = 0, updated_at = ? WHERE id = ?");
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");

  db.exec("BEGIN");
  try {
    for (const candidate of candidates) {
      stmt.run(now, candidate.id);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return { archived: candidates.length, candidates, dry_run: false };
}
