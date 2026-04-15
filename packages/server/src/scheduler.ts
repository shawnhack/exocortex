import cron, { type ScheduledTask } from "node-cron";
import fs from "node:fs";
import path from "node:path";
import {
  getDb,
  findClusters,
  consolidateCluster,
  generateBasicSummary,
  detectContradictions,
  recordContradiction,
  autoDismissContradictions,
  archiveStaleMemories,
  archiveExpired,
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
  autoConsolidate,
  validateSummary,
  expireSentinelReports,
  suggestTagMerges,
  applyTagMerge,
  recomputeQualityScores,
} from "@exocortex/core";
import type { RetrievalRegressionResult } from "@exocortex/core";

/** Tracks scheduler job failures for health monitoring */
const jobErrors: Map<string, { count: number; lastError: string; lastAt: string }> = new Map();

function recordJobError(jobName: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  const existing = jobErrors.get(jobName);
  jobErrors.set(jobName, {
    count: (existing?.count ?? 0) + 1,
    lastError: msg.slice(0, 200),
    lastAt: new Date().toISOString(),
  });
}

export function getJobErrors(): Map<string, { count: number; lastError: string; lastAt: string }> {
  return jobErrors;
}

/**
 * Run importance adjustment + archival + auto-consolidation immediately.
 * Called on startup and after every N memory stores.
 * Skips manual consolidation/contradictions (those need human review).
 */
export async function runMaintenanceNow(): Promise<void> {
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

    // Archive expired memories
    const expiredCount = archiveExpired(db);
    if (expiredCount > 0) {
      console.log(`[maintenance] Archived ${expiredCount} expired memories`);
    }

    // Auto-consolidation (gated by setting)
    if (getSetting(db, "consolidation.auto_enabled") !== "false") {
      try {
        const provider = await getEmbeddingProvider();
        const consolResult = await autoConsolidate(db, provider, {
          maxClusters: 3,
          minSimilarity: 0.85,
        });
        if (consolResult.clustersConsolidated > 0) {
          console.log(
            `[maintenance] Auto-consolidated ${consolResult.clustersConsolidated}/${consolResult.clustersFound} clusters, ${consolResult.memoriesMerged} memories merged`
          );
        }
      } catch (err) {
        console.error("[maintenance] Auto-consolidation error:", err);
      }
    }

    // Recompute quality scores
    const qResult = recomputeQualityScores(db);
    if (qResult.updated > 0) {
      console.log(`[maintenance] Quality scores recomputed: ${qResult.updated}/${qResult.total}`);
    }

    // Auto tag cleanup (conservative: max 1 merge per maintenance run)
    try {
      const suggestions = suggestTagMerges(db, { minSimilarity: 0.95, limit: 1 });
      for (const s of suggestions) {
        if (s.fromCount <= 50) {
          const result = applyTagMerge(db, s.from, s.to);
          console.log(`[maintenance] Auto-merged tag "${s.from}" → "${s.to}": ${result.updated} memories updated`);
        }
      }
    } catch (err) {
      console.error("[maintenance] Tag cleanup error:", err);
    }
  } catch (err) {
    console.error("[maintenance] Error:", err);
  }
}

const MAINTENANCE_EVERY_N_STORES = 50;
let storesSinceMaintenance = 0;

/**
 * Call after each memory store. Triggers maintenance every N stores.
 * Fire-and-forget — does not block the caller.
 */
export function notifyMemoryStored(): void {
  storesSinceMaintenance++;
  if (storesSinceMaintenance >= MAINTENANCE_EVERY_N_STORES) {
    storesSinceMaintenance = 0;
    console.log(`[maintenance] ${MAINTENANCE_EVERY_N_STORES} memories stored — running maintenance`);
    runMaintenanceNow().catch((err) =>
      console.error("[maintenance] Periodic maintenance error:", err)
    );
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
    `[scheduler] Retrieval regression run ${result.run_id ?? "unknown"}: ${result.ran} queries, ${result.alerts} alerts${result.rebaselined > 0 ? `, ${result.rebaselined} rebaselined` : ""}${result.alert_memory_id ? ` (alert memory: ${result.alert_memory_id})` : ""}`
  );
  return { status: "ran", result };
}

/**
 * Start background scheduled jobs.
 * - Nightly consolidation scan (2:00 AM)
 * - Nightly contradiction detection (2:30 AM)
 * - Entity extraction for unprocessed memories (3:00 AM)
 */
