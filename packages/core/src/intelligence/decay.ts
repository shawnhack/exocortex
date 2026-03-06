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
  /** Minimum days with zero access for neglected archival (default: 14) */
  neglectedDays?: number;
  /** Maximum importance for neglected archival (default: 0.5) */
  neglectedMaxImportance?: number;
  /** Minimum days with zero access for forgotten archival (default: 30) */
  forgottenDays?: number;
  /** Maximum importance for forgotten archival (default: 0.6) */
  forgottenMaxImportance?: number;
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
  reason: "stale" | "abandoned" | "neglected" | "forgotten";
}

export interface ArchiveResult {
  archived: number;
  candidates: ArchiveCandidate[];
  dry_run: boolean;
}

/**
 * Find memories that are candidates for archival.
 *
 * Four criteria:
 * 1. Stale: low importance + old + rarely accessed
 *    (importance < maxImportance AND age > staleDays AND access_count < maxAccessCount)
 * 2. Abandoned: created over abandonedDays ago with zero accesses
 *    (age > abandonedDays AND access_count = 0)
 * 3. Neglected: never accessed + moderately old + below importance threshold
 *    (access_count = 0 AND age > neglectedDays AND importance < neglectedMaxImportance)
 * 4. Forgotten: never accessed after 30 days + importance < 0.6 (aggressive forgetting curve)
 *    (access_count = 0 AND age > forgottenDays AND importance < forgottenMaxImportance)
 */
