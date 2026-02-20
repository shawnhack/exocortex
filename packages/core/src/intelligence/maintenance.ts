/**
 * Maintenance operations for Exocortex data quality.
 * - Re-embedding: fill missing embeddings
 * - Entity backfill: process memories without entity links
 * - Importance recalibration: normalize importance distribution
 * - Weight tuning: adaptive scoring weight adjustment based on feedback
 */

import type { DatabaseSync } from "node:sqlite";
import type { EmbeddingProvider } from "../embedding/types.js";
import { EntityStore } from "../entities/store.js";
import { extractEntities, extractRelationships } from "../entities/extractor.js";
import { setSetting, getSetting } from "../db/schema.js";
import { getTagAliasMap, normalizeTags } from "../memory/tag-normalization.js";
import { computeContentHashForDb } from "../memory/content-hash.js";
import {
  getMetadataTags,
  inferIsMetadata,
} from "../memory/metadata-classification.js";
import { incrementCounter } from "../observability/counters.js";

// --- A1: Re-embedding Pass ---

export interface ReembedResult {
  processed: number;
  failed: number;
  skipped: number;
  dry_run: boolean;
}

export async function reembedMissing(
  db: DatabaseSync,
  provider: EmbeddingProvider,
  opts?: { dryRun?: boolean; batchSize?: number; limit?: number }
): Promise<ReembedResult> {
  const dryRun = opts?.dryRun ?? false;
  const batchSize = opts?.batchSize ?? 50;
  const limit = opts?.limit ?? 10000;

  const rows = db
    .prepare(
      `SELECT id, content FROM memories
       WHERE is_active = 1 AND embedding IS NULL
       LIMIT ?`
    )
    .all(limit) as unknown as Array<{ id: string; content: string }>;

  if (dryRun) {
    return { processed: 0, failed: 0, skipped: rows.length, dry_run: true };
  }

  let processed = 0;
  let failed = 0;

  // Process in batches
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);

    const update = db.prepare(
      "UPDATE memories SET embedding = ?, updated_at = ? WHERE id = ?"
    );

    for (const row of batch) {
      try {
        const embedding = await provider.embed(row.content);
        const buffer = new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);
        update.run(buffer, new Date().toISOString().replace("T", " ").replace("Z", ""), row.id);
        processed++;
      } catch {
        failed++;
      }
    }
  }

  return { processed, failed, skipped: 0, dry_run: false };
}

// --- A2: Entity Graph Backfill ---

export interface BackfillEntitiesResult {
  memoriesProcessed: number;
  entitiesCreated: number;
  entitiesLinked: number;
  relationshipsCreated: number;
  dry_run: boolean;
}

export function backfillEntities(
  db: DatabaseSync,
  opts?: { dryRun?: boolean; limit?: number; includeRelationships?: boolean }
): BackfillEntitiesResult {
  const dryRun = opts?.dryRun ?? false;
  const limit = opts?.limit ?? 100;
  const includeRelationships = opts?.includeRelationships ?? true;

  const unprocessed = db
    .prepare(
      `SELECT m.id, m.content FROM memories m
       WHERE m.is_active = 1
       AND m.id NOT IN (SELECT DISTINCT memory_id FROM memory_entities)
       ORDER BY m.created_at DESC
       LIMIT ?`
    )
    .all(limit) as unknown as Array<{ id: string; content: string }>;

  if (dryRun) {
    return {
      memoriesProcessed: 0,
      entitiesCreated: 0,
      entitiesLinked: 0,
      relationshipsCreated: 0,
      dry_run: true,
    };
  }

  const entityStore = new EntityStore(db);
  let entitiesCreated = 0;
  let entitiesLinked = 0;
  let relationshipsCreated = 0;

  for (const memory of unprocessed) {
    const extracted = extractEntities(memory.content);

    for (const entity of extracted) {
      let existing = entityStore.getByName(entity.name);
      if (!existing) {
        existing = entityStore.create({
          name: entity.name,
          type: entity.type,
        });
        entitiesCreated++;
      }
      entityStore.linkMemory(existing.id, memory.id, entity.confidence);
      entitiesLinked++;
    }

    if (includeRelationships && extracted.length >= 2) {
      const relationships = extractRelationships(memory.content, extracted);
      for (const rel of relationships) {
        const sourceEntity = entityStore.getByName(rel.source);
        const targetEntity = entityStore.getByName(rel.target);
        if (sourceEntity && targetEntity) {
          entityStore.addRelationship(
            sourceEntity.id,
            targetEntity.id,
            rel.relationship,
            rel.confidence,
            memory.id,
            rel.context
          );
          relationshipsCreated++;
        }
      }
    }
  }

  return {
    memoriesProcessed: unprocessed.length,
    entitiesCreated,
    entitiesLinked,
    relationshipsCreated,
    dry_run: false,
  };
}

