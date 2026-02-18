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
  extractEntities,
  EntityStore,
  archiveStaleMemories,
  adjustImportance,
  getSetting,
  purgeTrash,
  backupDatabase,
} from "@exocortex/core";

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

  // Entity extraction for unprocessed memories — every day at 3:00 AM
  cron.schedule("0 3 * * *", () => {
    try {
      console.log("[scheduler] Running entity extraction on unprocessed memories...");
      const db = getDb();
      const entityStore = new EntityStore(db);

      // Find memories without any linked entities
      const unprocessed = db
        .prepare(
          `SELECT m.id, m.content FROM memories m
           WHERE m.is_active = 1
           AND m.id NOT IN (SELECT DISTINCT memory_id FROM memory_entities)
           ORDER BY m.created_at DESC
           LIMIT 100`
        )
        .all() as unknown as Array<{ id: string; content: string }>;

      let entitiesLinked = 0;

      for (const memory of unprocessed) {
        const extracted = extractEntities(memory.content);
        for (const entity of extracted) {
          // Find or create entity
          let existing = entityStore.getByName(entity.name);
          if (!existing) {
            existing = entityStore.create({
              name: entity.name,
              type: entity.type,
            });
          }
          entityStore.linkMemory(existing.id, memory.id, entity.confidence);
          entitiesLinked++;
        }
      }

      console.log(
        `[scheduler] Entity extraction complete: ${unprocessed.length} memories processed, ${entitiesLinked} entity links created`
      );
    } catch (err) {
      console.error("[scheduler] Entity extraction error:", err);
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

  console.log("[scheduler] Background jobs scheduled (backup 1:30, consolidation 2:00, contradictions 2:30, entities 3:00, importance 3:30, archival 4:00, purge 4:30)");

  // Run maintenance on startup (short delay to not block server init)
  setTimeout(() => {
    console.log("[maintenance] Running startup maintenance...");
    runMaintenanceNow();
  }, 5000);
}
