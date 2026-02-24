import type { DatabaseSync } from "node:sqlite";
import { getSetting, setSetting } from "../db/schema.js";

export const DEFAULT_TAG_ALIAS_MAP: Record<string, string> = {
  nextjs: "next.js",
  "next-js": "next.js",
  reactjs: "react",
};

function canonicalize(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[ _]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeAliasMap(
  map: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    const key = canonicalize(k);
    const value = canonicalize(v);
    if (key && value) {
      out[key] = value;
    }
  }
  return out;
}

export function parseTagAliasMap(raw?: string | null): Record<string, string> {
  if (!raw) return { ...DEFAULT_TAG_ALIAS_MAP };
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    return {
      ...DEFAULT_TAG_ALIAS_MAP,
      ...normalizeAliasMap(parsed),
    };
  } catch {
    return { ...DEFAULT_TAG_ALIAS_MAP };
  }
}

export function getTagAliasMap(db: DatabaseSync): Record<string, string> {
  return parseTagAliasMap(getSetting(db, "tags.alias_map"));
}

export function normalizeTag(
  tag: string,
  aliasMap: Record<string, string> = DEFAULT_TAG_ALIAS_MAP
): string {
  const canonical = canonicalize(tag);
  if (!canonical) return "";
  return aliasMap[canonical] ?? canonical;
}

export function normalizeTags(
  tags: string[] | undefined,
  aliasMap: Record<string, string> = DEFAULT_TAG_ALIAS_MAP
): string[] {
  if (!tags || tags.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();

  for (const tag of tags) {
    const normalized = normalizeTag(tag, aliasMap);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }

  return out;
}

// --- Tag Taxonomy / Auto-Merge ---

/**
 * Normalized Levenshtein distance (0-1). 1 = identical, 0 = completely different.
 * No external deps.
 */
export function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (la === 0 || lb === 0) return 0;

  // Levenshtein distance via DP
  const matrix: number[][] = [];
  for (let i = 0; i <= la; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= lb; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  const distance = matrix[la][lb];
  return 1 - distance / Math.max(la, lb);
}

export interface TagMergeSuggestion {
  from: string;
  to: string;
  similarity: number;
  fromCount: number;
  toCount: number;
  coOccurrence: number;
}

/**
 * Pairwise comparison of tags with count >= minCount.
 * Returns pairs with similarity >= threshold.
 */
export function suggestTagMerges(
  db: DatabaseSync,
  opts?: { minSimilarity?: number; minCount?: number; limit?: number }
): TagMergeSuggestion[] {
  const minSimilarity = opts?.minSimilarity ?? 0.8;
  const minCount = opts?.minCount ?? 2;
  const limit = opts?.limit ?? 20;

  const tagRows = db
    .prepare(
      `SELECT tag, COUNT(*) as cnt FROM memory_tags
       GROUP BY tag HAVING COUNT(*) >= ?
       ORDER BY cnt DESC`
    )
    .all(minCount) as Array<{ tag: string; cnt: number }>;

  const suggestions: TagMergeSuggestion[] = [];

  for (let i = 0; i < tagRows.length; i++) {
    for (let j = i + 1; j < tagRows.length; j++) {
      const a = tagRows[i];
      const b = tagRows[j];
      const sim = stringSimilarity(a.tag, b.tag);
      if (sim >= minSimilarity && sim < 1) {
        const [from, to] = a.cnt >= b.cnt ? [b, a] : [a, b];

        const coRow = db
          .prepare(
            `SELECT COUNT(*) as cnt FROM memory_tags t1
             INNER JOIN memory_tags t2 ON t1.memory_id = t2.memory_id
             WHERE t1.tag = ? AND t2.tag = ?`
          )
          .get(from.tag, to.tag) as { cnt: number };

        suggestions.push({
          from: from.tag,
          to: to.tag,
          similarity: Math.round(sim * 1000) / 1000,
          fromCount: from.cnt,
          toCount: to.cnt,
          coOccurrence: coRow.cnt,
        });
      }
    }
  }

  suggestions.sort((a, b) => b.similarity - a.similarity);
  return suggestions.slice(0, limit);
}

/**
 * Rename all instances of fromTag to toTag in memory_tags,
 * and add the mapping to the alias map setting. Transaction-safe.
 */
export function applyTagMerge(
  db: DatabaseSync,
  fromTag: string,
  toTag: string
): { updated: number } {
  const from = canonicalize(fromTag);
  const to = canonicalize(toTag);
  if (!from || !to || from === to) return { updated: 0 };

  db.exec("BEGIN");
  try {
    // Delete duplicate rows where memory already has the target tag
    db.prepare(
      `DELETE FROM memory_tags
       WHERE tag = ? AND memory_id IN (
         SELECT memory_id FROM memory_tags WHERE tag = ?
       )`
    ).run(from, to);

    // Rename remaining
    const result = db
      .prepare("UPDATE memory_tags SET tag = ? WHERE tag = ?")
      .run(to, from) as { changes: number };

    // Update alias map in settings
    const currentMap = getTagAliasMap(db);
    currentMap[from] = to;
    setSetting(db, "tags.alias_map", JSON.stringify(currentMap));

    db.exec("COMMIT");
    return { updated: result.changes };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