// --- A3: Importance Recalibration ---

export interface RecalibrateResult {
  adjusted: number;
  oldMean: number;
  newMean: number;
  oldStdDev: number;
  newStdDev: number;
  dry_run: boolean;
  distribution: { min: number; p25: number; median: number; p75: number; max: number };
}

function computeStats(values: number[]): { mean: number; stdDev: number } {
  if (values.length === 0) return { mean: 0, stdDev: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return { mean: Math.round(mean * 1000) / 1000, stdDev: Math.round(Math.sqrt(variance) * 1000) / 1000 };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function recalibrateImportance(
  db: DatabaseSync,
  opts?: { dryRun?: boolean; targetMean?: number; protectPinned?: boolean }
): RecalibrateResult {
  const dryRun = opts?.dryRun ?? false;
  const protectPinned = opts?.protectPinned ?? true;

  const rows = db
    .prepare("SELECT id, importance FROM memories WHERE is_active = 1")
    .all() as unknown as Array<{ id: string; importance: number }>;

  // Separate pinned (importance === 1.0) from adjustable
  const pinned: typeof rows = [];
  const adjustable: typeof rows = [];
  for (const row of rows) {
    if (protectPinned && row.importance === 1.0) {
      pinned.push(row);
    } else {
      adjustable.push(row);
    }
  }

  const allValues = rows.map((r) => r.importance);
  const oldStats = computeStats(allValues);

  if (adjustable.length === 0) {
    const sorted = allValues.slice().sort((a, b) => a - b);
    return {
      adjusted: 0,
      oldMean: oldStats.mean,
      newMean: oldStats.mean,
      oldStdDev: oldStats.stdDev,
      newStdDev: oldStats.stdDev,
      dry_run: dryRun,
      distribution: {
        min: sorted[0] ?? 0,
        p25: percentile(sorted, 25),
        median: percentile(sorted, 50),
        p75: percentile(sorted, 75),
        max: sorted[sorted.length - 1] ?? 0,
      },
    };
  }

  // Sort adjustable by current importance to preserve relative ordering
  adjustable.sort((a, b) => a.importance - b.importance);

  // Percentile-rank normalization: map ranks linearly to [0.10, 0.90]
  const newValues: Array<{ id: string; newImportance: number }> = [];
  for (let i = 0; i < adjustable.length; i++) {
    const rank = adjustable.length === 1 ? 0.5 : i / (adjustable.length - 1);
    const newImportance = Math.round((0.10 + rank * 0.80) * 100) / 100;
    newValues.push({ id: adjustable[i].id, newImportance });
  }

  if (!dryRun) {
    const update = db.prepare(
      "UPDATE memories SET importance = ?, updated_at = ? WHERE id = ?"
    );
    const now = new Date().toISOString().replace("T", " ").replace("Z", "");
    for (const { id, newImportance } of newValues) {
      update.run(newImportance, now, id);
    }
  }

  // Compute new distribution
  const newAllValues = [
    ...pinned.map((p) => p.importance),
    ...newValues.map((v) => v.newImportance),
  ];
  const newStats = computeStats(newAllValues);
  const sorted = newAllValues.slice().sort((a, b) => a - b);

  return {
    adjusted: newValues.length,
    oldMean: oldStats.mean,
    newMean: newStats.mean,
    oldStdDev: oldStats.stdDev,
    newStdDev: newStats.stdDev,
    dry_run: dryRun,
    distribution: {
      min: sorted[0] ?? 0,
      p25: percentile(sorted, 25),
      median: percentile(sorted, 50),
      p75: percentile(sorted, 75),
      max: sorted[sorted.length - 1] ?? 0,
    },
  };
}

// --- A4: Adaptive Scoring Weight Tuning ---

export interface TuneWeightsResult {
  adjusted: boolean;
  reason?: string;
  usefulCount: number;
  notUsefulCount: number;
  adjustments: Record<string, { old: number; new: number }>;
  dry_run: boolean;
}

/**
 * Analyze correlation between memory properties and usefulness feedback,
 * then nudge scoring weights to favor signals that predict usefulness.
 *
 * Compares memories that proved useful (useful_count > 0) vs those retrieved
 * but not useful (access_count > 0, useful_count = 0). Adjusts weights by
 * ±0.02 per cycle, keeping total in a valid range.
 */
export function tuneWeights(
  db: DatabaseSync,
  opts?: { dryRun?: boolean; maxNudge?: number }
): TuneWeightsResult {
  const dryRun = opts?.dryRun ?? false;
  const maxNudge = opts?.maxNudge ?? 0.02;

  // Get memories that have been retrieved
  const rows = db
    .prepare(
      `SELECT id, access_count, useful_count, importance, created_at
       FROM memories WHERE is_active = 1 AND access_count > 0`
    )
    .all() as unknown as Array<{
      id: string;
      access_count: number;
      useful_count: number;
      importance: number;
      created_at: string;
    }>;

  const useful = rows.filter((m) => m.useful_count > 0);
  const notUseful = rows.filter((m) => m.useful_count === 0);

  if (useful.length < 5 || notUseful.length < 5) {
    return {
      adjusted: false,
      reason: `Insufficient data: ${useful.length} useful, ${notUseful.length} not useful (need 5+ each)`,
      usefulCount: useful.length,
      notUsefulCount: notUseful.length,
      adjustments: {},
      dry_run: dryRun,
    };
  }

  const now = Date.now();
  const daysSince = (createdAt: string) => {
    const ts = new Date(createdAt + (createdAt.includes("Z") ? "" : "Z")).getTime();
    return (now - ts) / (1000 * 60 * 60 * 24);
  };

  // Compute average properties for each group
  const mean = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;

  const usefulAvgAge = mean(useful.map((m) => daysSince(m.created_at)));
  const notUsefulAvgAge = mean(notUseful.map((m) => daysSince(m.created_at)));

  const usefulAvgAccess = mean(useful.map((m) => m.access_count));
  const notUsefulAvgAccess = mean(notUseful.map((m) => m.access_count));

  const usefulAvgImportance = mean(useful.map((m) => m.importance));
  const notUsefulAvgImportance = mean(notUseful.map((m) => m.importance));

  // Count links per memory
  const countLinks = (id: string): number => {
    const row = db
      .prepare(
        "SELECT COUNT(*) as cnt FROM memory_links WHERE source_id = ? OR target_id = ?"
      )
      .get(id, id) as { cnt: number };
    return row.cnt;
  };

  const usefulAvgLinks = mean(useful.map((m) => countLinks(m.id)));
  const notUsefulAvgLinks = mean(notUseful.map((m) => countLinks(m.id)));

  // Current weights
  const currentWeights = {
    recency: parseFloat(getSetting(db, "scoring.recency_weight") ?? "0.20"),
    frequency: parseFloat(getSetting(db, "scoring.frequency_weight") ?? "0.10"),
    graph: parseFloat(getSetting(db, "scoring.graph_weight") ?? "0.10"),
    usefulness: parseFloat(getSetting(db, "scoring.usefulness_weight") ?? "0.05"),
  };

  // Compute nudges based on property differences
  const adjustments: Record<string, { old: number; new: number }> = {};

  // Recency: if useful memories are newer, boost recency weight
  const ageDiff = notUsefulAvgAge - usefulAvgAge; // positive = useful are newer
  const recencyNudge = Math.max(-maxNudge, Math.min(maxNudge, ageDiff > 5 ? maxNudge : ageDiff < -5 ? -maxNudge : 0));

  // Frequency: if useful memories are more frequently accessed, boost frequency
  const freqRatio = usefulAvgAccess / Math.max(1, notUsefulAvgAccess);
  const freqNudge = freqRatio > 1.5 ? maxNudge : freqRatio < 0.67 ? -maxNudge : 0;

  // Graph: if useful memories have more links, boost graph weight
  const linkDiff = usefulAvgLinks - notUsefulAvgLinks;
  const graphNudge = linkDiff > 0.5 ? maxNudge : linkDiff < -0.5 ? -maxNudge : 0;

  // Usefulness: self-reinforcing — if feedback is accumulating, slightly boost
  const usefulnessNudge = useful.length > 20 ? maxNudge : 0;

  // Apply nudges with bounds [0.02, 0.40]
  const clamp = (v: number) => Math.round(Math.max(0.02, Math.min(0.40, v)) * 100) / 100;

  const newWeights = {
    recency: clamp(currentWeights.recency + recencyNudge),
    frequency: clamp(currentWeights.frequency + freqNudge),
    graph: clamp(currentWeights.graph + graphNudge),
    usefulness: clamp(currentWeights.usefulness + usefulnessNudge),
  };

  for (const key of Object.keys(newWeights) as Array<keyof typeof newWeights>) {
    if (newWeights[key] !== currentWeights[key]) {
      adjustments[key] = { old: currentWeights[key], new: newWeights[key] };
    }
  }

  if (Object.keys(adjustments).length === 0) {
    return {
      adjusted: false,
      reason: "No adjustments needed — signals balanced",
      usefulCount: useful.length,
      notUsefulCount: notUseful.length,
      adjustments: {},
      dry_run: dryRun,
    };
  }

  if (!dryRun) {
    const settingMap: Record<string, string> = {
      recency: "scoring.recency_weight",
      frequency: "scoring.frequency_weight",
      graph: "scoring.graph_weight",
      usefulness: "scoring.usefulness_weight",
    };

    for (const [key, { new: val }] of Object.entries(adjustments)) {
      setSetting(db, settingMap[key], val.toString());
    }
  }

  return {
    adjusted: true,
    usefulCount: useful.length,
    notUsefulCount: notUseful.length,
    adjustments,
    dry_run: dryRun,
  };
}

// --- A5: Canonical Backfill (hashes + tags + metadata flag) ---

export interface CanonicalBackfillResult {
  scanned: number;
  hashesUpdated: number;
  tagsUpdated: number;
  metadataFlagUpdated: number;
  dry_run: boolean;
}

export function backfillMemoryCanonicalization(
  db: DatabaseSync,
  opts?: { dryRun?: boolean; limit?: number }
): CanonicalBackfillResult {
  const dryRun = opts?.dryRun ?? false;
  const limit = opts?.limit ?? 10000;
  const aliasMap = getTagAliasMap(db);
  const metadataTags = getMetadataTags(db, aliasMap);

  const rows = db
    .prepare(
      `SELECT id, content, content_hash, is_metadata, metadata
       FROM memories
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(limit) as Array<{
    id: string;
    content: string;
    content_hash: string | null;
    is_metadata: number;
    metadata: string | null;
  }>;

  if (rows.length === 0) {
    return {
      scanned: 0,
      hashesUpdated: 0,
      tagsUpdated: 0,
      metadataFlagUpdated: 0,
      dry_run: dryRun,
    };
  }

  const selectTags = db.prepare(
    "SELECT tag FROM memory_tags WHERE memory_id = ? ORDER BY tag ASC"
  );
  const deleteTags = db.prepare("DELETE FROM memory_tags WHERE memory_id = ?");
  const insertTag = db.prepare(
    "INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)"
  );
  const updateHash = db.prepare(
    "UPDATE memories SET content_hash = ?, updated_at = ? WHERE id = ?"
  );
  const updateMetadataFlag = db.prepare(
    "UPDATE memories SET is_metadata = ?, updated_at = ? WHERE id = ?"
  );

  let hashesUpdated = 0;
  let tagsUpdated = 0;
  let metadataFlagUpdated = 0;
  const now = new Date().toISOString().replace("T", " ").replace("Z", "");

  if (!dryRun) db.exec("BEGIN");
  try {
    for (const row of rows) {
      const desiredHash = computeContentHashForDb(db, row.content);
      if (row.content_hash !== desiredHash) {
        hashesUpdated++;
        if (!dryRun) {
          updateHash.run(desiredHash, now, row.id);
        }
      }

      const currentTags = (selectTags.all(row.id) as Array<{ tag: string }>).map(
        (t) => t.tag
      );
      const normalizedTags = normalizeTags(currentTags, aliasMap).slice().sort();
      const sortedCurrent = [...currentTags].sort();
      const tagsChanged =
        normalizedTags.length !== sortedCurrent.length ||
        normalizedTags.some((t, i) => t !== sortedCurrent[i]);
      if (tagsChanged) {
        tagsUpdated++;
        if (!dryRun) {
          deleteTags.run(row.id);
          for (const tag of normalizedTags) {
            insertTag.run(row.id, tag);
          }
        }
      }

      let parsedMetadata: Record<string, unknown> = {};
      if (row.metadata) {
        try {
          parsedMetadata = JSON.parse(row.metadata) as Record<string, unknown>;
        } catch {
          parsedMetadata = {};
        }
      }
      const inferredMetadata = inferIsMetadata({
        tags: normalizedTags,
        metadata: parsedMetadata,
        metadataTags,
      });
      const currentIsMetadata = row.is_metadata === 1;
      if (currentIsMetadata !== inferredMetadata) {
        metadataFlagUpdated++;
        if (!dryRun) {
          updateMetadataFlag.run(inferredMetadata ? 1 : 0, now, row.id);
        }
      }
    }

    if (!dryRun) db.exec("COMMIT");
  } catch (err) {
    if (!dryRun) db.exec("ROLLBACK");
    throw err;
  }

  if (!dryRun) {
    if (hashesUpdated > 0) {
      incrementCounter(db, "maintenance.hash_backfill_updates", hashesUpdated);
    }
    if (tagsUpdated > 0) {
      incrementCounter(db, "maintenance.tag_normalization_updates", tagsUpdated);
    }
    if (metadataFlagUpdated > 0) {
      incrementCounter(db, "maintenance.metadata_flag_updates", metadataFlagUpdated);
    }
  }

  return {
    scanned: rows.length,
    hashesUpdated,
    tagsUpdated,
    metadataFlagUpdated,
    dry_run: dryRun,
  };
}

// --- A6: Prune Old Data ---

export interface PruneResult {
  access_log: number;
  search_misses: number;
  co_retrievals: number;
}

/**
 * Delete old rows from access_log, search_misses, and co_retrievals
 * to prevent unbounded table growth. Keeps last 90 days of data.
 */
export function pruneOldData(db: DatabaseSync, retentionDays = 90): PruneResult {
  const deleteAccessLog = db.prepare(
    `DELETE FROM access_log WHERE accessed_at < datetime('now', '-' || ? || ' days')`
  );
  const deleteSearchMisses = db.prepare(
    `DELETE FROM search_misses WHERE created_at < datetime('now', '-' || ? || ' days')`
  );
  const deleteCoRetrievals = db.prepare(
    `DELETE FROM co_retrievals WHERE created_at < datetime('now', '-' || ? || ' days')`
  );

  const r1 = deleteAccessLog.run(retentionDays) as { changes: number };
  const r2 = deleteSearchMisses.run(retentionDays) as { changes: number };
  const r3 = deleteCoRetrievals.run(retentionDays) as { changes: number };

  return {
    access_log: r1.changes,
    search_misses: r2.changes,
    co_retrievals: r3.changes,
  };
}
