import cron from "node-cron";
import fs from "node:fs";
import path from "node:path";
import {
  getDb,
  findClusters,
  consolidateCluster,
  generateBasicSummary,
  detectContradictions,
  recordContradiction,
  archiveStaleMemories,
  adjustImportance,
  getSetting,
  purgeTrash,
  backupDatabase,
  backfillEntities,
  reembedMissing,
  getEmbeddingProvider,
  densifyEntityGraph,
  buildCoRetrievalLinks,
  runRetrievalRegression,
} from "@exocortex/core";
import type { RetrievalRegressionResult } from "@exocortex/core";

/**
 * Run importance adjustment + archival immediately.
 * Called on startup and after every N memory stores.
 * Skips consolidation/contradictions (those need human review).
 */
export function runMaintenanceNow(): void {
  try {
    const db = getDb();

    // Importance adjustment (respects auto_adjust setting)
    const enabled = getSetting(db, "importance.auto_adjust");
    if (enabled !== "false") {
      const impResult = adjustImportance(db);
      if (impResult.boosted > 0 || impResult.decayed > 0) {
        console.log(`[maintenance] Importance: ${impResult.boosted} boosted, ${impResult.decayed} decayed`);
      }
    }

    // Archival
    const archResult = archiveStaleMemories(db);
    if (archResult.archived > 0) {
      console.log(`[maintenance] Archived ${archResult.archived} stale memories`);
    }
  } catch (err) {
    console.error("[maintenance] Error:", err);
  }
}

const MAINTENANCE_EVERY_N_STORES = 50;
let storesSinceMaintenance = 0;

/**
 * Call after each memory store. Triggers maintenance every N stores.
 */
export function notifyMemoryStored(): void {
  storesSinceMaintenance++;
  if (storesSinceMaintenance >= MAINTENANCE_EVERY_N_STORES) {
    storesSinceMaintenance = 0;
    console.log(`[maintenance] ${MAINTENANCE_EVERY_N_STORES} memories stored — running maintenance`);
    runMaintenanceNow();
  }
}

export async function runScheduledRetrievalRegression(): Promise<
  | { status: "disabled" | "no_queries" }
  | { status: "ran"; result: RetrievalRegressionResult }
> {
  const db = getDb();
  if (getSetting(db, "retrieval_regression.enabled") === "false") {
    console.log("[scheduler] Retrieval regression disabled, skipping");
    return { status: "disabled" };
  }

  console.log("[scheduler] Running golden-query retrieval regression...");
  const result = await runRetrievalRegression(db);
  if (result.ran === 0) {
    console.log("[scheduler] Retrieval regression skipped — no golden queries configured");
    return { status: "no_queries" };
  }

  console.log(
    `[scheduler] Retrieval regression run ${result.run_id ?? "unknown"}: ${result.ran} queries, ${result.alerts} alerts${result.alert_memory_id ? ` (alert memory: ${result.alert_memory_id})` : ""}`
  );
  return { status: "ran", result };
}

/**
 * Start background scheduled jobs.
 * - Nightly consolidation scan (2:00 AM)
 * - Nightly contradiction detection (2:30 AM)
 * - Entity extraction for unprocessed memories (3:00 AM)
 */