export function getArchiveCandidates(
  db: DatabaseSync,
  opts: ArchiveOptions = {}
): ArchiveCandidate[] {
  const staleDays = opts.staleDays ?? 90;
  const maxImportance = opts.maxImportance ?? 0.3;
  const maxAccessCount = opts.maxAccessCount ?? 2;
  const abandonedDays = opts.abandonedDays ?? 365;
  const neglectedDays = opts.neglectedDays ?? 14;
  const neglectedMaxImportance = opts.neglectedMaxImportance ?? 0.5;
  const forgottenDays = opts.forgottenDays ?? 30;
  const forgottenMaxImportance = opts.forgottenMaxImportance ?? 0.6;

  const now = new Date();

  const staleDate = new Date(now);
  staleDate.setDate(staleDate.getDate() - staleDays);
  const staleDateStr = staleDate.toISOString().slice(0, 19).replace("T", " ");

  const abandonedDate = new Date(now);
  abandonedDate.setDate(abandonedDate.getDate() - abandonedDays);
  const abandonedDateStr = abandonedDate.toISOString().slice(0, 19).replace("T", " ");

  const neglectedDate = new Date(now);
  neglectedDate.setDate(neglectedDate.getDate() - neglectedDays);
  const neglectedDateStr = neglectedDate.toISOString().slice(0, 19).replace("T", " ");

  const forgottenDate = new Date(now);
  forgottenDate.setDate(forgottenDate.getDate() - forgottenDays);
  const forgottenDateStr = forgottenDate.toISOString().slice(0, 19).replace("T", " ");

  // Permanent tiers (semantic, procedural, reference) are exempt from time-based decay
  const tierFilter = "AND tier NOT IN ('semantic', 'procedural', 'reference')";

  // Stale memories: low importance + old + rarely accessed
  const staleRows = db
    .prepare(
      `SELECT id, content, importance, access_count, created_at, last_accessed_at
       FROM memories
       WHERE is_active = 1
         AND importance < ?
         AND created_at < ?
         AND access_count < ?
         ${tierFilter}
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
         ${tierFilter}
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

  // Neglected memories: never accessed + moderately old + below importance threshold
  const neglectedRows = db
    .prepare(
      `SELECT id, content, importance, access_count, created_at, last_accessed_at
       FROM memories
       WHERE is_active = 1
         AND access_count = 0
         AND importance < ?
         AND created_at < ?
         ${tierFilter}
       ORDER BY created_at ASC`
    )
    .all(neglectedMaxImportance, neglectedDateStr) as unknown as Array<{
    id: string;
    content: string;
    importance: number;
    access_count: number;
    created_at: string;
    last_accessed_at: string | null;
  }>;

  // Forgotten memories: never accessed after forgottenDays + importance < forgottenMaxImportance
  // More aggressive than neglected — catches memories that were stored but never retrieved
  const forgottenRows = db
    .prepare(
      `SELECT id, content, importance, access_count, created_at, last_accessed_at
       FROM memories
       WHERE is_active = 1
         AND access_count = 0
         AND importance < ?
         AND created_at < ?
         ${tierFilter}
       ORDER BY created_at ASC`
    )
    .all(forgottenMaxImportance, forgottenDateStr) as unknown as Array<{
    id: string;
    content: string;
    importance: number;
    access_count: number;
    created_at: string;
    last_accessed_at: string | null;
  }>;

  // Deduplicate (categories may overlap)
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

  for (const row of neglectedRows) {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      candidates.push({ ...row, reason: "neglected" });
    }
  }

  for (const row of forgottenRows) {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      candidates.push({ ...row, reason: "forgotten" });
    }
  }

  return candidates;
}

/**
 * Archive memories whose expires_at timestamp has passed.
 * Also auto-sets expires_at on working-tier memories that lack one (24h default).
 * Returns the number of memories archived.
 */
export function archiveExpired(db: DatabaseSync): number {
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");

  // Auto-set expires_at on working-tier memories that don't have one (24h from creation)
  db.prepare(
    `UPDATE memories SET expires_at = datetime(created_at, '+1 day'), updated_at = ?
     WHERE is_active = 1 AND tier = 'working' AND expires_at IS NULL`
  ).run(now);

  const result = db
    .prepare(
      `UPDATE memories SET is_active = 0, updated_at = ?
       WHERE is_active = 1 AND expires_at IS NOT NULL AND expires_at <= datetime('now')`
    )
    .run(now) as { changes: number };
  return result.changes;
}

// --- Sentinel Report Expiry ---

export interface ExpireSentinelReportsResult {
  matched: number;
  updated: number;
  dry_run: boolean;
}

/**
 * Mark old sentinel/health-check run reports for expiry.
 * Sets expires_at = now + 7 days (grace period before archiveExpired removes them).
 * Targets: source='mcp', tagged cortex/health-check/sentinel/metrics, importance <= 0.6,
 * older than TTL days.
 */
export function expireSentinelReports(
  db: DatabaseSync,
  opts?: { ttlDays?: number; dryRun?: boolean }
): ExpireSentinelReportsResult {
  const ttlDays = opts?.ttlDays ?? 14;
  const dryRun = opts?.dryRun ?? false;

  const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");

  const sentinelTags = ["cortex", "health-check", "sentinel", "metrics", "run-summary", "gardening", "state-reconciliation", "retrieval-tuning", "friction-bridging", "reweave", "watchlist", "auto-digested", "session-digest"];
  const placeholders = sentinelTags.map(() => "?").join(",");

  // Find matching memories
  const candidates = db
    .prepare(
      `SELECT DISTINCT m.id FROM memories m
       INNER JOIN memory_tags mt ON m.id = mt.memory_id
       WHERE m.is_active = 1
         AND m.source = 'mcp'
         AND m.importance <= 0.6
         AND m.created_at < ?
         AND m.expires_at IS NULL
         AND mt.tag IN (${placeholders})`
    )
    .all(cutoff, ...sentinelTags) as Array<{ id: string }>;

  if (dryRun || candidates.length === 0) {
    return { matched: candidates.length, updated: 0, dry_run: dryRun };
  }

  // Set expires_at to 7 days from now
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");

  const stmt = db.prepare(
    "UPDATE memories SET expires_at = ?, updated_at = ? WHERE id = ?"
  );

  db.exec("BEGIN");
  try {
    for (const c of candidates) {
      stmt.run(expiresAt, now, c.id);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return { matched: candidates.length, updated: candidates.length, dry_run: false };
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
