#!/usr/bin/env node
/**
 * Bulk dismiss stale contradictions where either memory is inactive
 * or both share an identical content hash.
 *
 * Usage: node scripts/bulk-dismiss-contradictions.mjs [--dry-run]
 */

import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import {
  initializeSchema,
  getContradictions,
  updateContradiction,
} from "../packages/core/dist/index.js";

const DB_PATH =
  process.env.EXOCORTEX_DB_PATH ??
  path.join(os.homedir(), ".exocortex", "exocortex.db");

const dryRun = process.argv.includes("--dry-run");

function main() {
  console.log(`[bulk-dismiss] Opening database: ${DB_PATH}`);
  if (dryRun) console.log("[bulk-dismiss] DRY RUN — no changes will be made");

  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  initializeSchema(db);

  const pending = getContradictions(db, "pending", 1000);
  console.log(`[bulk-dismiss] Found ${pending.length} pending contradictions`);

  const getMemory = db.prepare(
    "SELECT id, is_active, content_hash FROM memories WHERE id = ?"
  );

  let dismissed = 0;
  let skipped = 0;
  const reasons = { inactive: 0, same_hash: 0 };

  for (const c of pending) {
    const memA = getMemory.get(c.memory_a_id);
    const memB = getMemory.get(c.memory_b_id);

    let reason = null;

    // Either memory deleted entirely
    if (!memA || !memB) {
      reason = "One or both memories no longer exist";
    }
    // Either memory is inactive (archived/superseded)
    else if (!memA.is_active || !memB.is_active) {
      reason = "One or both memories are inactive (archived/superseded)";
      reasons.inactive++;
    }
    // Both have identical content hash
    else if (
      memA.content_hash &&
      memB.content_hash &&
      memA.content_hash === memB.content_hash
    ) {
      reason = "Both memories have identical content hash";
      reasons.same_hash++;
    }

    if (reason) {
      if (!dryRun) {
        updateContradiction(db, c.id, {
          status: "dismissed",
          resolution: `Auto-dismissed: ${reason}`,
        });
      }
      dismissed++;
    } else {
      skipped++;
    }
  }

  console.log(`[bulk-dismiss] Results:`);
  console.log(`  Dismissed: ${dismissed}`);
  console.log(`    - Inactive memory: ${reasons.inactive}`);
  console.log(`    - Same content hash: ${reasons.same_hash}`);
  console.log(
    `    - Missing memory: ${dismissed - reasons.inactive - reasons.same_hash}`
  );
  console.log(`  Remaining: ${skipped}`);

  db.close();
  console.log("[bulk-dismiss] Done.");
}

main();