export function startScheduler(): void {
  // Database backup — every day at 1:30 AM (before nightly maintenance pipeline)
  cron.schedule("30 1 * * *", () => {
    try {
      console.log("[scheduler] Running database backup...");
      const db = getDb();
      const maxStr = getSetting(db, "backup.max_count");
      const maxBackups = maxStr ? parseInt(maxStr, 10) : 7;
      const result = backupDatabase(db, { maxBackups });
      const sizeMB = (result.sizeBytes / 1024 / 1024).toFixed(1);
      console.log(
        `[scheduler] Backup complete: ${result.path} (${sizeMB} MB)${result.pruned > 0 ? `, pruned ${result.pruned} old backups` : ""}`
      );

      // Copy to secondary location if configured
      const copyTo = getSetting(db, "backup.copy_to");
      if (copyTo) {
        try {
          if (!fs.existsSync(copyTo)) {
            fs.mkdirSync(copyTo, { recursive: true });
          }
          const dest = path.join(copyTo, path.basename(result.path));
          fs.copyFileSync(result.path, dest);
          console.log(`[scheduler] Backup copied to: ${dest}`);
        } catch (copyErr) {
          console.error("[scheduler] Backup copy error:", copyErr);
        }
      }
    } catch (err) {
      console.error("[scheduler] Backup error:", err);
    }
  });

  // Consolidation — every day at 2:00 AM
  cron.schedule("0 2 * * *", async () => {
    try {
      console.log("[scheduler] Running nightly consolidation scan...");
      const db = getDb();
      const clusters = findClusters(db);

      for (const cluster of clusters) {
        const summary = generateBasicSummary(db, cluster.memberIds);
        await consolidateCluster(db, cluster, summary);
      }

      console.log(`[scheduler] Consolidation complete: ${clusters.length} clusters processed`);
    } catch (err) {
      console.error("[scheduler] Consolidation error:", err);
    }
  });

  // Contradiction detection — every day at 2:30 AM
  cron.schedule("30 2 * * *", () => {
    try {
      console.log("[scheduler] Running contradiction detection...");
      const db = getDb();
      const candidates = detectContradictions(db);

      for (const candidate of candidates) {
        recordContradiction(db, candidate);
      }

      console.log(`[scheduler] Detected ${candidates.length} potential contradictions`);
    } catch (err) {
      console.error("[scheduler] Contradiction detection error:", err);
    }
  });

  // Entity extraction + relationship backfill — every day at 3:00 AM
  cron.schedule("0 3 * * *", () => {
    try {
      console.log("[scheduler] Running entity backfill on unprocessed memories...");
      const db = getDb();
      const result = backfillEntities(db, { limit: 100 });
      console.log(
        `[scheduler] Entity backfill complete: ${result.memoriesProcessed} memories, ${result.entitiesCreated} entities created, ${result.entitiesLinked} links, ${result.relationshipsCreated} relationships`
      );
    } catch (err) {
      console.error("[scheduler] Entity backfill error:", err);
    }
  });

  // Importance auto-adjustment — every day at 3:30 AM
  cron.schedule("30 3 * * *", () => {
    try {
      const db = getDb();
      const enabled = getSetting(db, "importance.auto_adjust");
      if (enabled === "false") {
        console.log("[scheduler] Importance auto-adjust disabled, skipping");
        return;
      }
      console.log("[scheduler] Running importance auto-adjustment...");
      const result = adjustImportance(db);
      console.log(`[scheduler] Importance adjustment complete: ${result.boosted} boosted, ${result.decayed} decayed`);
    } catch (err) {
      console.error("[scheduler] Importance adjustment error:", err);
    }
  });

  // Stale memory archival — every day at 4:00 AM
  cron.schedule("0 4 * * *", () => {
    try {
      console.log("[scheduler] Running stale memory archival...");
      const db = getDb();
      const result = archiveStaleMemories(db);
      console.log(`[scheduler] Archival complete: ${result.archived} memories archived`);
    } catch (err) {
      console.error("[scheduler] Archival error:", err);
    }
  });

  // Trash purge — every day at 4:30 AM
  cron.schedule("30 4 * * *", () => {
    try {
      console.log("[scheduler] Running trash purge...");
      const db = getDb();
      const result = purgeTrash(db);
      console.log(`[scheduler] Trash purge complete: ${result.purged} memories permanently deleted`);
    } catch (err) {
      console.error("[scheduler] Trash purge error:", err);
    }
  });

  // Graph densification — every day at 5:00 AM
  cron.schedule("0 5 * * *", () => {
    try {
      console.log("[scheduler] Running graph densification...");
      const db = getDb();
      const result = densifyEntityGraph(db, { minCoOccurrences: 2, limit: 500 });
      console.log(`[scheduler] Graph densification complete: ${result.pairsAnalyzed} pairs, ${result.relationshipsCreated} relationships created`);
    } catch (err) {
      console.error("[scheduler] Graph densification error:", err);
    }
  });

  // Co-retrieval link building + cleanup — every day at 5:30 AM
  cron.schedule("30 5 * * *", () => {
    try {
      console.log("[scheduler] Running co-retrieval link building...");
      const db = getDb();
      const result = buildCoRetrievalLinks(db);
      console.log(`[scheduler] Co-retrieval links: ${result.pairsAnalyzed} pairs, ${result.linksCreated} created, ${result.linksStrengthened} strengthened`);

      // Cleanup old co-retrieval records (>60 days)
      const cutoff = new Date(Date.now() - 60 * 86400000)
        .toISOString()
        .replace("T", " ")
        .replace("Z", "");
      const deleted = db
        .prepare("DELETE FROM co_retrievals WHERE created_at < ?")
        .run(cutoff) as { changes: number };
      if (deleted.changes > 0) {
        console.log(`[scheduler] Cleaned up ${deleted.changes} old co-retrieval records`);
      }
    } catch (err) {
      console.error("[scheduler] Co-retrieval link building error:", err);
    }
  });

  const regressionSchedule =
    getSetting(getDb(), "retrieval_regression.schedule") ?? "15 6 * * *";
  cron.schedule(regressionSchedule, async () => {
    try {
      await runScheduledRetrievalRegression();
    } catch (err) {
      console.error("[scheduler] Retrieval regression error:", err);
    }
  });

  console.log(
    `[scheduler] Background jobs scheduled (backup 1:30, consolidation 2:00, contradictions 2:30, entities 3:00, importance 3:30, archival 4:00, purge 4:30, densify 5:00, co-retrieval 5:30, retrieval-regression ${regressionSchedule})`
  );

  // Run maintenance on startup (short delay to not block server init)
  setTimeout(() => {
    console.log("[maintenance] Running startup maintenance...");
    runMaintenanceNow();
  }, 5000);

  // Re-embed memories with missing embeddings on startup
  setTimeout(async () => {
    try {
      const db = getDb();
      const provider = await getEmbeddingProvider();
      const result = await reembedMissing(db, provider);
      if (result.processed > 0 || result.failed > 0) {
        console.log(`[maintenance] Re-embed: ${result.processed} processed, ${result.failed} failed`);
      }
    } catch (err) {
      console.error("[maintenance] Re-embed error:", err);
    }
  }, 10000);
}
