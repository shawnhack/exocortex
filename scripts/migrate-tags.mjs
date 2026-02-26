#!/usr/bin/env node
/**
 * One-time tag taxonomy migration.
 * Collapses freeform tags into canonical categories.
 * Dry-run by default, --apply to execute.
 *
 * Usage: node scripts/migrate-tags.mjs [--apply]
 */

import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

const DB_PATH =
  process.env.EXOCORTEX_DB_PATH ??
  path.join(os.homedir(), ".exocortex", "exocortex.db");

const apply = process.argv.includes("--apply");

const CANONICAL_MAP = {
  // Content type
  "chose": "decision",
  "trade-off": "decision",
  "learning": "technique",
  "lesson": "technique",
  "pattern": "technique",
  "trick": "technique",
  "tip": "technique",
  "insight": "technique",
  "design": "architecture",
  "schema": "architecture",
  "structure": "architecture",
  "bugfix": "bug-fix",
  "fix": "bug-fix",
  "debugging": "bug-fix",
  "workaround": "bug-fix",
  "configuration": "config",
  "setup": "config",
  "env": "config",
  "environment": "config",
  "investigation": "research",
  "analysis": "research",
  "comparison": "research",
  "session-digest": "summary",
  "auto-digested": "summary",
  "digest": "summary",
  "context": "narrative",
  "background": "narrative",
  "history": "narrative",
  // System
  "health-check": "operations",
  "cortex-health": "operations",
  "system-health": "operations",
  "monitoring": "operations",
  "gardening": "operations",
  "state-reconciliation": "operations",
  "retrieval-tuning": "operations",
  "friction-bridging": "operations",
  "reweave": "operations",
  "watchlist": "operations",
  "dependency-audit": "operations",
  "session-cleanup": "operations",
  "config-backup": "operations",
  "frequency-review": "operations",
  "goal-progress-implicit": "goal-progress",
  "preference": "self-model",
  "personality": "self-model",
};

function main() {
  console.log(`[migrate-tags] Opening database: ${DB_PATH}`);
  if (!apply) console.log("[migrate-tags] DRY RUN — pass --apply to execute");

  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 3000");

  // Read all unique tags with counts
  const allTags = db.prepare(
    "SELECT tag, COUNT(*) as cnt FROM memory_tags GROUP BY tag ORDER BY cnt DESC"
  ).all();

  console.log(`[migrate-tags] Tags before: ${allTags.length}`);

  // Calculate what would be merged
  const merges = [];
  for (const row of allTags) {
    const canonical = CANONICAL_MAP[row.tag];
    if (canonical) {
      merges.push({ from: row.tag, to: canonical, count: row.cnt });
    }
  }

  console.log(`\n[migrate-tags] Merges to apply: ${merges.length}`);
  for (const m of merges) {
    console.log(`  ${m.from} (${m.count}) → ${m.to}`);
  }

  if (apply && merges.length > 0) {
    db.exec("BEGIN");
    try {
      let totalUpdated = 0;

      for (const m of merges) {
        // Delete duplicates where memory already has the target tag
        db.prepare(
          `DELETE FROM memory_tags
           WHERE tag = ? AND memory_id IN (
             SELECT memory_id FROM memory_tags WHERE tag = ?
           )`
        ).run(m.from, m.to);

        // Rename remaining
        const result = db.prepare(
          "UPDATE memory_tags SET tag = ? WHERE tag = ?"
        ).run(m.to, m.from);
        totalUpdated += result.changes;
      }

      // Persist canonical map to settings
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)"
      ).run("tags.canonical_map", JSON.stringify(CANONICAL_MAP));

      db.exec("COMMIT");
      console.log(`\n[migrate-tags] Applied: ${totalUpdated} tag rows updated`);
    } catch (err) {
      db.exec("ROLLBACK");
      console.error("[migrate-tags] Error:", err);
    }
  }

  // Report final state
  const afterTags = apply
    ? db.prepare("SELECT COUNT(DISTINCT tag) as cnt FROM memory_tags").get()
    : null;
  if (afterTags) {
    console.log(`[migrate-tags] Tags after: ${afterTags.cnt}`);
  }

  db.close();
  console.log("[migrate-tags] Done.");
}

main();
