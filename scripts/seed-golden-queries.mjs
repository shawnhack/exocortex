#!/usr/bin/env node
/**
 * Seed golden queries for retrieval regression, set dedup exempt tags,
 * recalibrate importance, and establish baselines.
 *
 * Usage: node scripts/seed-golden-queries.mjs
 */

import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import {
  initializeSchema,
  getSetting,
  setSetting,
  setGoldenQueries,
  runRetrievalRegression,
  recalibrateImportance,
} from "../packages/core/dist/index.js";

const DB_PATH =
  process.env.EXOCORTEX_DB_PATH ??
  path.join(os.homedir(), ".exocortex", "exocortex.db");

const GOLDEN_QUERIES = [
  "exocortex architecture",
  "cortex sentinel jobs",
  "recursive self-improvement",
  "memory consolidation dedup",
  "force-graph dashboard",
  "scoring weights retrieval",
  "prompt amendments voting",
  "contradiction detection",
  "session-orient hook",
  "PM2 process orchestration",
  "n8n video pipeline",
  "bitcoin horizon monetization",
  "Playwright browser automation",
  "tag taxonomy normalization",
  "temporal hierarchy epochs",
];

const DEDUP_EXEMPT_TAGS = [
  "sentinel-report",
  "cortex",
  "health-check",
  "state-reconciliation",
  "memory-gardening",
  "retrieval-tuning",
  "metrics",
  "goal-progress",
];

async function main() {
  console.log(`[seed] Opening database: ${DB_PATH}`);
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  initializeSchema(db);

  // 1. Seed golden queries
  const existing = getSetting(db, "retrieval_regression.queries") ?? "[]";
  const existingQueries = JSON.parse(existing);
  console.log(`[seed] Existing golden queries: ${existingQueries.length}`);

  setGoldenQueries(db, GOLDEN_QUERIES);
  console.log(`[seed] Seeded ${GOLDEN_QUERIES.length} golden queries`);

  // 2. Set dedup exempt tags
  setSetting(db, "dedup.exempt_tags", JSON.stringify(DEDUP_EXEMPT_TAGS));
  console.log(
    `[seed] Set dedup.exempt_tags: ${DEDUP_EXEMPT_TAGS.length} tags`
  );

  // 3. Recalibrate importance
  console.log("[seed] Recalibrating importance distribution...");
  const recalResult = recalibrateImportance(db);
  console.log(
    `[seed] Recalibrated: ${recalResult.adjusted} memories adjusted (${recalResult.skipped} pinned skipped)`
  );

  // 4. Run retrieval regression to establish baselines
  console.log("[seed] Running retrieval regression to establish baselines...");
  const result = await runRetrievalRegression(db, {
    update_baselines: true,
    create_alert_memory: false,
  });

  console.log(
    `[seed] Regression: ran=${result.ran} initialized=${result.initialized} alerts=${result.alerts}`
  );
  for (const row of result.results) {
    const status = row.initialized ? "initialized" : "existing";
    console.log(
      `  - "${row.query}": overlap=${(row.overlap_at_10 * 100).toFixed(1)}% shift=${row.avg_rank_shift.toFixed(2)} [${status}]`
    );
  }

  db.close();
  console.log("[seed] Done.");
}

main().catch((err) => {
  console.error(
    `[seed] Failed: ${err instanceof Error ? err.message : String(err)}`
  );
  if (err instanceof Error) console.error(err.stack);
  process.exit(1);
});
