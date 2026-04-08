import type { DatabaseSync } from "node:sqlite";

export interface JobOutcome {
  job_name: string;
  success: boolean;
  duration_ms?: number;
  error?: string;
}

export interface JobHealthSummary {
  job_name: string;
  total_runs: number;
  successes: number;
  failures: number;
  success_rate: number;
  last_run: string;
  last_error: string | null;
  alert: boolean;
}

/**
 * Ensure the job_outcomes table exists.
 * Called lazily on first write to avoid requiring a schema migration.
 */
function ensureTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_name TEXT NOT NULL,
      success INTEGER NOT NULL DEFAULT 1,
      duration_ms INTEGER,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_job_outcomes_name ON job_outcomes (job_name)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_job_outcomes_error_lookup
    ON job_outcomes (job_name, success, created_at DESC) WHERE success = 0
  `);
}

/**
 * Record a job execution outcome.
 */
export function recordJobOutcome(db: DatabaseSync, outcome: JobOutcome): void {
  ensureTable(db);
  const now = new Date().toISOString().replace("T", " ").replace("Z", "");
  db.prepare(
    "INSERT INTO job_outcomes (job_name, success, duration_ms, error, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(
    outcome.job_name,
    outcome.success ? 1 : 0,
    outcome.duration_ms ?? null,
    outcome.error ?? null,
    now,
  );
}

/**
 * Get health summary for all jobs, flagging those below the alert threshold.
 * Default window: last 14 days. Default alert threshold: 70% success.
 */
export function getJobHealth(
  db: DatabaseSync,
  opts?: { windowDays?: number; alertThreshold?: number }
): JobHealthSummary[] {
  ensureTable(db);
  const windowDays = opts?.windowDays ?? 14;
  const alertThreshold = opts?.alertThreshold ?? 0.70;
  const since = new Date(Date.now() - windowDays * 86400000)
    .toISOString()
    .replace("T", " ")
    .replace("Z", "");

  // Use LEFT JOIN with rowid tiebreaker to avoid duplicates when multiple
  // failures share the same second-resolution timestamp
  const rows = db
    .prepare(`
      SELECT
        agg.job_name,
        agg.total_runs,
        agg.successes,
        agg.total_runs - agg.successes as failures,
        agg.last_run,
        err.error as last_error
      FROM (
        SELECT job_name, COUNT(*) as total_runs, SUM(success) as successes,
               MAX(created_at) as last_run
        FROM job_outcomes WHERE created_at >= ?
        GROUP BY job_name
      ) agg
      LEFT JOIN job_outcomes err ON err.job_name = agg.job_name AND err.rowid = (
        SELECT rowid FROM job_outcomes
        WHERE job_name = agg.job_name AND success = 0
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1
      )
      ORDER BY agg.job_name ASC
    `)
    .all(since) as unknown as Array<{
      job_name: string;
      total_runs: number;
      successes: number;
      failures: number;
      last_run: string;
      last_error: string | null;
    }>;

  return rows.map(row => {
    const successRate = row.total_runs > 0 ? row.successes / row.total_runs : 1;
    return {
      ...row,
      success_rate: Math.round(successRate * 1000) / 1000,
      alert: successRate < alertThreshold && row.total_runs >= 3,
    };
  });
}

/**
 * Get only jobs that are currently in alert state (below threshold).
 */
export function getJobAlerts(
  db: DatabaseSync,
  opts?: { windowDays?: number; alertThreshold?: number }
): JobHealthSummary[] {
  return getJobHealth(db, opts).filter(j => j.alert);
}
