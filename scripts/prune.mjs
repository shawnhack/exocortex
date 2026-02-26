#!/usr/bin/env node
/**
 * One-time prune of low-value operational memories.
 * Dry-run by default, --apply to execute.
 *
 * Usage: node scripts/prune.mjs [--apply]
 */

import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

const DB_PATH =
  process.env.EXOCORTEX_DB_PATH ??
  path.join(os.homedir(), ".exocortex", "exocortex.db");

const apply = process.argv.includes("--apply");

function truncate(text, maxLen = 80) {
  const oneLine = text.replace(/\n/g, " ").trim();
  return oneLine.length <= maxLen ? oneLine : oneLine.substring(0, maxLen - 3) + "...";
}

function main() {
  console.log(`[prune] Opening database: ${DB_PATH}`);
  if (!apply) console.log("[prune] DRY RUN — pass --apply to execute");

  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 3000");

  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");

  const categories = [];

  // 1. run-summary tagged, older than 14 days
  const runSummaries = db.prepare(
    `SELECT DISTINCT m.id, m.content FROM memories m
     INNER JOIN memory_tags mt ON m.id = mt.memory_id
     WHERE mt.tag = 'run-summary' AND m.is_active = 1 AND m.created_at < ?`
  ).all(fourteenDaysAgo);
  categories.push({ name: "run-summary (>14d)", rows: runSummaries });

  // 2. Sentinel operational reports (cortex + operational tag), older than 14 days
  const opTags = [
    "health-check", "gardening", "dependency-audit", "session-cleanup",
    "config-backup", "state-reconciliation", "retrieval-tuning",
    "friction-bridging", "reweave", "watchlist", "github-scout",
    "goal-worker", "goal-review", "frequency-review",
  ];
  const opPlaceholders = opTags.map(() => "?").join(",");
  const sentinelOps = db.prepare(
    `SELECT DISTINCT m.id, m.content FROM memories m
     INNER JOIN memory_tags mt1 ON m.id = mt1.memory_id
     INNER JOIN memory_tags mt2 ON m.id = mt2.memory_id
     WHERE mt1.tag = 'cortex'
       AND mt2.tag IN (${opPlaceholders})
       AND m.is_active = 1
       AND m.created_at < ?`
  ).all(...opTags, fourteenDaysAgo);
  categories.push({ name: "sentinel ops (cortex + op tag, >14d)", rows: sentinelOps });

  // 3. auto-digested or session-digest tagged, older than 14 days
  const digests = db.prepare(
    `SELECT DISTINCT m.id, m.content FROM memories m
     INNER JOIN memory_tags mt ON m.id = mt.memory_id
     WHERE mt.tag IN ('auto-digested', 'session-digest')
       AND m.is_active = 1
       AND m.created_at < ?`
  ).all(fourteenDaysAgo);
  categories.push({ name: "auto-digested/session-digest (>14d)", rows: digests });

  // 4. technique tagged with access_count = 0 AND useful_count = 0
  const unusedTechniques = db.prepare(
    `SELECT DISTINCT m.id, m.content FROM memories m
     INNER JOIN memory_tags mt ON m.id = mt.memory_id
     WHERE mt.tag = 'technique'
       AND m.is_active = 1
       AND m.access_count = 0
       AND m.useful_count = 0`
  ).all();
  categories.push({ name: "unused techniques (0 access, 0 useful)", rows: unusedTechniques });

  // Deduplicate across categories
  const allIds = new Set();
  let totalCount = 0;
  for (const cat of categories) {
    const unique = cat.rows.filter((r) => !allIds.has(r.id));
    for (const r of unique) allIds.add(r.id);
    cat.uniqueCount = unique.length;
    totalCount += unique.length;
    console.log(`\n[prune] ${cat.name}: ${unique.length} memories`);
    for (const r of unique.slice(0, 5)) {
      console.log(`  - ${truncate(r.content)}`);
    }
    if (unique.length > 5) {
      console.log(`  ... and ${unique.length - 5} more`);
    }
  }

  console.log(`\n[prune] Total to archive: ${totalCount} (deduplicated)`);

  if (apply && totalCount > 0) {
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    const stmt = db.prepare("UPDATE memories SET is_active = 0, updated_at = ? WHERE id = ?");
    db.exec("BEGIN");
    try {
      for (const id of allIds) {
        stmt.run(now, id);
      }
      db.exec("COMMIT");
      console.log(`[prune] Archived ${totalCount} memories.`);
    } catch (err) {
      db.exec("ROLLBACK");
      console.error("[prune] Error:", err);
    }
  } else if (!apply && totalCount > 0) {
    console.log("[prune] Re-run with --apply to archive these memories.");
  }

  db.close();
  console.log("[prune] Done.");
}

main();
