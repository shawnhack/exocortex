/**
 * Maintenance operations for Exocortex data quality.
 * - Re-embedding: fill missing embeddings
 * - Entity backfill: process memories without entity links
 * - Importance recalibration: normalize importance distribution
 */

import type { DatabaseSync } from "node:sqlite";
import type { EmbeddingProvider } from "../embedding/types.js";
import { EntityStore } from "../entities/store.js";
import { extractEntities, extractRelationships } from "../entities/extractor.js";

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
        const buffer = new Uint8Array(embedding.buffer);
        update.run(buffer, new Date().toISOString(), row.id);
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
    const now = new Date().toISOString();
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
