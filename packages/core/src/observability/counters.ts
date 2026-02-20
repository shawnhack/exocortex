import type { DatabaseSync } from "node:sqlite";
import { getSetting } from "../db/schema.js";

export interface CounterRow {
  key: string;
  value: number;
  updated_at: string;
}

export function incrementCounter(
  db: DatabaseSync,
  key: string,
  delta = 1
): void {
  if (!Number.isFinite(delta) || delta === 0) return;
  const now = new Date().toISOString().replace("T", " ").replace("Z", "");
  db
    .prepare(
      `INSERT INTO observability_counters (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE
       SET value = observability_counters.value + excluded.value,
           updated_at = excluded.updated_at`
    )
    .run(key, Math.trunc(delta), now);

  if (getSetting(db, "observability.log_events") === "true") {
    console.log(`[observability] ${key} += ${Math.trunc(delta)}`);
  }
}

export function getCounter(db: DatabaseSync, key: string): number {
  const row = db
    .prepare("SELECT value FROM observability_counters WHERE key = ?")
    .get(key) as { value: number } | undefined;
  return row?.value ?? 0;
}

export function getCounters(db: DatabaseSync, prefix?: string): CounterRow[] {
  if (prefix && prefix.length > 0) {
    return db
      .prepare(
        "SELECT key, value, updated_at FROM observability_counters WHERE key LIKE ? ORDER BY key ASC"
      )
      .all(`${prefix}%`) as unknown as CounterRow[];
  }
  return db
    .prepare(
      "SELECT key, value, updated_at FROM observability_counters ORDER BY key ASC"
    )
    .all() as unknown as CounterRow[];
}
