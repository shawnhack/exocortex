import type { DatabaseSync } from "node:sqlite";
import { MemoryStore } from "./store.js";

/**
 * Process-scoped auto-marking of search results as "useful".
 *
 * The MCP tool layer historically held this cooldown state in a closure
 * via `createSessionState()`. That works for MCP (one MCP server = one
 * effective session) but the HTTP route has no session object, so it
 * needed its own state.
 *
 * Promoting the cooldown to a module-level singleton lets both paths
 * share consistent debouncing and ensures HTTP clients (dashboard, REST
 * API consumers) participate in the same usefulness-signal capture as
 * MCP clients. This was the missing piece for the tier-promotion fix to
 * benefit non-MCP retrieval paths.
 */

const SEARCH_USEFULNESS_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h per-memory

const cooldown = new Map<string, number>();

/**
 * Credit the top-N search results with a usefulness increment.
 *
 * Only the top-N results (by rank) are incremented regardless of total
 * result count — broad queries don't inflate every hit, but focused
 * signal still lands on the top of the list. Per-memory 24h cooldown
 * prevents repeated searches from spamming the count.
 *
 * Failures are caught and logged but never thrown — usefulness signals
 * are statistical, a single missed increment doesn't matter, but a
 * persistent failure should be diagnosable.
 */
export function autoMarkTopUseful(
  db: DatabaseSync,
  ids: string[],
  maxMark: number = 3,
): void {
  if (ids.length === 0) return;

  const now = Date.now();
  const store = new MemoryStore(db);
  const topIds = ids.slice(0, maxMark);

  for (const id of topIds) {
    const lastMarked = cooldown.get(id);
    if (lastMarked && now - lastMarked < SEARCH_USEFULNESS_COOLDOWN_MS) continue;
    try {
      store.incrementUsefulCount(id);
      cooldown.set(id, now);
    } catch (err) {
      // Persistent failure here (e.g. SQLite lock contention or schema
      // regression) is the same class of bug that previously starved tier
      // promotion — log so we don't silently lose all usefulness signals.
      console.warn(
        `autoMarkTopUseful: failed to increment useful_count for ${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Prune expired cooldown entries opportunistically
  if (cooldown.size > 1000) {
    for (const [id, ts] of cooldown) {
      if (now - ts > SEARCH_USEFULNESS_COOLDOWN_MS) cooldown.delete(id);
    }
  }
}

/** Test-only helper: wipe the cooldown map between cases. */
export function _resetUsefulnessCooldown(): void {
  cooldown.clear();
}
