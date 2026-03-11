import type { DatabaseSync } from "node:sqlite";
import { MemoryStore, MemoryLinkStore, searchFacts, getCachedProfiles } from "@exocortex/core";

// --- Per-session state: retrieval feedback tracking ---
export const SEARCH_RESULT_TTL = 5 * 60 * 1000; // 5 minutes

export function createSessionState() {
  const recentSearchIds = new Map<string, number>(); // memory_id -> timestamp

  function recordSearchResults(ids: string[]): void {
    const now = Date.now();
    for (const id of ids) recentSearchIds.set(id, now);
    for (const [id, ts] of recentSearchIds) {
      if (now - ts > SEARCH_RESULT_TTL) recentSearchIds.delete(id);
    }
  }

  function checkAndSignalUsefulness(ids: string[], db: DatabaseSync): string[] {
    const now = Date.now();
    const useful: string[] = [];
    const store = new MemoryStore(db);
    for (const id of ids) {
      const ts = recentSearchIds.get(id);
      if (ts && now - ts <= SEARCH_RESULT_TTL) {
        useful.push(id);
        recentSearchIds.delete(id);
        try { store.incrementUsefulCount(id); } catch { /* non-critical */ }
      }
    }
    return useful;
  }

  return { recordSearchResults, checkAndSignalUsefulness };
}

// --- Multi-hop context expansion ---

export interface LinkedExpansion {
  id: string;
  content: string;
  tags: string[];
  created_at: string;
  importance: number;
  linked_from: string;
  link_type: string;
  strength: number;
}

export function expandViaLinks(db: DatabaseSync, resultIds: string[], maxExpansion: number = 5): LinkedExpansion[] {
  if (resultIds.length === 0) return [];
  const linkStore = new MemoryLinkStore(db);
  const refs = linkStore.getLinkedRefs(resultIds);

  const expanded: LinkedExpansion[] = [];
  for (const ref of refs) {
    if (expanded.length >= maxExpansion) break;
    try {
      const mem = db
        .prepare("SELECT id, content, importance, created_at FROM memories WHERE id = ? AND is_active = 1")
        .get(ref.id) as { id: string; content: string; importance: number; created_at: string } | undefined;
      if (!mem) continue;

      const tags = (db
        .prepare("SELECT tag FROM memory_tags WHERE memory_id = ?")
        .all(ref.id) as Array<{ tag: string }>).map((t) => t.tag);

      expanded.push({
        ...mem,
        tags,
        linked_from: ref.linked_from,
        link_type: ref.link_type,
        strength: ref.strength,
      });
    } catch { /* skip bad refs */ }
  }
  return expanded;
}

// --- Fact surfacing ---

export function buildFactsSection(db: DatabaseSync, query: string): string {
  try {
    const words = query.split(/\s+/).filter((w) => w.length >= 3);
    if (words.length === 0) return "";

    const allFacts: Array<{ subject: string; predicate: string; object: string }> = [];
    const seen = new Set<string>();

    for (const word of words) {
      const facts = searchFacts(db, { subject: word, limit: 5 });
      for (const f of facts) {
        const key = `${f.subject}|${f.predicate}|${f.object}`;
        if (!seen.has(key)) {
          seen.add(key);
          allFacts.push(f);
        }
      }
    }

    if (allFacts.length === 0) return "";

    const lines = allFacts.slice(0, 5).map(
      (f) => `- ${f.subject} [${f.predicate}] ${f.object}`
    );
    return `\n\n--- Facts ---\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

// --- Entity profile section ---

export function buildEntityProfileSection(db: DatabaseSync, memoryIds: string[]): string {
  if (memoryIds.length === 0) return "";
  try {
    const placeholders = memoryIds.map(() => "?").join(", ");
    const rows = db.prepare(`
      SELECT me.entity_id, e.name, COUNT(*) as link_count
      FROM memory_entities me
      JOIN entities e ON me.entity_id = e.id
      WHERE me.memory_id IN (${placeholders})
      GROUP BY me.entity_id
      ORDER BY link_count DESC
      LIMIT 5
    `).all(...memoryIds) as Array<{ entity_id: string; name: string; link_count: number }>;

    if (rows.length === 0) return "";

    const entityIds = rows.map((r) => r.entity_id);
    const profiles = getCachedProfiles(db, entityIds);

    if (profiles.size === 0) return "";

    const lines: string[] = [];
    for (const row of rows) {
      const profile = profiles.get(row.entity_id);
      if (profile) {
        lines.push(`- **${row.name}**: ${profile}`);
      }
    }

    if (lines.length === 0) return "";
    return `\n\n--- Entity Profiles ---\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}
