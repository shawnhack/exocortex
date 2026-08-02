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
 * Bare job-identity tags — the name of the scheduled job that produced a
 * memory, written without the `sentinel:` prefix.
 *
 * These are PROVENANCE, not topic. Collapsing them into a topic bucket
 * destroys the only way to ask "what did job X find?", which is exactly how
 * digest and briefing jobs assemble their inputs.
 *
 * This is not hypothetical. The canonical map contained `watchlist ->
 * operations`, so every watchlist finding was stored with its identity
 * stripped. The producing job was correct, the agent complied with its
 * prompt, and the consuming job searched the right tag — but the storage
 * layer rewrote the tag in between, silently, and the daily briefing
 * rendered an empty Watchlist section for months. The failure was first
 * noticed 2026-04-23 and only root-caused 2026-08-02.
 *
 * Add new job names here when new scheduled jobs are introduced.
 */
const JOB_IDENTITY_TAGS = new Set([
  "watchlist",
  "health-check",
  "memory-gardening",
  "gardening",
  "state-reconciliation",
  "friction-bridging",
  "reweave",
  "retrieval-tuning",
  "retrieval-remediation",
  "retrieval-qa-eval",
  "dependency-audit",
  "session-cleanup",
  "config-backup",
  "frequency-review",
  "knowledge-ingestion",
  "crypto-alpha",
  "github-scout",
  "proactive-insights",
  "goal-worker",
  "dispatcher",
  "research-briefing",
  "obsidian-briefing",
  "obsidian-export",
  "epoch-digest",
  "metrics",
  "self-audit",
  "security-audit",
  "contradiction-sweep",
  "code-evolve",
  "scoring-evolve",
  "prompt-evolve",
]);

/**
 * Tags that must survive normalization untouched.
 *
 * Two categories: correlation handles (run tokens, sessions, sources, dates)
 * and job-identity tags. Both are used as exact-match retrieval filters, so
 * rewriting them does not merely lose precision — it makes the memory
 * unfindable by the only query that would look for it.
 */
export function isProtectedTag(tag: string): boolean {
  return (
    tag.startsWith("run-token:") ||
    tag.startsWith("session:") ||
    tag.startsWith("source:") ||
    tag.startsWith("sentinel:") ||
    /^\d{4}-\d{2}-\d{2}/.test(tag) ||
    JOB_IDENTITY_TAGS.has(tag) ||
    tag === "openapi"
  );
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
      if (isProtectedTag(a.tag) || isProtectedTag(b.tag)) continue;
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
  if (isProtectedTag(from) || isProtectedTag(to)) {
    throw new Error(`Refusing to merge protected tag "${from}" into "${to}"`);
  }

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

// --- Canonical Tag Taxonomy ---

/**
 * Parse a canonical map JSON string from settings.
 * Returns empty object if null/invalid.
 *
 * Entries whose KEY is a protected tag are dropped. The canonical map is
 * editable at runtime (the gardening job's tag-cleanup writes to it), so a
 * rule that erases provenance can be introduced long after the code is
 * reviewed. Filtering here means the guard holds no matter how the map got
 * its contents, and it neutralizes bad entries already persisted in settings
 * without needing a migration.
 */
export function parseCanonicalMap(raw?: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v !== "string") continue;
      const key = k.toLowerCase();
      // Never let the map rewrite a tag that retrieval filters on exactly.
      if (isProtectedTag(key)) continue;
      out[key] = v.toLowerCase();
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Read the canonical tag map from the database settings.
 */
export function getCanonicalMap(db: DatabaseSync): Record<string, string> {
  return parseCanonicalMap(getSetting(db, "tags.canonical_map"));
}

/**
 * Map tags through a canonical taxonomy map.
 * Unmapped tags pass through unchanged. Deduplicates after mapping.
 * Returns the mapped tags and a list of unmapped ones.
 */
export function canonicalizeTags(
  tags: string[],
  canonicalMap: Record<string, string>
): { tags: string[]; unmapped: string[] } {
  if (tags.length === 0) return { tags: [], unmapped: [] };
  if (Object.keys(canonicalMap).length === 0) return { tags: [...tags], unmapped: [...tags] };

  const out: string[] = [];
  const unmapped: string[] = [];
  const seen = new Set<string>();

  for (const tag of tags) {
    const mapped = canonicalMap[tag] ?? tag;
    if (canonicalMap[tag] === undefined) {
      unmapped.push(tag);
    }
    if (!seen.has(mapped)) {
      seen.add(mapped);
      out.push(mapped);
    }
  }

  return { tags: out, unmapped };
}