const scheduledTasks: ScheduledTask[] = [];

export function stopScheduler(): void {
  for (const task of scheduledTasks) {
    task.stop();
  }
  scheduledTasks.length = 0;
  console.log("[scheduler] All background jobs stopped");
}

function schedule(expression: string, fn: () => void | Promise<void>): void {
  scheduledTasks.push(cron.schedule(expression, fn));
}

export function startScheduler(): void {
  // Database backup — every day at 1:30 AM (before nightly maintenance pipeline)
  schedule("30 1 * * *", () => {
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

      // Secondary copy handled externally by nexus backup-exocortex script
    } catch (err) {
      console.error("[scheduler] Backup error:", err);
      recordJobError("backup", err);
    }
  });

  // Consolidation — every day at 2:00 AM
  // Uses quality validation to prevent bad summaries from being persisted
  schedule("0 2 * * *", async () => {
    try {
      console.log("[scheduler] Running nightly consolidation scan...");
      const db = getDb();
      const clusters = findClusters(db);
      let consolidated = 0;
      let skipped = 0;

      for (const cluster of clusters) {
        const summary = generateBasicSummary(db, cluster.memberIds);
        if (!summary) { skipped++; continue; }

        // Validate summary quality before consolidating
        const sourceContents = db
          .prepare(
            `SELECT content FROM memories WHERE id IN (${cluster.memberIds.map(() => "?").join(",")})`
          )
          .all(...cluster.memberIds) as Array<{ content: string }>;
        const validation = validateSummary(summary, sourceContents.map((r) => r.content));
        if (!validation.valid) {
          skipped++;
          continue;
        }

        await consolidateCluster(db, cluster, summary);
        consolidated++;
      }

      console.log(`[scheduler] Consolidation complete: ${consolidated}/${clusters.length} clusters consolidated${skipped > 0 ? `, ${skipped} skipped (quality check)` : ""}`);
    } catch (err) {
      console.error("[scheduler] Consolidation error:", err);
      recordJobError("consolidation", err);
    }
  });

  // Contradiction detection — every day at 2:30 AM (disabled by default)
  schedule("30 2 * * *", () => {
    try {
      const db = getDb();
      if (getSetting(db, "contradictions.auto_detect") !== "true") {
        return;
      }
      console.log("[scheduler] Running contradiction detection...");
      const candidates = detectContradictions(db);

      for (const candidate of candidates) {
        recordContradiction(db, candidate);
      }

      console.log(`[scheduler] Detected ${candidates.length} potential contradictions`);

      // Auto-dismiss low-signal contradictions
      const autoDismissResult = autoDismissContradictions(db);
      if (autoDismissResult.dismissed > 0) {
        console.log(
          `[scheduler] Auto-dismissed ${autoDismissResult.dismissed} contradictions: ${JSON.stringify(autoDismissResult.reasons)}`
        );
      }
    } catch (err) {
      console.error("[scheduler] Contradiction detection error:", err);
      recordJobError("contradiction_detection", err);
    }
  });

  // Entity extraction + relationship backfill — every day at 3:00 AM
  schedule("0 3 * * *", () => {
    try {
      console.log("[scheduler] Running entity backfill on unprocessed memories...");
      const db = getDb();
      const result = backfillEntities(db, { limit: 100 });
      console.log(
        `[scheduler] Entity backfill complete: ${result.memoriesProcessed} memories, ${result.entitiesCreated} entities created, ${result.entitiesLinked} links, ${result.relationshipsCreated} relationships`
      );
    } catch (err) {
      console.error("[scheduler] Entity backfill error:", err);
      recordJobError("entity_backfill", err);
    }
  });

  // Importance auto-adjustment — every day at 3:30 AM
  schedule("30 3 * * *", () => {
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

      // Recompute quality scores after importance changes
      const qResult = recomputeQualityScores(db);
      if (qResult.updated > 0) {
        console.log(`[scheduler] Quality scores recomputed: ${qResult.updated}/${qResult.total}`);
      }
    } catch (err) {
      console.error("[scheduler] Importance adjustment error:", err);
      recordJobError("importance_adjustment", err);
    }
  });

  // Stale memory archival + expired + sentinel report expiry — every day at 4:00 AM
  schedule("0 4 * * *", () => {
    try {
      console.log("[scheduler] Running stale memory archival...");
      const db = getDb();
      const result = archiveStaleMemories(db);
      console.log(`[scheduler] Archival complete: ${result.archived} memories archived`);

      // Archive memories past their expires_at
      const expiredCount = archiveExpired(db);
      if (expiredCount > 0) {
        console.log(`[scheduler] Archived ${expiredCount} expired memories`);
      }

      // Mark old sentinel reports for expiry
      const ttlStr = getSetting(db, "sentinel.report_ttl_days");
      const ttlDays = ttlStr ? parseInt(ttlStr, 10) : 14;
      const sentinelResult = expireSentinelReports(db, { ttlDays });
      if (sentinelResult.updated > 0) {
        console.log(`[scheduler] Marked ${sentinelResult.updated} sentinel reports for expiry`);
      }

      // Auto tag cleanup (up to 3 near-duplicate merges)
      try {
        const suggestions = suggestTagMerges(db, { minSimilarity: 0.95, limit: 3 });
        for (const s of suggestions) {
          if (s.fromCount <= 50) {
            const result = applyTagMerge(db, s.from, s.to);
            console.log(`[scheduler] Auto-merged tag "${s.from}" → "${s.to}": ${result.updated} memories updated`);
          }
        }
      } catch (err) {
        console.error("[scheduler] Tag cleanup error:", err);
      }
    } catch (err) {
      console.error("[scheduler] Archival error:", err);
      recordJobError("archival", err);
    }
  });

  // Trash purge — every day at 4:30 AM
  schedule("30 4 * * *", () => {
    try {
      console.log("[scheduler] Running trash purge...");
      const db = getDb();
      const result = purgeTrash(db);
      console.log(`[scheduler] Trash purge complete: ${result.purged} memories permanently deleted`);
    } catch (err) {
      console.error("[scheduler] Trash purge error:", err);
      recordJobError("trash_purge", err);
    }
  });

  // Graph densification — every day at 5:00 AM
  schedule("0 5 * * *", () => {
    try {
      console.log("[scheduler] Running graph densification...");
      const db = getDb();
      const result = densifyEntityGraph(db, { minCoOccurrences: 2, limit: 500 });
      console.log(`[scheduler] Graph densification complete: ${result.pairsAnalyzed} pairs, ${result.relationshipsCreated} relationships created`);
    } catch (err) {
      console.error("[scheduler] Graph densification error:", err);
      recordJobError("graph_densification", err);
    }
  });

  // Co-retrieval link building + cleanup — every day at 5:30 AM
  schedule("30 5 * * *", () => {
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
      recordJobError("co_retrieval_links", err);
    }
  });

  const regressionSchedule =
    getSetting(getDb(), "retrieval_regression.schedule") ?? "15 6 * * *";
  schedule(regressionSchedule, async () => {
    try {
      await runScheduledRetrievalRegression();
    } catch (err) {
      console.error("[scheduler] Retrieval regression error:", err);
      recordJobError("retrieval_regression", err);
    }
  });

  console.log(
    `[scheduler] Background jobs scheduled (backup 1:30, consolidation 2:00, contradictions 2:30, entities 3:00, importance 3:30, archival 4:00, purge 4:30, densify 5:00, co-retrieval 5:30, retrieval-regression ${regressionSchedule})`
  );

  // WAL checkpoint every 5 minutes — prevents WAL file growth when nightly
  // batch jobs or frequent writes cause checkpoint starvation
  const walCheckpointHandle = setInterval(() => {
    try {
      const db = getDb();
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (err) {
      console.error("[scheduler] WAL checkpoint error:", err);
    }
  }, 5 * 60 * 1000);
  scheduledTasks.push({ stop: () => clearInterval(walCheckpointHandle) } as ScheduledTask);

  // Re-analyze query planner stats every 4 hours (supplements startup optimize)
  const optimizeHandle = setInterval(() => {
    try {
      const db = getDb();
      db.exec("PRAGMA optimize");
    } catch (err) {
      console.error("[scheduler] PRAGMA optimize error:", err);
    }
  }, 4 * 60 * 60 * 1000);
  scheduledTasks.push({ stop: () => clearInterval(optimizeHandle) } as ScheduledTask);

  // Run maintenance on startup (short delay to not block server init)
  setTimeout(async () => {
    try {
      console.log("[maintenance] Running startup maintenance...");
      await runMaintenanceNow();
    } catch (err) {
      console.error("[maintenance] Startup maintenance error:", err);
    }
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
