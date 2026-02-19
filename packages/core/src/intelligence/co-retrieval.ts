import type { DatabaseSync } from "node:sqlite";
import { MemoryLinkStore } from "../memory/links.js";

export interface CoRetrievalLinkOptions {
  dryRun?: boolean;
  minCoRetrievals?: number; // default 3
  lookbackDays?: number; // default 30
  maxLinks?: number; // default 200
}

export interface CoRetrievalLinkResult {
  pairsAnalyzed: number;
  linksCreated: number;
  linksStrengthened: number;
  dry_run: boolean;
}

/**
 * Build memory links from co-retrieval patterns.
 * Memories frequently returned together in search results
 * are likely related and should be linked.
 */
export function buildCoRetrievalLinks(
  db: DatabaseSync,
  opts?: CoRetrievalLinkOptions
): CoRetrievalLinkResult {
  const dryRun = opts?.dryRun ?? false;
  const minCoRetrievals = opts?.minCoRetrievals ?? 3;
  const lookbackDays = opts?.lookbackDays ?? 30;
  const maxLinks = opts?.maxLinks ?? 200;

  const since = new Date(Date.now() - lookbackDays * 86400000)
    .toISOString()
    .replace("T", " ")
    .replace("Z", "");

  // Get all co-retrieval records within lookback period
  const records = db
    .prepare(
      "SELECT memory_ids FROM co_retrievals WHERE created_at >= ?"
    )
    .all(since) as Array<{ memory_ids: string }>;

  // Count pairwise co-occurrences
  const pairCounts = new Map<string, number>();

  for (const record of records) {
    let ids: string[];
    try {
      ids = JSON.parse(record.memory_ids);
    } catch {
      continue;
    }

    // Generate all pairs from this result set
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = ids[i] < ids[j] ? `${ids[i]}|${ids[j]}` : `${ids[j]}|${ids[i]}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }

  // Filter to pairs meeting threshold, sort by count desc
  const eligiblePairs = Array.from(pairCounts.entries())
    .filter(([, count]) => count >= minCoRetrievals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxLinks);

  let linksCreated = 0;
  let linksStrengthened = 0;

  if (!dryRun && eligiblePairs.length > 0) {
    const linkStore = new MemoryLinkStore(db);

    for (const [key, count] of eligiblePairs) {
      const [sourceId, targetId] = key.split("|");
      const strength = Math.min(0.9, 0.3 + (count / 20) * 0.6);

      // Check if link already exists
      const existing = db
        .prepare(
          "SELECT strength FROM memory_links WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)"
        )
        .get(sourceId, targetId, targetId, sourceId) as
        | { strength: number }
        | undefined;

      if (existing) {
        // Strengthen existing link (cap at 0.9)
        const newStrength = Math.min(0.9, existing.strength + 0.05);
        if (newStrength > existing.strength) {
          db.prepare(
            "UPDATE memory_links SET strength = ? WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)"
          ).run(newStrength, sourceId, targetId, targetId, sourceId);
          linksStrengthened++;
        }
      } else {
        linkStore.link(sourceId, targetId, "related", strength);
        linksCreated++;
      }
    }
  } else if (dryRun) {
    // In dry run, estimate what would happen
    for (const [key] of eligiblePairs) {
      const [sourceId, targetId] = key.split("|");
      const existing = db
        .prepare(
          "SELECT 1 FROM memory_links WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)"
        )
        .get(sourceId, targetId, targetId, sourceId);

      if (existing) {
        linksStrengthened++;
      } else {
        linksCreated++;
      }
    }
  }

  return {
    pairsAnalyzed: eligiblePairs.length,
    linksCreated,
    linksStrengthened,
    dry_run: dryRun,
  };
}
