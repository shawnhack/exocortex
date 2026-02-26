#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { getDb, closeDb, initializeSchema, MemoryStore, MemorySearch, MemoryLinkStore, EntityStore, GoalStore, getEmbeddingProvider, cosineSimilarity, getArchiveCandidates, archiveStaleMemories, archiveExpired, adjustImportance, ingestFiles, getRRFConfig, digestTranscript, findClusters, consolidateCluster, generateBasicSummary, autoConsolidate, runHealthChecks, computeGraphStats, computeCentrality, getTopBridgeEntities, detectCommunities, getSearchMisses, reembedMissing, reembedAll, backfillEntities, recalibrateImportance, tuneWeights, getMemoryLineage, getDecisionTimeline, densifyEntityGraph, buildCoRetrievalLinks, suggestTagMerges, applyTagMerge, getSetting, getQualityDistribution, getContradictions, updateContradiction, autoDismissContradictions, getCachedProfiles, recomputeEntityProfiles, searchFacts, validateStorageGate, stripPrivateContent, recomputeQualityScores } from "@exocortex/core";
import type { LinkType } from "@exocortex/core";
import type { ContentType } from "@exocortex/core";

const startTime = Date.now();

// --- Utility functions ---

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function packByTokenBudget<T>(
  items: T[],
  maxTokens: number,
  formatFn: (item: T) => string
): { packed: T[]; formatted: string[]; totalTokens: number } {
  const packed: T[] = [];
  const formatted: string[] = [];
  let totalTokens = 0;

  for (const item of items) {
    const text = formatFn(item);
    const tokens = estimateTokens(text);

    if (packed.length > 0 && totalTokens + tokens > maxTokens) break;

    // Always include at least one result
    packed.push(item);
    formatted.push(text);
    totalTokens += tokens;
  }

  return { packed, formatted, totalTokens };
}

function smartPreview(content: string, query: string, maxLen = 200): string {
  const sentences = content.split(/(?<=[.!?])\s+/).filter((s) => s.length > 0);
  if (sentences.length === 0) return content.substring(0, maxLen);

  const queryWords = new Set(
    query.toLowerCase().split(/\s+/).filter((w) => w.length > 2)
  );

  if (queryWords.size === 0) {
    const first = sentences[0];
    return first.length > maxLen ? first.substring(0, maxLen - 3) + "..." : first;
  }

  let bestScore = -1;
  let bestSentence = sentences[0];

  for (const sentence of sentences) {
    const words = sentence.toLowerCase().split(/\s+/);
    const overlap = words.filter((w) => queryWords.has(w)).length;
    if (overlap > bestScore) {
      bestScore = overlap;
      bestSentence = sentence;
    }
  }

  return bestSentence.length > maxLen
    ? bestSentence.substring(0, maxLen - 3) + "..."
    : bestSentence;
}

const server = new McpServer({
  name: "exocortex",
  version: "0.1.0",
});

// Eagerly initialize DB + schema + embedding model at startup
// so first tool call doesn't pay the cost
const db = getDb();
initializeSchema(db);

// Default attribution from environment — each MCP client can set these
// so memories are tagged with the correct provider/model even if the caller omits them.
const DEFAULT_ATTRIBUTION = {
  provider: process.env.EXOCORTEX_DEFAULT_PROVIDER || undefined,
  model_id: process.env.EXOCORTEX_DEFAULT_MODEL_ID || undefined,
  model_name: process.env.EXOCORTEX_DEFAULT_MODEL_NAME || undefined,
  agent: process.env.EXOCORTEX_DEFAULT_AGENT || undefined,
};
if (process.env.EXOCORTEX_SKIP_EMBEDDING_WARMUP !== "1") {
  getEmbeddingProvider().catch(() => {
    // Model warmup failed — will retry on first tool call
  });
}

// --- Retrieval feedback: track recent search results for implicit usefulness signaling ---
const SEARCH_RESULT_TTL = 5 * 60 * 1000; // 5 minutes
const recentSearchIds = new Map<string, number>(); // memory_id → timestamp

function recordSearchResults(ids: string[]): void {
  const now = Date.now();
  for (const id of ids) recentSearchIds.set(id, now);
  // Cleanup expired entries
  for (const [id, ts] of recentSearchIds) {
    if (now - ts > SEARCH_RESULT_TTL) recentSearchIds.delete(id);
  }
}

function checkAndSignalUsefulness(ids: string[]): string[] {
  const now = Date.now();
  const useful: string[] = [];
  const store = new MemoryStore(db);
  for (const id of ids) {
    const ts = recentSearchIds.get(id);
    if (ts && now - ts <= SEARCH_RESULT_TTL) {
      useful.push(id);
      recentSearchIds.delete(id); // Don't double-count
      try { store.incrementUsefulCount(id); } catch { /* non-critical */ }
    }
  }
  return useful;
}

// --- Multi-hop context expansion: follow 1-hop links from search results ---

interface LinkedExpansion {
  id: string;
  content: string;
  tags: string[];
  created_at: string;
  importance: number;
  linked_from: string;
  link_type: string;
  strength: number;
}

function expandViaLinks(resultIds: string[], maxExpansion: number = 5): LinkedExpansion[] {
  if (resultIds.length === 0) return [];
  const linkStore = new MemoryLinkStore(db);
  const store = new MemoryStore(db);
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

// --- Fact surfacing: append relevant facts to search/context results ---

function buildFactsSection(query: string): string {
  try {
    // Extract potential subjects from query words (3+ chars)
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

// --- Entity profile section: append precomputed entity profiles to context/search ---

function buildEntityProfileSection(memoryIds: string[]): string {
  if (memoryIds.length === 0) return "";
  try {
    // Find entities linked to these memories, grouped by entity, top 5 by link count
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

// memory_store
server.tool(
  "memory_store",
  "Store a new memory in Exocortex. Use this to save important information, facts, preferences, decisions, or context that should be remembered for future conversations.",
  {
    content: z.string().describe("The content to remember"),
    tags: z.array(z.string()).optional().describe("Tags for categorization"),
    importance: z.number().min(0).max(1).optional().describe("Importance 0-1 (default 0.5, use 0.8+ for critical info)"),
    valence: z.number().min(-1).max(1).optional().describe("Emotional significance (-1=failure/warning, 0=neutral, 1=breakthrough/success)"),
    content_type: z.enum(["text", "conversation", "note", "summary"]).optional().describe("Content type (default 'text')"),
    provider: z.string().optional().describe("Model provider (e.g. openai, anthropic)"),
    model_id: z.string().optional().describe("Canonical model identifier (e.g. gpt-5-codex)"),
    model_name: z.string().optional().describe("Human-readable model name (e.g. GPT-5.3-Codex)"),
    agent: z.string().optional().describe("Agent/runtime identifier (e.g. codex, claude-code)"),
    session_id: z.string().optional().describe("Optional agent session/thread identifier"),
    conversation_id: z.string().optional().describe("Optional conversation identifier"),
    metadata: z.record(z.string(), z.any()).optional().describe("Arbitrary JSON metadata (e.g. { model: 'claude-opus-4-6' })"),
    is_metadata: z.boolean().optional().describe("Explicitly mark this memory as metadata/system artifact"),
    benchmark: z.boolean().optional().describe("Store as benchmark artifact (low default importance, reduced indexing/chunking)"),
    expires_at: z.string().optional().describe("ISO timestamp when this memory should auto-expire (e.g. '2026-03-01T00:00:00Z')"),
    namespace: z.string().optional().describe("Project namespace for scoped retrieval (e.g. 'exocortex', 'moodarc')"),
  },
  async (args) => {
    try {
      // Storage gate: reject low-value short writes
      const stripped = stripPrivateContent(args.content);
      validateStorageGate(stripped, {
        content_type: args.content_type,
        is_metadata: args.is_metadata,
        benchmark: args.benchmark,
        tags: args.tags,
      });

      const store = new MemoryStore(db);

      const result = await store.create({
        content: args.content,
        content_type: args.content_type ?? "text",
        source: "mcp",
        importance: args.importance,
        valence: args.valence,
        tags: args.tags,
        provider: args.provider || DEFAULT_ATTRIBUTION.provider,
        model_id: args.model_id || DEFAULT_ATTRIBUTION.model_id,
        model_name: args.model_name || DEFAULT_ATTRIBUTION.model_name,
        agent: args.agent || DEFAULT_ATTRIBUTION.agent,
        session_id: args.session_id,
        conversation_id: args.conversation_id,
        metadata: args.metadata,
        is_metadata: args.is_metadata,
        benchmark: args.benchmark,
        expires_at: args.expires_at,
        namespace: args.namespace,
      });

      const meta: string[] = [`id: ${result.memory.id}`];
      if (args.tags?.length) meta.push(`tags: ${args.tags.join(", ")}`);
      if (args.importance !== undefined) meta.push(`importance: ${args.importance}`);
      if (result.superseded_id) {
        const pct = Math.round((result.dedup_similarity ?? 0) * 100);
        if (result.dedup_action === "skipped") {
          meta.push(`dedup reused ${result.superseded_id} — ${pct}% similar`);
        } else if (result.dedup_action === "merged") {
          meta.push(`merged into ${result.superseded_id} — ${pct}% similar`);
        } else {
          meta.push(`superseded ${result.superseded_id} — ${pct}% similar`);
        }
      }

      // Auto-detect goal progress
      if (!args.benchmark && result.dedup_action !== "skipped") {
        try {
          const goalStore = new GoalStore(db);
          const linkedGoalIds = await goalStore.autoLinkProgress(result.memory.id, args.content, result.memory.embedding);
          if (linkedGoalIds.length > 0) {
            const goal = goalStore.getById(linkedGoalIds[0]);
            if (goal) {
              meta.push(`goal: "${goal.title}"`);
            }
          }
        } catch {
          // Non-critical
        }
      }

      // Store-time relation discovery: auto-link similar existing memories
      try {
        if (!args.benchmark && result.dedup_action !== "skipped" && result.memory.embedding) {
          const linkStore = new MemoryLinkStore(db);
          const candidates = db
            .prepare(
              `SELECT id, embedding FROM memories
               WHERE id != ? AND is_active = 1 AND embedding IS NOT NULL AND parent_id IS NULL
               ORDER BY created_at DESC LIMIT 200`
            )
            .all(result.memory.id) as unknown as Array<{ id: string; embedding: Uint8Array }>;

          const linked: string[] = [];
          for (const c of candidates) {
            if (linked.length >= 5) break;
            const bytes = c.embedding as unknown as Uint8Array;
            const cEmb = new Float32Array(new Uint8Array(bytes).buffer);
            const sim = cosineSimilarity(result.memory.embedding, cEmb);
            if (sim >= 0.75) {
              linkStore.link(result.memory.id, c.id, "related", Math.round(sim * 100) / 100);
              linked.push(c.id);
            }
          }
          if (linked.length > 0) {
            meta.push(`linked: ${linked.length} related`);
          }
        }
      } catch {
        // Relation discovery is non-critical
      }

      // Temporal auto-linking: narratives and epochs link to high-importance episodes
      try {
        const tags = args.tags ?? [];
        const isNarrative = tags.includes("narrative") && tags.includes("weekly-summary");
        const isEpoch = tags.includes("epoch");

        if ((isNarrative || isEpoch) && result.dedup_action !== "skipped") {
          const linkStore = new MemoryLinkStore(db);
          const memDate = new Date(result.memory.created_at);
          const windowDays = isEpoch ? 31 : 7;
          const windowStart = new Date(memDate.getTime() - windowDays * 24 * 60 * 60 * 1000);
          const cap = isEpoch ? 30 : 15;

          // Find high-importance episodes in the time window
          const episodes = db
            .prepare(
              `SELECT id FROM memories
               WHERE is_active = 1 AND importance >= 0.5 AND is_metadata = 0
                 AND created_at >= ? AND created_at < ?
                 AND id != ?
                 AND id NOT IN (SELECT memory_id FROM memory_tags WHERE tag = 'epoch')
                 AND id NOT IN (SELECT memory_id FROM memory_tags WHERE tag = 'narrative')
               ORDER BY importance DESC
               LIMIT ?`
            )
            .all(
              windowStart.toISOString().replace("T", " ").slice(0, 19),
              result.memory.created_at,
              result.memory.id,
              cap
            ) as unknown as Array<{ id: string }>;

          let linkedCount = 0;
          for (const ep of episodes) {
            linkStore.link(result.memory.id, ep.id, "elaborates", 0.6);
            linkedCount++;
          }

          // Epochs also link to narratives in the same month
          if (isEpoch) {
            const monthStr = result.memory.created_at.slice(0, 7); // YYYY-MM
            const narratives = db
              .prepare(
                `SELECT m.id FROM memories m
                 JOIN memory_tags mt ON mt.memory_id = m.id AND mt.tag = 'narrative'
                 WHERE m.is_active = 1
                   AND strftime('%Y-%m', m.created_at) = ?
                   AND m.id != ?
                 ORDER BY m.created_at DESC`
              )
              .all(monthStr, result.memory.id) as unknown as Array<{ id: string }>;

            for (const n of narratives) {
              linkStore.link(result.memory.id, n.id, "elaborates", 0.8);
              linkedCount++;
            }
          }

          if (linkedCount > 0) {
            meta.push(`hierarchy: ${linkedCount} elaborates links`);
          }
        }
      } catch {
        // Temporal auto-linking is non-critical
      }

      return { content: [{ type: "text", text: `Stored memory (${meta.join(" | ")})` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// memory_search
server.tool(
  "memory_search",
  "Search Exocortex memories using hybrid retrieval (semantic + keyword + recency + frequency). Use this to recall stored information or find relevant context.",
  {
    query: z.string().describe("Natural language search query"),
    expanded_query: z.string().optional().describe("Semantic rephrasings of the query to bridge vocabulary gaps. Provide 2-3 alternative phrasings with different words that capture the same intent (e.g. for 'auth flow' → 'login authentication JWT session tokens'). Feeds into both vector and keyword search."),
    limit: z.number().min(1).max(50).optional().describe("Max results (default 10)"),
    tags: z.array(z.string()).optional().describe("Filter by tags"),
    after: z.string().optional().describe("Only after this date (YYYY-MM-DD)"),
    before: z.string().optional().describe("Only before this date (YYYY-MM-DD)"),
    content_type: z.enum(["text", "conversation", "note", "summary"]).optional().describe("Filter by content type"),
    min_score: z.number().min(0).optional().describe("Minimum score threshold. RRF scoring range is ~0.001-0.03; legacy range is ~0.15-0.80. Default auto-detected from scoring mode."),
    include_metadata: z.boolean().optional().describe("Include benchmark/progress/regression metadata memories (default false)"),
    compact: z.boolean().optional().describe("Return compact results (ID + preview + score) to save tokens. Use memory_get to fetch full content."),
    max_tokens: z.number().min(100).max(100000).optional().describe("Token budget — pack results by relevance until budget exhausted. Overrides limit."),
    namespace: z.string().optional().describe("Filter by project namespace"),
  },
  async (args) => {
    try {
      const search = new MemorySearch(db);
      const store = new MemoryStore(db);

      const fetchLimit = args.max_tokens ? 50 : (args.limit ?? 10);

      const results = await search.search({
        query: args.query,
        expanded_query: args.expanded_query,
        limit: fetchLimit,
        tags: args.tags,
        after: args.after,
        before: args.before,
        content_type: args.content_type,
        min_score: args.min_score,
        include_metadata: args.include_metadata,
        namespace: args.namespace,
      });

      if (results.length === 0) {
        return { content: [{ type: "text", text: "No memories found matching the query." }] };
      }

      // Track result IDs for implicit usefulness signaling
      recordSearchResults(results.map((r) => r.memory.id));

      const scoringMode = getRRFConfig(db).enabled ? "rrf" : "legacy";

      if (args.compact) {
        const formatCompact = (r: typeof results[number]) => {
          const m = r.memory;
          const preview = smartPreview(m.content, args.query);
          const tagStr = m.tags?.length ? ` | tags: ${m.tags.join(", ")}` : "";
          return `[${m.id}] ${preview} (score: ${r.score.toFixed(3)}${tagStr})`;
        };

        if (args.max_tokens) {
          const { formatted, totalTokens } = packByTokenBudget(results, args.max_tokens, formatCompact);
          return {
            content: [{ type: "text", text: `Found ${formatted.length} memories (~${totalTokens} tokens, compact, ${scoringMode}):\n\n${formatted.join("\n")}` }],
          };
        }

        const lines = results.map(formatCompact);
        return {
          content: [{ type: "text", text: `Found ${results.length} memories (compact, ${scoringMode}):\n\n${lines.join("\n")}` }],
        };
      }

      const formatFull = (r: typeof results[number]) => {
        const m = r.memory;
        const meta: string[] = [];
        if (m.tags?.length) meta.push(`tags: ${m.tags.join(", ")}`);
        meta.push(`score: ${r.score.toFixed(3)}`);
        meta.push(`created: ${m.created_at}`);
        if (m.importance !== 0.5) meta.push(`importance: ${m.importance}`);
        if (m.valence !== 0) meta.push(`valence: ${m.valence}`);
        return `[${m.id}] ${m.content}\n  (${meta.join(" | ")})`;
      };

      if (args.max_tokens) {
        const { packed, formatted, totalTokens } = packByTokenBudget(results, args.max_tokens, formatFull);
        for (const r of packed) {
          await store.recordAccess(r.memory.id, args.query);
        }
        return {
          content: [{ type: "text", text: `Found ${formatted.length} memories (~${totalTokens} tokens, ${scoringMode}):\n\n${formatted.join("\n\n")}` }],
        };
      }

      for (const r of results) {
        await store.recordAccess(r.memory.id, args.query);
      }

      const lines = results.map(formatFull);

      // Multi-hop: append linked memories not already in results
      const resultIds = results.map((r) => r.memory.id);
      const linked = expandViaLinks(resultIds, 3);
      let linkSection = "";
      if (linked.length > 0) {
        recordSearchResults(linked.map((l) => l.id));
        const linkLines = linked.map((l) => {
          const tagStr = l.tags.length ? ` | tags: ${l.tags.join(", ")}` : "";
          return `[${l.id}] ${l.content.substring(0, 200)}${l.content.length > 200 ? "..." : ""}\n  (via ${l.link_type} link, strength: ${l.strength}${tagStr})`;
        });
        linkSection = `\n\n--- Linked (1-hop) ---\n\n${linkLines.join("\n\n")}`;
      }

      const entityProfileSection = buildEntityProfileSection(resultIds);
      const factsSection = buildFactsSection(args.query);

      return {
        content: [{ type: "text", text: `Found ${results.length} memories (${scoringMode}):\n\n${lines.join("\n\n")}${linkSection}${entityProfileSection}${factsSection}` }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// memory_forget
server.tool(
  "memory_forget",
  "Delete a memory from Exocortex by ID. Use when information is outdated or incorrect.",
  {
    id: z.string().describe("The memory ID to delete (ULID)"),
  },
  async (args) => {
    try {
      const store = new MemoryStore(db);

      const existing = await store.getById(args.id);
      if (!existing) {
        return { content: [{ type: "text", text: `Memory ${args.id} not found.` }] };
      }

      await store.delete(args.id);
      const preview = existing.content.substring(0, 80) + (existing.content.length > 80 ? "..." : "");
      return { content: [{ type: "text", text: `Deleted memory ${args.id}: "${preview}"` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// memory_context
server.tool(
  "memory_context",
  "Load contextual memories for a topic. Use at the start of a conversation to get relevant background about a subject, project, or person.",
  {
    topic: z.string().describe("Topic to load context for"),
    limit: z.number().min(1).max(30).optional().describe("Max memories (default 15)"),
    compact: z.boolean().optional().describe("Return compact results (ID + preview + score) to save tokens. Use memory_get to fetch full content."),
    max_tokens: z.number().min(100).max(100000).optional().describe("Token budget — pack results by relevance until budget exhausted. Overrides limit."),
    namespace: z.string().optional().describe("Filter by project namespace"),
  },
  async (args) => {
    try {
      const search = new MemorySearch(db);
      const store = new MemoryStore(db);

      const fetchLimit = args.max_tokens ? 50 : (args.limit ?? 15);

      const results = await search.search({
        query: args.topic,
        limit: fetchLimit,
        namespace: args.namespace,
      });

      if (results.length === 0) {
        return { content: [{ type: "text", text: `No context found for "${args.topic}".` }] };
      }

      // Track result IDs for implicit usefulness signaling
      recordSearchResults(results.map((r) => r.memory.id));

      if (args.compact) {
        const formatCompact = (r: typeof results[number]) => {
          const m = r.memory;
          const preview = smartPreview(m.content, args.topic);
          const tagStr = m.tags?.length ? ` [${m.tags.join(", ")}]` : "";
          return `- [${m.id}] ${preview}${tagStr} (${m.created_at})`;
        };

        if (args.max_tokens) {
          const { formatted, totalTokens } = packByTokenBudget(results, args.max_tokens, formatCompact);
          return {
            content: [{ type: "text", text: `Context for "${args.topic}" (~${totalTokens} tokens, ${formatted.length} memories, compact):\n\n${formatted.join("\n")}` }],
          };
        }

        const lines = results.map(formatCompact);
        return {
          content: [{ type: "text", text: `Context for "${args.topic}" (${results.length} memories, compact):\n\n${lines.join("\n")}` }],
        };
      }

      const formatFull = (r: typeof results[number]) => {
        const m = r.memory;
        const tagStr = m.tags?.length ? ` [${m.tags.join(", ")}]` : "";
        return `- ${m.content}${tagStr} (${m.created_at})`;
      };

      if (args.max_tokens) {
        const { packed, formatted, totalTokens } = packByTokenBudget(results, args.max_tokens, formatFull);
        for (const r of packed) {
          await store.recordAccess(r.memory.id, `context:${args.topic}`);
        }
        return {
          content: [{ type: "text", text: `Context for "${args.topic}" (~${totalTokens} tokens, ${formatted.length} memories):\n\n${formatted.join("\n")}` }],
        };
      }

      for (const r of results) {
        await store.recordAccess(r.memory.id, `context:${args.topic}`);
      }

      const lines = results.map(formatFull);

      // Multi-hop: append linked memories not already in results
      const resultIds = results.map((r) => r.memory.id);
      const linked = expandViaLinks(resultIds, 3);
      let linkSection = "";
      if (linked.length > 0) {
        recordSearchResults(linked.map((l) => l.id));
        const linkLines = linked.map((l) => {
          const tagStr = l.tags.length ? ` [${l.tags.join(", ")}]` : "";
          return `- ${l.content.substring(0, 200)}${l.content.length > 200 ? "..." : ""}${tagStr} (via ${l.link_type})`;
        });
        linkSection = `\n\n--- Linked ---\n${linkLines.join("\n")}`;
      }

      const entityProfileSection = buildEntityProfileSection(resultIds);
      const factsSection = buildFactsSection(args.topic);

      return {
        content: [{ type: "text", text: `Context for "${args.topic}" (${results.length} memories):\n\n${lines.join("\n")}${linkSection}${entityProfileSection}${factsSection}` }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// memory_get
server.tool(
  "memory_get",
  "Fetch full content for specific memory IDs. Use after compact search to retrieve details for relevant results.",
  {
    ids: z.array(z.string()).min(1).max(10).describe("Memory IDs to fetch (max 10)"),
  },
  async (args) => {
    try {
      const store = new MemoryStore(db);
      const results: string[] = [];

      // Implicit usefulness signal: if these IDs were in recent search results, mark useful
      checkAndSignalUsefulness(args.ids);

      for (const id of args.ids) {
        const memory = await store.getById(id);
        if (!memory) {
          results.push(`[${id}] Not found`);
          continue;
        }

        await store.recordAccess(id);

        const meta: string[] = [];
        meta.push(`source: ${memory.source}`);
        if (memory.source_uri) meta.push(`source_uri: ${memory.source_uri}`);
        if (memory.provider) meta.push(`provider: ${memory.provider}`);
        if (memory.model_id) meta.push(`model_id: ${memory.model_id}`);
        if (memory.model_name) meta.push(`model_name: ${memory.model_name}`);
        if (memory.agent) meta.push(`agent: ${memory.agent}`);
        if (memory.session_id) meta.push(`session_id: ${memory.session_id}`);
        if (memory.conversation_id) meta.push(`conversation_id: ${memory.conversation_id}`);
        if (memory.tags?.length) meta.push(`tags: ${memory.tags.join(", ")}`);
        if (memory.metadata && Object.keys(memory.metadata).length > 0) {
          meta.push(`metadata: ${JSON.stringify(memory.metadata)}`);
        }
        meta.push(`created: ${memory.created_at}`);
        if (memory.importance !== 0.5) meta.push(`importance: ${memory.importance}`);
        if (memory.valence !== 0) meta.push(`valence: ${memory.valence}`);
        results.push(`[${memory.id}] ${memory.content}\n  (${meta.join(" | ")})`);
      }

      return { content: [{ type: "text", text: results.join("\n\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// memory_feedback — explicit usefulness signal
server.tool(
  "memory_feedback",
  "Mark memories as useful after retrieval. Call this after using search results to improve future ranking. Also triggered implicitly when memory_get is called on recent search results.",
  {
    ids: z.array(z.string()).min(1).max(20).describe("Memory IDs that were useful"),
  },
  async (args) => {
    try {
      const store = new MemoryStore(db);
      let count = 0;
      for (const id of args.ids) {
        try {
          store.incrementUsefulCount(id);
          count++;
        } catch { /* skip invalid IDs */ }
      }

      // Link feedback to query outcomes: find recent access_log entries for these IDs
      try {
        const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000)
          .toISOString()
          .replace("T", " ")
          .replace("Z", "");
        const placeholders = args.ids.map(() => "?").join(", ");
        const accessRows = db
          .prepare(
            `SELECT DISTINCT query FROM access_log
             WHERE memory_id IN (${placeholders})
               AND query IS NOT NULL
               AND accessed_at >= ?
             ORDER BY accessed_at DESC LIMIT 5`
          )
          .all(...args.ids, fiveMinAgo) as Array<{ query: string }>;

        const { createHash } = await import("node:crypto");
        for (const row of accessRows) {
          const hash = createHash("sha256")
            .update(row.query.toLowerCase().trim())
            .digest("hex")
            .slice(0, 16);
          db.prepare(
            "UPDATE query_outcomes SET feedback_count = feedback_count + 1 WHERE query_hash = ?"
          ).run(hash);
        }
      } catch {
        // Non-critical
      }

      return { content: [{ type: "text", text: `Recorded usefulness signal for ${count} memories.` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// memory_facts — query structured facts (SPO triples)
server.tool(
  "memory_facts",
  "Query structured facts extracted from memories. Facts are subject-predicate-object triples (e.g. 'Exocortex port 4010'). Use for precise lookups of ports, versions, paths, dependencies.",
  {
    subject: z.string().optional().describe("Filter by subject (LIKE match)"),
    predicate: z.string().optional().describe("Filter by predicate (exact: port, uses, replaced, path, default, version, is)"),
    object: z.string().optional().describe("Filter by object (LIKE match)"),
    memory_id: z.string().optional().describe("Filter by source memory ID"),
    limit: z.number().min(1).max(100).optional().describe("Max results (default 20)"),
  },
  async (args) => {
    try {
      const facts = searchFacts(db, {
        subject: args.subject,
        predicate: args.predicate,
        object: args.object,
        memory_id: args.memory_id,
        limit: args.limit,
      });

      if (facts.length === 0) {
        return { content: [{ type: "text", text: "No facts found matching the query." }] };
      }

      const lines = facts.map((f) =>
        `(${f.subject}) --[${f.predicate}]--> (${f.object})  [confidence: ${f.confidence}, memory: ${f.memory_id}]`
      );

      return {
        content: [{ type: "text", text: `Found ${facts.length} facts:\n\n${lines.join("\n")}` }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// memory_entities
server.tool(
  "memory_entities",
  "List entities (people, projects, technologies, etc.) tracked in Exocortex with linked memory counts.",
  {
    type: z.enum(["person", "project", "technology", "organization", "concept"]).optional().describe("Filter by entity type (deprecated — prefer tags)"),
    tags: z.array(z.string()).optional().describe("Filter entities by tags"),
    query: z.string().optional().describe("Search entity names"),
  },
  async (args) => {
    try {
      let sql = `
        SELECT e.id, e.name, e.type, e.aliases,
               COUNT(DISTINCT me.memory_id) as memory_count
        FROM entities e
        LEFT JOIN memory_entities me ON e.id = me.entity_id
      `;
      const joins: string[] = [];
      const conditions: string[] = [];
      const params: string[] = [];

      if (args.tags && args.tags.length > 0) {
        joins.push("INNER JOIN entity_tags et ON e.id = et.entity_id");
        conditions.push(`et.tag IN (${args.tags.map(() => "?").join(", ")})`);
        params.push(...args.tags);
      }
      if (args.type) {
        conditions.push("e.type = ?");
        params.push(args.type);
      }
      if (args.query) {
        conditions.push("(e.name LIKE ? OR e.aliases LIKE ?)");
        params.push(`%${args.query}%`, `%${args.query}%`);
      }
      if (joins.length > 0) {
        sql += ` ${joins.join(" ")}`;
      }
      if (conditions.length > 0) {
        sql += ` WHERE ${conditions.join(" AND ")}`;
      }
      sql += " GROUP BY e.id HAVING COUNT(me.memory_id) > 0 ORDER BY memory_count DESC, e.name ASC LIMIT 50";

      const rows = db.prepare(sql).all(...params) as unknown as Array<{
        id: string;
        name: string;
        type: string;
        aliases: string;
        memory_count: number;
      }>;

      if (rows.length === 0) {
        const msg = args.tags
          ? `No entities with tags [${args.tags.join(", ")}] found.`
          : args.type
            ? `No entities of type "${args.type}" found.`
            : "No entities found yet.";
        return { content: [{ type: "text", text: msg }] };
      }

      const entityStore = new EntityStore(db);
      const tagStmt = db.prepare("SELECT tag FROM entity_tags WHERE entity_id = ?");

      const lines = rows.map((r) => {
        let aliases: string[] = [];
        try { aliases = JSON.parse(r.aliases); } catch {}
        const aliasStr = aliases.length > 0 ? ` (aka: ${aliases.join(", ")})` : "";
        const entityTags = (tagStmt.all(r.id) as Array<{ tag: string }>).map((t) => t.tag);
        const tagsStr = entityTags.length > 0 ? ` [${entityTags.join(", ")}]` : "";
        let line = `- ${r.name}${aliasStr}${tagsStr} — ${r.memory_count} memories`;

        // Include relationships
        const related = entityStore.getRelatedEntities(r.id);
        if (related.length > 0) {
          const relStrs = related.slice(0, 5).map((rel) => {
            const ctxStr = rel.context ? ` (${rel.context})` : "";
            if (rel.direction === "outgoing") {
              return `${rel.relationship} → ${rel.entity.name}${ctxStr}`;
            }
            return `${rel.relationship} ← ${rel.entity.name}${ctxStr}`;
          });
          line += `\n    Relationships: ${relStrs.join(", ")}`;
          if (related.length > 5) {
            line += ` (+${related.length - 5} more)`;
          }
        }

        return line;
      });

      return {
        content: [{ type: "text", text: `Entities (${rows.length}):\n\n${lines.join("\n")}` }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// memory_graph
server.tool(
  "memory_graph",
  "Analyze the entity relationship graph. Compute centrality metrics to find bridge entities that connect different knowledge domains.",
  {
    action: z.enum(["stats", "centrality", "bridges", "communities"]).describe("Analysis type: 'stats' for overview, 'centrality' for top entities by betweenness, 'bridges' for bridge entities, 'communities' for dense subgraphs"),
    limit: z.number().min(1).max(50).optional().describe("Max results for centrality/bridges (default 10)"),
  },
  async (args) => {
    try {
      const limit = args.limit ?? 10;

      if (args.action === "stats") {
        const stats = computeGraphStats(db);
        const lines = [
          `Nodes: ${stats.nodeCount}`,
          `Edges: ${stats.edgeCount}`,
          `Components: ${stats.components}`,
          `Avg degree: ${stats.avgDegree}`,
        ];
        return { content: [{ type: "text", text: `Graph stats:\n${lines.join("\n")}` }] };
      }

      if (args.action === "centrality") {
        const centrality = computeCentrality(db);
        if (centrality.length === 0) {
          return { content: [{ type: "text", text: "No entities found in the graph." }] };
        }
        const top = centrality.slice(0, limit);
        const lines = top.map((c, i) =>
          `${i + 1}. ${c.entityName} — degree: ${c.degree}, betweenness: ${c.betweenness.toFixed(4)}, memories: ${c.memoryCount}`
        );
        return { content: [{ type: "text", text: `Top ${top.length} entities by centrality:\n\n${lines.join("\n")}` }] };
      }

      if (args.action === "communities") {
        const communities = detectCommunities(db);
        if (communities.length === 0) {
          return { content: [{ type: "text", text: "No communities detected (need at least 2 connected entities)." }] };
        }
        const top = communities.slice(0, limit);
        const lines = top.map((c) => {
          const members = c.members.map((m) => m.entityName).join(", ");
          return `${c.id + 1}. [${c.size} members, ${c.internalEdges} edges] ${members}`;
        });
        return { content: [{ type: "text", text: `Detected ${communities.length} communities:\n\n${lines.join("\n")}` }] };
      }

      // bridges
      const bridges = getTopBridgeEntities(db, limit);
      if (bridges.length === 0) {
        return { content: [{ type: "text", text: "No bridge entities found." }] };
      }

      const entityStore = new EntityStore(db);
      const lines = bridges.map((b, i) => {
        const related = entityStore.getRelatedEntities(b.entityId);
        const domains = related.slice(0, 5).map((r) => {
          const ctxStr = r.context ? ` (${r.context})` : "";
          return r.direction === "outgoing" ? `${r.relationship} → ${r.entity.name}${ctxStr}` : `${r.relationship} ← ${r.entity.name}${ctxStr}`;
        });
        const domainStr = domains.length > 0 ? `\n    Connected: ${domains.join(", ")}` : "";
        return `${i + 1}. ${b.entityName} — betweenness: ${b.betweenness.toFixed(4)}, degree: ${b.degree}, memories: ${b.memoryCount}${domainStr}`;
      });
      return { content: [{ type: "text", text: `Top ${bridges.length} bridge entities:\n\n${lines.join("\n")}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// memory_update
server.tool(
  "memory_update",
  "Update an existing memory's content, tags, importance, or content type. Use when information needs correction or enrichment.",
  {
    id: z.string().describe("The memory ID to update (ULID)"),
    content: z.string().optional().describe("New content (will re-embed)"),
    content_type: z.enum(["text", "conversation", "note", "summary"]).optional().describe("New content type"),
    source_uri: z.string().nullable().optional().describe("Set/clear source URI"),
    provider: z.string().nullable().optional().describe("Set/clear model provider"),
    model_id: z.string().nullable().optional().describe("Set/clear canonical model identifier"),
    model_name: z.string().nullable().optional().describe("Set/clear human-readable model name"),
    agent: z.string().nullable().optional().describe("Set/clear agent/runtime identifier"),
    session_id: z.string().nullable().optional().describe("Set/clear session identifier"),
    conversation_id: z.string().nullable().optional().describe("Set/clear conversation identifier"),
    importance: z.number().min(0).max(1).optional().describe("New importance score"),
    valence: z.number().min(-1).max(1).optional().describe("New valence score (-1 to 1)"),
    is_metadata: z.boolean().optional().describe("Explicitly set metadata/system classification"),
    tags: z.array(z.string()).optional().describe("Replace all tags with these"),
    metadata: z.record(z.string(), z.any()).optional().describe("Merge metadata keys (set value to null to delete a key)"),
    expires_at: z.string().nullable().optional().describe("Set/clear expiry timestamp (ISO format)"),
    namespace: z.string().nullable().optional().describe("Set/clear project namespace"),
  },
  async (args) => {
    try {
      const { id, ...updates } = args;

      if (
        !updates.content &&
        !updates.content_type &&
        updates.source_uri === undefined &&
        updates.provider === undefined &&
        updates.model_id === undefined &&
        updates.model_name === undefined &&
        updates.agent === undefined &&
        updates.session_id === undefined &&
        updates.conversation_id === undefined &&
        updates.importance === undefined &&
        updates.valence === undefined &&
        updates.is_metadata === undefined &&
        updates.expires_at === undefined &&
        updates.namespace === undefined &&
        !updates.tags &&
        !updates.metadata
      ) {
        return {
          content: [{
            type: "text",
            text: "No update fields provided. Specify at least one of: content, content_type, source_uri, provider, model_id, model_name, agent, session_id, conversation_id, importance, valence, is_metadata, expires_at, namespace, tags, metadata.",
          }],
        };
      }

      const store = new MemoryStore(db);
      const updated = await store.update(id, updates);

      if (!updated) {
        return { content: [{ type: "text", text: `Memory ${id} not found.` }] };
      }

      const preview = updated.content.substring(0, 80) + (updated.content.length > 80 ? "..." : "");
      const meta: string[] = [];
      if (updated.tags?.length) meta.push(`tags: ${updated.tags.join(", ")}`);
      meta.push(`importance: ${updated.importance}`);
      return { content: [{ type: "text", text: `Updated memory ${id}: "${preview}" (${meta.join(" | ")})` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// memory_browse
server.tool(
  "memory_browse",
  "Browse memories without semantic search. Filter by tags, content type, or date range. Returns most recent first.",
  {
    tags: z.array(z.string()).optional().describe("Filter by tags (any match)"),
    content_type: z.enum(["text", "conversation", "note", "summary"]).optional().describe("Filter by content type"),
    after: z.string().optional().describe("Only after this date (YYYY-MM-DD)"),
    before: z.string().optional().describe("Only before this date (YYYY-MM-DD)"),
    limit: z.number().min(1).max(50).optional().describe("Max results (default 20)"),
    compact: z.boolean().optional().describe("Return compact results (ID + preview) to save tokens"),
    namespace: z.string().optional().describe("Filter by project namespace"),
  },
  async (args) => {
    try {
      const limit = args.limit ?? 20;
      const conditions: string[] = ["m.is_active = 1", "m.parent_id IS NULL"];
      const params: (string | number)[] = [];

      if (args.namespace) {
        conditions.push("m.namespace = ?");
        params.push(args.namespace);
      }

      let tagJoin = "";
      if (args.tags && args.tags.length > 0) {
        const placeholders = args.tags.map(() => "?").join(", ");
        tagJoin = ` INNER JOIN memory_tags mt ON m.id = mt.memory_id AND mt.tag IN (${placeholders})`;
        params.push(...args.tags.map((t) => t.toLowerCase().trim()));
      }

      if (args.content_type) {
        conditions.push("m.content_type = ?");
        params.push(args.content_type);
      }
      if (args.after) {
        conditions.push("m.created_at >= ?");
        params.push(args.after);
      }
      if (args.before) {
        conditions.push("m.created_at <= ?");
        params.push(args.before);
      }

      const sql = `
        SELECT DISTINCT m.id, m.content, m.content_type, m.importance, m.created_at
        FROM memories m${tagJoin}
        WHERE ${conditions.join(" AND ")}
        ORDER BY m.created_at DESC
        LIMIT ?
      `;
      params.push(limit);

      const rows = db.prepare(sql).all(...params) as unknown as Array<{
        id: string;
        content: string;
        content_type: string;
        importance: number;
        created_at: string;
      }>;

      if (rows.length === 0) {
        return { content: [{ type: "text", text: "No memories found matching the filters." }] };
      }

      // Batch-fetch tags for all results
      const ids = rows.map((r) => r.id);
      const tagPlaceholders = ids.map(() => "?").join(", ");
      const tagRows = db
        .prepare(`SELECT memory_id, tag FROM memory_tags WHERE memory_id IN (${tagPlaceholders})`)
        .all(...ids) as unknown as Array<{ memory_id: string; tag: string }>;

      const tagMap = new Map<string, string[]>();
      for (const tr of tagRows) {
        const existing = tagMap.get(tr.memory_id) ?? [];
        existing.push(tr.tag);
        tagMap.set(tr.memory_id, existing);
      }

      if (args.compact) {
        const lines = rows.map((r) => {
          const preview = r.content.substring(0, 200) + (r.content.length > 200 ? "..." : "");
          const tags = tagMap.get(r.id);
          const tagStr = tags?.length ? ` [${tags.join(", ")}]` : "";
          return `[${r.id}] ${preview}${tagStr}`;
        });
        return {
          content: [{ type: "text", text: `Browsing ${rows.length} memories (compact):\n\n${lines.join("\n")}` }],
        };
      }

      const lines = rows.map((r) => {
        const tags = tagMap.get(r.id);
        const meta: string[] = [];
        if (tags?.length) meta.push(`tags: ${tags.join(", ")}`);
        meta.push(`type: ${r.content_type}`);
        meta.push(`created: ${r.created_at}`);
        if (r.importance !== 0.5) meta.push(`importance: ${r.importance}`);
        if ((r as any).valence !== 0) meta.push(`valence: ${(r as any).valence}`);
        return `[${r.id}] ${r.content}\n  (${meta.join(" | ")})`;
      });

      return {
        content: [{ type: "text", text: `Browsing ${rows.length} memories:\n\n${lines.join("\n\n")}` }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// memory_decay_preview
server.tool(
  "memory_decay_preview",
  "Preview which memories would be archived by the decay process. Dry-run only, no changes made.",
  {},
  async () => {
    try {
      const candidates = getArchiveCandidates(db);

      if (candidates.length === 0) {
        return { content: [{ type: "text", text: "No archive candidates found. All memories are healthy." }] };
      }

      const lines = candidates.map((c) => {
        const preview = c.content.substring(0, 80) + (c.content.length > 80 ? "..." : "");
        return `- [${c.id}] ${preview} (reason: ${c.reason}, importance: ${c.importance}, accesses: ${c.access_count}, created: ${c.created_at})`;
      });

      return {
        content: [{ type: "text", text: `Archive candidates (${candidates.length}, dry-run):\n\n${lines.join("\n")}` }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// memory_consolidate
server.tool(
  "memory_consolidate",
  "Find clusters of similar memories and consolidate them into summaries. Reduces redundancy.",
  {
    dry_run: z.boolean().optional().describe("Preview clusters without consolidating (default true — safe preview mode)"),
    min_similarity: z.number().min(0).max(1).optional().describe("Minimum cosine similarity for clustering (default 0.75)"),
    min_cluster_size: z.number().min(2).optional().describe("Minimum cluster size (default 3)"),
    time_bucket: z.enum(["week", "month"]).optional().describe("Constrain clustering to same time window (week or month)"),
  },
  async (args) => {
    try {
      const clusters = findClusters(db, {
        minSimilarity: args.min_similarity,
        minClusterSize: args.min_cluster_size,
        timeBucket: args.time_bucket,
      });

      if (clusters.length === 0) {
        return { content: [{ type: "text", text: "No clusters found eligible for consolidation." }] };
      }

      if (args.dry_run !== false) {
        // Default to dry_run unless explicitly set to false
        const lines = clusters.map((c, i) => {
          return `${i + 1}. "${c.topic}" — ${c.memberIds.length} memories, avg similarity: ${c.avgSimilarity.toFixed(2)}`;
        });
        return {
          content: [{
            type: "text",
            text: `Found ${clusters.length} clusters (dry run):\n\n${lines.join("\n")}\n\nRun with dry_run: false to consolidate.`,
          }],
        };
      }

      // Actually consolidate (basic summary — LLM synthesis handled externally)
      let embeddingProvider;
      try {
        embeddingProvider = await getEmbeddingProvider();
      } catch {
        // Proceed without embedding
      }

      const results: string[] = [];
      for (const cluster of clusters) {
        const summary = generateBasicSummary(db, cluster.memberIds);
        const summaryId = await consolidateCluster(db, cluster, summary, embeddingProvider);
        results.push(`Consolidated ${cluster.memberIds.length} memories → ${summaryId} ("${cluster.topic}")`);
      }

      return {
        content: [{
          type: "text",
          text: `Consolidated ${clusters.length} clusters:\n\n${results.join("\n")}`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// memory_maintenance
server.tool(
  "memory_maintenance",
  "Run maintenance: adjust importance scores based on access patterns and archive stale memories.",
  {
    reembed: z.boolean().optional().describe("Re-embed memories with missing embeddings"),
    backfill_entities: z.boolean().optional().describe("Process memories without entity links and extract relationships"),
    recalibrate: z.boolean().optional().describe("Normalize importance distribution via percentile-rank mapping"),
    densify_graph: z.boolean().optional().describe("Create co_occurs relationships between entities sharing memories"),
    build_co_retrieval_links: z.boolean().optional().describe("Build memory links from co-retrieval patterns"),
    tune_weights: z.boolean().optional().describe("Auto-adjust scoring weights based on usefulness feedback data"),
    reembed_all: z.boolean().optional().describe("Re-embed ALL memories (model migration). Use with limit to test first."),
    reembed_all_limit: z.number().optional().describe("Max memories to re-embed when using reembed_all (default 100)"),
    recompute_profiles: z.boolean().optional().describe("Recompute entity profiles for entities with ≥3 active memories"),
    recompute_quality: z.boolean().optional().describe("Recompute quality_score for all active memories"),
    auto_consolidate: z.boolean().optional().describe("Run auto-consolidation to merge similar memory clusters"),
  },
  async (args) => {
    try {
      const importanceResult = adjustImportance(db);
      const archiveResult = archiveStaleMemories(db);

      const parts: string[] = [];

      parts.push(`Importance adjustments: ${importanceResult.boosted} boosted, ${importanceResult.decayed} decayed`);
      if (importanceResult.details.length > 0) {
        const details = importanceResult.details.slice(0, 10).map(
          (d) => `  ${d.id}: ${d.action} ${d.old_importance} → ${d.new_importance}`
        );
        parts.push(details.join("\n"));
        if (importanceResult.details.length > 10) {
          parts.push(`  ... and ${importanceResult.details.length - 10} more`);
        }
      }

      parts.push(`\nArchival: ${archiveResult.archived} memories archived`);
      if (archiveResult.candidates.length > 0) {
        const details = archiveResult.candidates.slice(0, 10).map((c) => {
          const preview = c.content.substring(0, 60) + (c.content.length > 60 ? "..." : "");
          return `  ${c.id}: "${preview}" (${c.reason})`;
        });
        parts.push(details.join("\n"));
        if (archiveResult.candidates.length > 10) {
          parts.push(`  ... and ${archiveResult.candidates.length - 10} more`);
        }
      }

      // Check for consolidation candidates
      try {
        const clusters = findClusters(db);
        if (clusters.length > 0) {
          parts.push(`\nConsolidation: Found ${clusters.length} cluster(s) eligible for consolidation (run memory_consolidate to merge)`);
        }
      } catch {
        // Non-critical
      }

      // Health diagnostics with corrective suggestions
      try {
        const health = runHealthChecks(db);
        const issues = health.checks.filter((c) => c.status !== "ok");
        if (issues.length > 0) {
          parts.push(`\nHealth: ${health.overall.toUpperCase()} (${issues.length} issue(s))`);
          const suggestions: Record<string, string> = {
            "Embedding gap": "Re-store or update memories to trigger embedding generation",
            "Tag sparsity": "Add tags to memories using memory_update, or enable auto_tagging",
            "Entity orphans": "Clean up unused entities or link them to memories",
            "Retrieval desert": "Use memory_search more actively to surface stored knowledge",
            "Importance collapse": "Manually boost key memories with memory_update importance:0.7+",
            "Consolidation backlog": "Run memory_consolidate dry_run:false to merge similar memories",
            "Growth stall": "Store new memories — the system works best with regular input",
            "Stale access": "Query your memories more often to keep the system active",
          };
          for (const check of issues) {
            const icon = check.status === "warn" ? "[!]" : "[!!]";
            parts.push(`  ${icon} ${check.name}: ${check.message}`);
            const suggestion = suggestions[check.name];
            if (suggestion) {
              parts.push(`      → ${suggestion}`);
            }
          }
        } else {
          parts.push(`\nHealth: OK — all checks passed`);
        }
      } catch {
        // Non-critical
      }

      // Quality distribution summary
      try {
        const qd = getQualityDistribution(db);
        parts.push(`\nQuality distribution (${qd.total} memories): avg=${qd.avg}, median=${qd.median}, P10=${qd.p10}, P90=${qd.p90}, high(≥0.5)=${qd.highQuality}, low(<0.2)=${qd.lowQuality}`);
      } catch {
        // Non-critical
      }

      // Search friction signals
      try {
        const misses = getSearchMisses(db, 10, 7);
        if (misses.length > 0) {
          parts.push(`\nSearch friction (last 7 days):`);
          for (const m of misses) {
            const scoreStr = m.avg_max_score !== null ? `, avg max score: ${m.avg_max_score.toFixed(3)}` : "";
            parts.push(`  "${m.query}" — ${m.count} miss(es)${scoreStr}, last: ${m.last_seen}`);
          }
        }
      } catch {
        // Non-critical
      }

      // Re-embed missing embeddings
      if (args.reembed) {
        try {
          const provider = await getEmbeddingProvider();
          const reembedResult = await reembedMissing(db, provider);
          parts.push(`\nRe-embedding: ${reembedResult.processed} processed, ${reembedResult.failed} failed`);
        } catch (err) {
          parts.push(`\nRe-embedding: error — ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Backfill entity links
      if (args.backfill_entities) {
        try {
          const backfillResult = backfillEntities(db);
          parts.push(`\nEntity backfill: ${backfillResult.memoriesProcessed} memories processed, ${backfillResult.entitiesCreated} entities created, ${backfillResult.entitiesLinked} links, ${backfillResult.relationshipsCreated} relationships`);
        } catch (err) {
          parts.push(`\nEntity backfill: error — ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Recalibrate importance distribution
      if (args.recalibrate) {
        try {
          const recalResult = recalibrateImportance(db);
          parts.push(`\nRecalibration: ${recalResult.adjusted} adjusted, mean ${recalResult.oldMean} → ${recalResult.newMean}, stddev ${recalResult.oldStdDev} → ${recalResult.newStdDev}`);
          parts.push(`  Distribution: min=${recalResult.distribution.min}, p25=${recalResult.distribution.p25}, median=${recalResult.distribution.median}, p75=${recalResult.distribution.p75}, max=${recalResult.distribution.max}`);
        } catch (err) {
          parts.push(`\nRecalibration: error — ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Graph densification
      if (args.densify_graph) {
        try {
          const densifyResult = densifyEntityGraph(db);
          parts.push(`\nGraph densification: ${densifyResult.pairsAnalyzed} pairs analyzed, ${densifyResult.relationshipsCreated} relationships created`);
        } catch (err) {
          parts.push(`\nGraph densification: error — ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Co-retrieval link building
      if (args.build_co_retrieval_links) {
        try {
          const coRetResult = buildCoRetrievalLinks(db);
          parts.push(`\nCo-retrieval links: ${coRetResult.pairsAnalyzed} pairs analyzed, ${coRetResult.linksCreated} created, ${coRetResult.linksStrengthened} strengthened`);
        } catch (err) {
          parts.push(`\nCo-retrieval links: error — ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Adaptive weight tuning
      if (args.tune_weights) {
        try {
          const tuneResult = tuneWeights(db);
          if (tuneResult.adjusted) {
            const adj = Object.entries(tuneResult.adjustments)
              .map(([k, v]) => `${k}: ${v.old} → ${v.new}`)
              .join(", ");
            parts.push(`\nWeight tuning: adjusted (${tuneResult.usefulCount} useful, ${tuneResult.notUsefulCount} not useful)\n  ${adj}`);
          } else {
            parts.push(`\nWeight tuning: ${tuneResult.reason}`);
          }
        } catch (err) {
          parts.push(`\nWeight tuning: error — ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Re-embed ALL memories (model migration)
      if (args.reembed_all) {
        try {
          const provider = await getEmbeddingProvider();
          const modelName = getSetting(db, "embedding.model") ?? "unknown";
          const reembedAllResult = await reembedAll(db, provider, {
            limit: args.reembed_all_limit ?? 100,
            modelName,
          });
          parts.push(`\nRe-embed all: ${reembedAllResult.processed} processed, ${reembedAllResult.failed} failed, ${reembedAllResult.total} total`);
        } catch (err) {
          parts.push(`\nRe-embed all: error — ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Recompute entity profiles
      if (args.recompute_profiles) {
        try {
          const profileResult = recomputeEntityProfiles(db);
          parts.push(`\nEntity profiles: ${profileResult.computed} computed, ${profileResult.skipped} skipped${profileResult.errors > 0 ? `, ${profileResult.errors} errors` : ""}`);
        } catch (err) {
          parts.push(`\nEntity profiles: error — ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Recompute quality scores
      if (args.recompute_quality !== false) {
        try {
          const qualityResult = recomputeQualityScores(db);
          parts.push(`\nQuality scores: ${qualityResult.updated} updated out of ${qualityResult.total} active memories`);
        } catch (err) {
          parts.push(`\nQuality scores: error — ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Auto-consolidation (opt-in)
      if (args.auto_consolidate) {
        try {
          const provider = await getEmbeddingProvider();
          const consolidateResult = await autoConsolidate(db, provider);
          parts.push(`\nAuto-consolidation: ${consolidateResult.clustersFound} clusters found, ${consolidateResult.clustersConsolidated} consolidated, ${consolidateResult.memoriesMerged} memories merged`);
        } catch (err) {
          parts.push(`\nAuto-consolidation: error — ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Dangling entities — entities with very few linked memories (structural knowledge gaps)
      try {
        const danglingRows = db.prepare(`
          SELECT e.id, e.name, e.type, COUNT(me.memory_id) as memory_count
          FROM entities e
          LEFT JOIN memory_entities me ON e.id = me.entity_id
          LEFT JOIN memories m ON me.memory_id = m.id AND m.is_active = 1
          GROUP BY e.id
          HAVING COUNT(CASE WHEN m.is_active = 1 THEN 1 END) <= 1
          ORDER BY COUNT(CASE WHEN m.is_active = 1 THEN 1 END) ASC, e.name ASC
          LIMIT 10
        `).all() as unknown as Array<{ id: string; name: string; type: string; memory_count: number }>;

        if (danglingRows.length > 0) {
          parts.push(`\nDangling entities (${danglingRows.length} with 0-1 linked memories):`);
          for (const row of danglingRows) {
            parts.push(`  "${row.name}" [${row.type}] — ${row.memory_count} memory(ies)`);
          }
        }
      } catch {
        // Non-critical
      }

      // Prune orphan entities (< 2 active memory links)
      try {
        const entityStore = new EntityStore(db);
        const pruneResult = entityStore.pruneOrphans(2);
        if (pruneResult.pruned > 0) {
          const nameList = pruneResult.names.slice(0, 10).join(", ");
          const suffix = pruneResult.names.length > 10 ? ` (+${pruneResult.names.length - 10} more)` : "";
          parts.push(`\nPruned ${pruneResult.pruned} orphan entities: ${nameList}${suffix}`);
        }
      } catch {
        // Non-critical
      }

      return { content: [{ type: "text", text: `Maintenance complete:\n\n${parts.join("\n")}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// memory_tag_cleanup
server.tool(
  "memory_tag_cleanup",
  "Find and merge near-duplicate tags. Preview mode shows suggestions; apply mode merges them.",
  {
    min_similarity: z.number().min(0).max(1).optional().describe("Minimum string similarity for suggestions (default 0.8)"),
    limit: z.number().optional().describe("Max suggestions to return (default 20)"),
    apply: z.boolean().optional().describe("If true, apply the top suggestion or specified from/to pair"),
    from_tag: z.string().optional().describe("Specific tag to merge FROM (use with apply:true)"),
    to_tag: z.string().optional().describe("Specific tag to merge TO (use with apply:true)"),
  },
  async (args) => {
    try {
      if (args.apply) {
        // Apply mode: merge a specific pair or the top suggestion
        if (args.from_tag && args.to_tag) {
          const result = applyTagMerge(db, args.from_tag, args.to_tag);
          return {
            content: [{
              type: "text",
              text: `Merged tag "${args.from_tag}" → "${args.to_tag}": ${result.updated} memory tag(s) updated. Alias added to settings.`,
            }],
          };
        }

        // No specific pair — merge top suggestion
        const suggestions = suggestTagMerges(db, {
          minSimilarity: args.min_similarity,
          limit: 1,
        });
        if (suggestions.length === 0) {
          return { content: [{ type: "text", text: "No merge suggestions found at this similarity threshold." }] };
        }
        const top = suggestions[0];
        const result = applyTagMerge(db, top.from, top.to);
        return {
          content: [{
            type: "text",
            text: `Merged tag "${top.from}" (${top.fromCount}) → "${top.to}" (${top.toCount}): ${result.updated} memory tag(s) updated (similarity: ${top.similarity}).`,
          }],
        };
      }

      // Preview mode: show suggestions
      const suggestions = suggestTagMerges(db, {
        minSimilarity: args.min_similarity,
        limit: args.limit,
      });

      if (suggestions.length === 0) {
        return { content: [{ type: "text", text: "No near-duplicate tags found at this similarity threshold." }] };
      }

      const lines = [`Found ${suggestions.length} merge suggestion(s):\n`];
      for (const s of suggestions) {
        lines.push(
          `- "${s.from}" (${s.fromCount}) → "${s.to}" (${s.toCount}) — similarity: ${s.similarity}, co-occurrence: ${s.coOccurrence}`
        );
      }
      lines.push(`\nTo merge, call with apply:true or specify from_tag and to_tag.`);

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// memory_timeline
server.tool(
  "memory_timeline",
  "Query decision history, memory lineage, topic evolution, or temporal hierarchy. Use 'decisions' for decision-tagged memories chronologically, 'lineage' to trace a memory's supersession chain, 'evolution' to see how knowledge about a topic changed over time, or 'hierarchy' to view epoch -> theme -> episode organization.",
  {
    mode: z.enum(["decisions", "lineage", "evolution", "hierarchy"]).describe("'decisions' for decision timeline, 'lineage' for supersession chain, 'evolution' for topic knowledge evolution, 'hierarchy' for epoch/theme/episode tree"),
    memory_id: z.string().optional().describe("Memory ID (required for lineage mode)"),
    topic: z.string().optional().describe("Topic to trace evolution for (required for evolution mode)"),
    month: z.string().optional().describe("Month filter YYYY-MM (for hierarchy mode)"),
    after: z.string().optional().describe("Only after this date (YYYY-MM-DD)"),
    before: z.string().optional().describe("Only before this date (YYYY-MM-DD)"),
    limit: z.number().optional().describe("Max results (default 50)"),
    tags: z.array(z.string()).optional().describe("Additional tag filters (for decisions mode)"),
  },
  async (args) => {
    try {
      // hierarchy mode — epoch -> theme -> episode tree
      if (args.mode === "hierarchy") {
        const { getTemporalHierarchy } = await import("@exocortex/core");
        const hierarchy = getTemporalHierarchy(db, {
          month: args.month,
          after: args.after,
          before: args.before,
          maxEpisodes: args.limit ?? 20,
        });

        if (hierarchy.epochs.length === 0 && hierarchy.orphan_themes.length === 0) {
          return { content: [{ type: "text", text: "No epochs or narratives found for the given time range." }] };
        }

        const lines: string[] = [];
        const range = hierarchy.time_range
          ? `${hierarchy.time_range.start} to ${hierarchy.time_range.end}`
          : "unknown";
        lines.push(`Temporal Hierarchy (${range}):\n`);

        for (const epoch of hierarchy.epochs) {
          const preview = epoch.content.length > 120 ? epoch.content.substring(0, 117) + "..." : epoch.content;
          lines.push(`EPOCH [${epoch.month}] [${epoch.id}] ${preview}`);

          for (const theme of epoch.themes) {
            const tPreview = theme.content.length > 100 ? theme.content.substring(0, 97) + "..." : theme.content;
            const linkIcon = theme.linked ? " ~" : "";
            lines.push(`  THEME [${theme.id}] ${tPreview}${linkIcon}`);

            for (const ep of theme.episodes) {
              const ePreview = ep.content.length > 80 ? ep.content.substring(0, 77) + "..." : ep.content;
              const epLink = ep.linked ? " ~" : "";
              const tagStr = ep.tags.length > 0 ? ` [${ep.tags.slice(0, 3).join(", ")}]` : "";
              lines.push(`    - [${ep.id}] ${ePreview}${tagStr}${epLink} (${ep.importance})`);
            }
          }
          lines.push("");
        }

        if (hierarchy.orphan_themes.length > 0) {
          lines.push("ORPHAN THEMES (no matching epoch):");
          for (const theme of hierarchy.orphan_themes) {
            const tPreview = theme.content.length > 100 ? theme.content.substring(0, 97) + "..." : theme.content;
            lines.push(`  THEME [${theme.id}] ${tPreview}`);
            for (const ep of theme.episodes) {
              const ePreview = ep.content.length > 80 ? ep.content.substring(0, 77) + "..." : ep.content;
              lines.push(`    - [${ep.id}] ${ePreview} (${ep.importance})`);
            }
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      if (args.mode === "lineage") {
        if (!args.memory_id) {
          return { content: [{ type: "text", text: "memory_id is required for lineage mode." }] };
        }

        const lineage = getMemoryLineage(db, args.memory_id);
        if (lineage.length === 0) {
          return { content: [{ type: "text", text: `Memory ${args.memory_id} not found.` }] };
        }

        const lines = lineage.map((entry) => {
          const marker = entry.direction === "current" ? ">>>" : entry.direction === "predecessor" ? " < " : " > ";
          const preview = entry.content.length > 120 ? entry.content.substring(0, 117) + "..." : entry.content;
          return `${marker} [${entry.id}] ${preview} (importance: ${entry.importance}, ${entry.created_at})`;
        });

        return {
          content: [{ type: "text", text: `Lineage for ${args.memory_id} (${lineage.length} entries):\n\n${lines.join("\n")}` }],
        };
      }

      // evolution mode — trace how knowledge about a topic evolved
      if (args.mode === "evolution") {
        if (!args.topic) {
          return { content: [{ type: "text", text: "topic is required for evolution mode." }] };
        }

        const search = new MemorySearch(db);
        const results = await search.search({
          query: args.topic,
          limit: args.limit ?? 30,
          after: args.after,
          before: args.before,
        });

        if (results.length === 0) {
          return { content: [{ type: "text", text: `No memories found about "${args.topic}".` }] };
        }

        // Sort chronologically
        results.sort((a, b) => a.memory.created_at.localeCompare(b.memory.created_at));

        const linkStore = new MemoryLinkStore(db);
        const lines = results.map((r) => {
          const m = r.memory;
          const preview = m.content.length > 200 ? m.content.substring(0, 197) + "..." : m.content;
          const tagStr = m.tags?.length ? ` [${m.tags.join(", ")}]` : "";

          // Supersession info
          const supersessionParts: string[] = [];
          const predecessor = db
            .prepare("SELECT id FROM memories WHERE superseded_by = ?")
            .get(m.id) as { id: string } | undefined;
          if (predecessor) supersessionParts.push(`supersedes: ${predecessor.id}`);
          if ((m as any).superseded_by) supersessionParts.push(`superseded_by: ${(m as any).superseded_by}`);

          // Memory links
          const memLinks = linkStore.getLinks(m.id);
          const linkParts = memLinks
            .filter((l) => results.some((r2) => r2.memory.id === (l.source_id === m.id ? l.target_id : l.source_id)))
            .slice(0, 3)
            .map((l) => {
              const otherId = l.source_id === m.id ? l.target_id : l.source_id;
              return `${l.link_type}→${otherId.substring(0, 8)}`;
            });

          const metaParts: string[] = [`score: ${r.score.toFixed(3)}`];
          if (supersessionParts.length > 0) metaParts.push(supersessionParts.join(", "));
          if (linkParts.length > 0) metaParts.push(`links: ${linkParts.join(", ")}`);

          return `[${m.created_at}] [${m.id}] ${preview}${tagStr}\n  (${metaParts.join(" | ")})`;
        });

        return {
          content: [{ type: "text", text: `Knowledge evolution for "${args.topic}" (${results.length} memories, chronological):\n\n${lines.join("\n\n")}` }],
        };
      }

      // decisions mode
      const timeline = getDecisionTimeline(db, {
        after: args.after,
        before: args.before,
        limit: args.limit,
        tags: args.tags,
      });

      if (timeline.length === 0) {
        return { content: [{ type: "text", text: "No decision-tagged memories found." }] };
      }

      const lines = timeline.map((entry) => {
        const preview = entry.content.length > 150 ? entry.content.substring(0, 147) + "..." : entry.content;
        const tagStr = entry.tags.length > 0 ? ` [${entry.tags.join(", ")}]` : "";
        const links: string[] = [];
        if (entry.supersedes) links.push(`supersedes: ${entry.supersedes}`);
        if (entry.superseded_by) links.push(`superseded_by: ${entry.superseded_by}`);
        const linkStr = links.length > 0 ? ` (${links.join(", ")})` : "";
        return `- [${entry.id}] ${preview}${tagStr}${linkStr} (${entry.created_at})`;
      });

      return {
        content: [{ type: "text", text: `Decision timeline (${timeline.length} entries):\n\n${lines.join("\n")}` }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// memory_ping
server.tool(
  "memory_ping",
  "Health check — returns memory counts, entity/tag stats, date range, and server uptime.",
  {},
  async () => {
    try {
      const store = new MemoryStore(db);
      const stats = await store.getStats();
      const uptimeMs = Date.now() - startTime;
      const uptimeSec = Math.floor(uptimeMs / 1000);
      const uptimeMin = Math.floor(uptimeSec / 60);
      const uptimeHr = Math.floor(uptimeMin / 60);

      let uptimeStr: string;
      if (uptimeHr > 0) {
        uptimeStr = `${uptimeHr}h ${uptimeMin % 60}m`;
      } else if (uptimeMin > 0) {
        uptimeStr = `${uptimeMin}m ${uptimeSec % 60}s`;
      } else {
        uptimeStr = `${uptimeSec}s`;
      }

      const lines = [
        `Status: OK`,
        `Memories: ${stats.active_memories} active / ${stats.total_memories} total`,
        `Entities: ${stats.total_entities}`,
        `Tags: ${stats.total_tags}`,
        `Oldest: ${stats.oldest_memory ?? "none"}`,
        `Newest: ${stats.newest_memory ?? "none"}`,
        `Uptime: ${uptimeStr}`,
      ];

      // Health diagnostics
      try {
        const health = runHealthChecks(db);
        const statusIcon = { ok: "OK", warn: "WARN", critical: "CRITICAL" };
        lines.push("");
        lines.push(`Health: ${statusIcon[health.overall]}`);
        for (const check of health.checks) {
          const prefix = check.status === "ok" ? "  " : check.status === "warn" ? "  [!] " : "  [!!] ";
          lines.push(`${prefix}${check.name}: ${check.message}`);
        }
      } catch {
        // Non-critical
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// memory_ingest
server.tool(
  "memory_ingest",
  "Index external markdown files into Exocortex as memories. Splits by ## headers into separate memories. Supports glob patterns like *.md.",
  {
    path: z.union([z.string(), z.array(z.string())]).describe("File path(s) — supports glob patterns with * or ? in the filename"),
    tags: z.array(z.string()).optional().describe("Tags to apply to all ingested memories"),
    importance: z.number().min(0).max(1).optional().describe("Importance score (default 0.5)"),
    content_type: z.enum(["text", "conversation", "note", "summary"]).optional().describe("Content type (default 'note')"),
  },
  async (args) => {
    const inputPaths = Array.isArray(args.path) ? args.path : [args.path];

    // Expand glob patterns
    const resolvedPaths: string[] = [];
    for (const p of inputPaths) {
      if (p.includes("*") || p.includes("?")) {
        // Basic glob: expand in the directory containing the pattern
        const dir = path.dirname(p);
        const pattern = path.basename(p);
        const regex = new RegExp(
          "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
        );
        try {
          const absDir = path.resolve(dir);
          const entries = fs.readdirSync(absDir);
          for (const entry of entries) {
            if (regex.test(entry)) {
              resolvedPaths.push(path.join(absDir, entry));
            }
          }
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Error reading directory "${dir}": ${err instanceof Error ? err.message : String(err)}` }],
          };
        }
      } else {
        resolvedPaths.push(path.resolve(p));
      }
    }

    if (resolvedPaths.length === 0) {
      return { content: [{ type: "text", text: "No files matched the provided path(s)." }] };
    }

    // Verify files exist
    const missing = resolvedPaths.filter((p) => !fs.existsSync(p));
    if (missing.length > 0) {
      return {
        content: [{ type: "text", text: `File(s) not found: ${missing.join(", ")}` }],
      };
    }

    try {
      const result = await ingestFiles(db, resolvedPaths, {
        tags: args.tags,
        importance: args.importance,
        content_type: args.content_type as ContentType | undefined,
      });

      const lines = result.files.map((f) => {
        const name = path.basename(f.file);
        const replacedStr = f.replaced > 0 ? `, replaced ${f.replaced} existing` : "";
        return `- ${name}: ${f.stored} memories stored (${f.sections} sections, ${f.skipped} skipped${replacedStr})`;
      });

      const replacedStr = result.totalReplaced > 0 ? ` (replaced ${result.totalReplaced} existing)` : "";
      return {
        content: [{
          type: "text",
          text: `Ingested ${result.totalStored} memories from ${result.files.length} file(s)${replacedStr}:\n\n${lines.join("\n")}`,
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Ingest error: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  }
);

// memory_link
server.tool(
  "memory_link",
  "Create or remove a link between two memories. Links enable graph-aware context retrieval — linked memories surface together during context loading.",
  {
    source_id: z.string().describe("Source memory ID"),
    target_id: z.string().describe("Target memory ID"),
    link_type: z.enum(["related", "elaborates", "contradicts", "supersedes", "supports", "derived_from"]).optional().describe("Link type (default 'related')"),
    strength: z.number().min(0).max(1).optional().describe("Link strength 0-1 (default 0.5)"),
    remove: z.boolean().optional().describe("Set to true to remove the link instead of creating it"),
  },
  async (args) => {
    try {
      const store = new MemoryStore(db);
      const linkStore = new MemoryLinkStore(db);

      // Validate both memories exist
      const source = await store.getById(args.source_id);
      if (!source) {
        return { content: [{ type: "text", text: `Source memory ${args.source_id} not found.` }] };
      }
      const target = await store.getById(args.target_id);
      if (!target) {
        return { content: [{ type: "text", text: `Target memory ${args.target_id} not found.` }] };
      }

      if (args.remove) {
        const removed = linkStore.unlink(args.source_id, args.target_id);
        if (!removed) {
          return { content: [{ type: "text", text: `No link found between ${args.source_id} and ${args.target_id}.` }] };
        }
        return { content: [{ type: "text", text: `Removed link ${args.source_id} → ${args.target_id}` }] };
      }

      const linkType = (args.link_type ?? "related") as LinkType;
      const strength = args.strength ?? 0.5;
      linkStore.link(args.source_id, args.target_id, linkType, strength);

      const srcPreview = source.content.substring(0, 60) + (source.content.length > 60 ? "..." : "");
      const tgtPreview = target.content.substring(0, 60) + (target.content.length > 60 ? "..." : "");
      return {
        content: [{
          type: "text",
          text: `Linked: "${srcPreview}" —[${linkType}, ${strength}]→ "${tgtPreview}"`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// memory_digest_session
server.tool(
  "memory_digest_session",
  "Digest a Claude Code session transcript into a structured memory summary.",
  {
    transcript_path: z.string().describe("Path to the session transcript JSONL file"),
    tags: z.array(z.string()).optional().describe("Additional tags"),
  },
  async (args) => {
    try {
      if (!fs.existsSync(args.transcript_path)) {
        return { content: [{ type: "text", text: `Transcript not found: ${args.transcript_path}` }] };
      }

      const result = await digestTranscript(args.transcript_path);

      if (result.actions.length === 0) {
        return { content: [{ type: "text", text: "No actionable tool uses found in transcript." }] };
      }

      const store = new MemoryStore(db);
      const { memory } = await store.create({
        content: result.summary,
        content_type: "summary",
        source: "mcp",
        importance: 0.5,
        tags: ["session-digest", ...(result.project ? [result.project] : []), ...(args.tags ?? [])],
      });

      // Store each extracted fact as an individual memory
      let factsStored = 0;
      for (const fact of result.facts) {
        try {
          await store.create({
            content: fact.text,
            content_type: "text",
            source: "mcp",
            importance: 0.6,
            tags: [
              "session-fact",
              fact.type,
              ...(result.project ? [result.project] : []),
              ...(args.tags ?? []),
            ],
          });
          factsStored++;
        } catch {
          // Non-critical — skip individual fact on failure
        }
      }

      const factStr = factsStored > 0 ? ` + ${factsStored} facts extracted` : "";
      return {
        content: [{
          type: "text",
          text: `Stored session digest (${result.actions.length} actions, project: ${result.project ?? "unknown"})${factStr}.\nID: ${memory.id}`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// goal_create
server.tool(
  "goal_create",
  "Create a new goal to track. Goals are persistent objectives with progress monitoring — define what you're trying to achieve, and the system tracks progress and detects stalls.",
  {
    title: z.string().describe("Goal title"),
    description: z.string().optional().describe("Detailed description of the goal"),
    priority: z.enum(["low", "medium", "high", "critical"]).optional().describe("Priority level (default 'medium')"),
    deadline: z.string().optional().describe("Target deadline (ISO date YYYY-MM-DD)"),
    metadata: z.record(z.string(), z.any()).optional().describe("Arbitrary JSON metadata"),
  },
  async (args) => {
    try {
      const store = new GoalStore(db);
      const goal = store.create({
        title: args.title,
        description: args.description,
        priority: args.priority,
        deadline: args.deadline,
        metadata: args.metadata,
      });

      const meta: string[] = [`id: ${goal.id}`, `priority: ${goal.priority}`];
      if (goal.deadline) meta.push(`deadline: ${goal.deadline}`);

      return { content: [{ type: "text", text: `Created goal: "${goal.title}" (${meta.join(" | ")})` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// goal_list
server.tool(
  "goal_list",
  "List goals, optionally filtered by status. Default: active goals only.",
  {
    status: z.enum(["active", "completed", "stalled", "abandoned"]).optional().describe("Filter by status (default: active)"),
    include_progress: z.boolean().optional().describe("Include recent progress entries (default false)"),
  },
  async (args) => {
    try {
      const store = new GoalStore(db);
      const status = args.status ?? "active";
      const goals = store.list(status);

      if (goals.length === 0) {
        return { content: [{ type: "text", text: `No ${status} goals found.` }] };
      }

      const lines = goals.map((goal) => {
        const meta: string[] = [`priority: ${goal.priority}`];
        if (goal.deadline) meta.push(`deadline: ${goal.deadline}`);
        meta.push(`created: ${goal.created_at}`);
        if (goal.completed_at) meta.push(`completed: ${goal.completed_at}`);

        const autoBadge = goal.metadata?.mode === "autonomous" ? "[AUTO] " : "";
        let line = `${autoBadge}[${goal.id}] ${goal.title}\n  ${goal.description ?? "(no description)"}\n  (${meta.join(" | ")})`;

        if (args.include_progress) {
          const withProgress = store.getWithProgress(goal.id, 5);
          if (withProgress) {
            if (withProgress.milestones.length > 0) {
              const completed = withProgress.milestones.filter((m) => m.status === "completed").length;
              line += `\n  Milestones: ${completed}/${withProgress.milestones.length} completed`;
            }
            if (withProgress.progress.length > 0) {
              const progressLines = withProgress.progress.map(
                (p) => `    - ${p.content} (${p.created_at})`
              );
              line += `\n  Progress:\n${progressLines.join("\n")}`;
            } else {
              line += "\n  Progress: none";
            }
          }
        }

        return line;
      });

      return {
        content: [{ type: "text", text: `${status.charAt(0).toUpperCase() + status.slice(1)} goals (${goals.length}):\n\n${lines.join("\n\n")}` }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// goal_update
server.tool(
  "goal_update",
  "Update an existing goal's title, description, status, priority, deadline, or metadata.",
  {
    id: z.string().describe("Goal ID"),
    title: z.string().optional().describe("New title"),
    description: z.string().nullable().optional().describe("New description"),
    status: z.enum(["active", "completed", "stalled", "abandoned"]).optional().describe("New status"),
    priority: z.enum(["low", "medium", "high", "critical"]).optional().describe("New priority"),
    deadline: z.string().nullable().optional().describe("New deadline (ISO date YYYY-MM-DD)"),
    metadata: z.record(z.string(), z.any()).optional().describe("Merge metadata (set value to null to delete a key)"),
  },
  async (args) => {
    try {
      const { id, ...updates } = args;

      if (
        updates.title === undefined &&
        updates.description === undefined &&
        updates.status === undefined &&
        updates.priority === undefined &&
        updates.deadline === undefined &&
        updates.metadata === undefined
      ) {
        return { content: [{ type: "text", text: "No update fields provided." }] };
      }

      const store = new GoalStore(db);
      const updated = store.update(id, updates);

      if (!updated) {
        return { content: [{ type: "text", text: `Goal ${id} not found.` }] };
      }

      const meta: string[] = [`status: ${updated.status}`, `priority: ${updated.priority}`];
      if (updated.deadline) meta.push(`deadline: ${updated.deadline}`);

      return { content: [{ type: "text", text: `Updated goal: "${updated.title}" (${meta.join(" | ")})` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// goal_log
server.tool(
  "goal_log",
  "Log progress on a goal. Creates a memory tagged 'goal-progress' linked to the goal.",
  {
    id: z.string().describe("Goal ID"),
    content: z.string().describe("Progress note"),
    importance: z.number().min(0).max(1).optional().describe("Importance 0-1 (default 0.5)"),
  },
  async (args) => {
    try {
      const store = new GoalStore(db);

      const goal = store.getById(args.id);
      if (!goal) {
        return { content: [{ type: "text", text: `Goal ${args.id} not found.` }] };
      }

      const memoryId = await store.logProgress(args.id, args.content, args.importance);

      return {
        content: [{ type: "text", text: `Logged progress on "${goal.title}" (memory: ${memoryId})` }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// goal_get
server.tool(
  "goal_get",
  "Get a goal's details including recent progress entries.",
  {
    id: z.string().describe("Goal ID"),
    progress_limit: z.number().optional().describe("Max progress entries to return (default 10)"),
  },
  async (args) => {
    try {
      const store = new GoalStore(db);
      const goal = store.getWithProgress(args.id, args.progress_limit ?? 10);

      if (!goal) {
        return { content: [{ type: "text", text: `Goal ${args.id} not found.` }] };
      }

      const meta: string[] = [
        `status: ${goal.status}`,
        `priority: ${goal.priority}`,
      ];
      if (goal.deadline) meta.push(`deadline: ${goal.deadline}`);
      meta.push(`created: ${goal.created_at}`);
      if (goal.completed_at) meta.push(`completed: ${goal.completed_at}`);

      const parts: string[] = [
        `[${goal.id}] ${goal.title}`,
        goal.description ?? "(no description)",
        `(${meta.join(" | ")})`,
      ];

      // Show metadata (excluding milestones which are shown separately)
      const displayMeta = { ...goal.metadata };
      delete displayMeta.milestones;
      if (Object.keys(displayMeta).length > 0) {
        parts.push(`Metadata: ${JSON.stringify(displayMeta)}`);
      }

      if (goal.milestones.length > 0) {
        const completed = goal.milestones.filter((m) => m.status === "completed").length;
        parts.push(`\nMilestones (${completed}/${goal.milestones.length} completed):`);
        for (const m of goal.milestones) {
          const statusIcon = m.status === "completed" ? "[x]" : m.status === "in_progress" ? "[~]" : "[ ]";
          const deadlineStr = m.deadline ? ` (deadline: ${m.deadline})` : "";
          parts.push(`  ${statusIcon} ${m.title}${deadlineStr}`);
        }
      }

      // Show autonomy info for autonomous goals
      if (goal.metadata?.mode === "autonomous") {
        const approvedTools = goal.metadata.approved_tools as string[] | undefined;
        const maxActions = (goal.metadata.max_actions_per_cycle as number) ?? 10;
        const strategy = goal.metadata.strategy as string | undefined;
        parts.push(`\nAutonomy: ENABLED`);
        parts.push(`  Tools: ${approvedTools?.length ? approvedTools.join(", ") : "all"}`);
        parts.push(`  Max actions/cycle: ${maxActions}`);
        if (strategy) parts.push(`  Strategy: "${strategy}"`);
      }

      if (goal.progress.length > 0) {
        parts.push(`\nProgress (${goal.progress.length}):`);
        for (const p of goal.progress) {
          parts.push(`  - [${p.id}] ${p.content} (${p.created_at})`);
        }
      } else {
        parts.push("\nProgress: none");
      }

      return { content: [{ type: "text", text: parts.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// goal_add_milestone
server.tool(
  "goal_add_milestone",
  "Add a milestone to a goal. Milestones break goals into trackable sub-objectives.",
  {
    id: z.string().describe("Goal ID"),
    title: z.string().describe("Milestone title"),
    order: z.number().optional().describe("Sort order (auto-increments if omitted)"),
    deadline: z.string().optional().describe("Milestone deadline (ISO date YYYY-MM-DD)"),
  },
  async (args) => {
    const store = new GoalStore(db);
    try {
      const milestone = store.addMilestone(args.id, {
        title: args.title,
        order: args.order,
        deadline: args.deadline,
      });
      const meta: string[] = [`id: ${milestone.id}`, `order: ${milestone.order}`];
      if (milestone.deadline) meta.push(`deadline: ${milestone.deadline}`);
      return { content: [{ type: "text", text: `Added milestone: "${milestone.title}" (${meta.join(" | ")})` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }
);

// goal_update_milestone
server.tool(
  "goal_update_milestone",
  "Update a milestone's title, status, order, or deadline.",
  {
    goal_id: z.string().describe("Goal ID"),
    milestone_id: z.string().describe("Milestone ID"),
    title: z.string().optional().describe("New title"),
    status: z.enum(["pending", "in_progress", "completed"]).optional().describe("New status"),
    order: z.number().optional().describe("New sort order"),
    deadline: z.string().optional().describe("New deadline (ISO date YYYY-MM-DD)"),
  },
  async (args) => {
    try {
      const { goal_id, milestone_id, ...updates } = args;

      if (!updates.title && !updates.status && updates.order === undefined && !updates.deadline) {
        return { content: [{ type: "text", text: "No update fields provided." }] };
      }

      const store = new GoalStore(db);
      const updated = store.updateMilestone(goal_id, milestone_id, updates);

      if (!updated) {
        return { content: [{ type: "text", text: `Goal or milestone not found.` }] };
      }

      const meta: string[] = [`status: ${updated.status}`, `order: ${updated.order}`];
      if (updated.deadline) meta.push(`deadline: ${updated.deadline}`);
      return { content: [{ type: "text", text: `Updated milestone: "${updated.title}" (${meta.join(" | ")})` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// goal_remove_milestone
server.tool(
  "goal_remove_milestone",
  "Remove a milestone from a goal.",
  {
    goal_id: z.string().describe("Goal ID"),
    milestone_id: z.string().describe("Milestone ID"),
  },
  async (args) => {
    try {
      const store = new GoalStore(db);
      const removed = store.removeMilestone(args.goal_id, args.milestone_id);

      if (!removed) {
        return { content: [{ type: "text", text: `Goal or milestone not found.` }] };
      }

      return { content: [{ type: "text", text: `Removed milestone ${args.milestone_id}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// memory_project_snapshot
server.tool(
  "memory_project_snapshot",
  "Get a quick project snapshot: recent activity, active goals, recent decisions, open threads, and learned techniques. Use at start of a project session.",
  {
    project: z.string().optional().describe("Project name to snapshot (auto-detected from cwd if omitted)"),
    cwd: z.string().optional().describe("Working directory for auto-detecting project name via path.basename()"),
    days: z.number().optional().describe("Lookback days (default 14)"),
  },
  async (args) => {
    try {
      const projectName = args.project || (args.cwd ? path.basename(args.cwd) : undefined);
      if (!projectName) {
        return { content: [{ type: "text", text: "Error: provide either 'project' or 'cwd' parameter" }], isError: true };
      }

      const days = args.days ?? 14;
      const since = new Date();
      since.setDate(since.getDate() - days);
      const sinceStr = since.toISOString();

      const search = new MemorySearch(db);
      const goalStore = new GoalStore(db);

      // Run queries in parallel
      const [recentResults, decisionResults, goals, openThreadResults, techniqueResults] = await Promise.all([
        search.search({
          query: projectName,
          limit: 10,
          after: sinceStr,
        }),
        search.search({
          query: `${projectName} decision`,
          limit: 5,
          tags: ["decision"],
          after: sinceStr,
        }),
        Promise.resolve(goalStore.list("active")),
        // Open threads: plan/todo/next-steps/in-progress, unsuperseded, last 14 days
        search.search({
          query: projectName,
          limit: 5,
          tags: ["plan", "todo", "next-steps", "in-progress"],
          after: sinceStr,
        }),
        // Learned techniques: top 5 by importance
        search.search({
          query: projectName,
          limit: 5,
          tags: ["technique"],
        }),
      ]);

      // Format output
      const sections: string[] = [];

      sections.push(`# Project Snapshot: ${projectName}\n*Last ${days} days*\n`);

      // Recent Activity
      sections.push("## Recent Activity");
      if (recentResults.length === 0) {
        sections.push("No recent activity found.\n");
      } else {
        for (const r of recentResults) {
          const preview = r.memory.content.slice(0, 150).replace(/\n/g, " ");
          sections.push(`- **${r.memory.id}** (${r.memory.created_at.slice(0, 10)}, imp=${r.memory.importance}): ${preview}...`);
        }
        sections.push("");
      }

      // Active Goals
      sections.push("## Active Goals");
      if (goals.length === 0) {
        sections.push("No active goals.\n");
      } else {
        for (const g of goals) {
          const deadline = g.deadline ? ` (due: ${g.deadline})` : "";
          sections.push(`- **${g.title}** [${g.priority}]${deadline}`);
          if (g.description) sections.push(`  ${g.description.slice(0, 100)}`);
        }
        sections.push("");
      }

      // Recent Decisions
      sections.push("## Recent Decisions");
      if (decisionResults.length === 0) {
        sections.push("No recent decisions found.\n");
      } else {
        for (const d of decisionResults) {
          const preview = d.memory.content.slice(0, 200).replace(/\n/g, " ");
          sections.push(`- (${d.memory.created_at.slice(0, 10)}) ${preview}`);
        }
        sections.push("");
      }

      // Open Threads
      sections.push("## Open Threads");
      if (openThreadResults.length === 0) {
        sections.push("No open threads.\n");
      } else {
        for (const t of openThreadResults) {
          const preview = t.memory.content.slice(0, 150).replace(/\n/g, " ");
          sections.push(`- (${t.memory.created_at.slice(0, 10)}) ${preview}`);
        }
        sections.push("");
      }

      // Learned Techniques
      sections.push("## Learned Techniques");
      if (techniqueResults.length === 0) {
        sections.push("No techniques recorded.\n");
      } else {
        for (const t of techniqueResults) {
          const preview = t.memory.content.slice(0, 150).replace(/\n/g, " ");
          sections.push(`- (imp=${t.memory.importance}) ${preview}`);
        }
        sections.push("");
      }

      return { content: [{ type: "text", text: sections.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// memory_diff
server.tool(
  "memory_diff",
  "See what changed since a timestamp — new, updated, and archived memories.",
  {
    since: z.string().describe("ISO timestamp to diff from (e.g. 2026-02-24T00:00:00Z)"),
    limit: z.number().optional().describe("Max results per category (default 50)"),
    namespace: z.string().optional().describe("Optional namespace filter"),
  },
  async (args) => {
    try {
      const store = new MemoryStore(db);
      const diff = await store.getDiff(args.since, args.limit ?? 50, args.namespace);

      const sections: string[] = [];
      sections.push(`# Changes since ${args.since}\n`);

      sections.push(`## Created (${diff.created.length})`);
      for (const m of diff.created) {
        const preview = m.content.slice(0, 120).replace(/\n/g, " ");
        sections.push(`- **${m.id}** (${m.created_at.slice(0, 10)}): ${preview}`);
      }
      sections.push("");

      sections.push(`## Updated (${diff.updated.length})`);
      for (const m of diff.updated) {
        const preview = m.content.slice(0, 120).replace(/\n/g, " ");
        sections.push(`- **${m.id}** (${m.updated_at.slice(0, 10)}): ${preview}`);
      }
      sections.push("");

      sections.push(`## Archived (${diff.archived.length})`);
      for (const m of diff.archived) {
        const preview = m.content.slice(0, 120).replace(/\n/g, " ");
        sections.push(`- **${m.id}** (${m.updated_at.slice(0, 10)}): ${preview}`);
      }

      return { content: [{ type: "text", text: sections.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "memory_contradictions",
  "List or resolve detected contradictions between memories. Contradictions are detected nightly and can be dismissed or resolved inline.",
  {
    status: z.enum(["pending", "resolved", "dismissed"]).optional().describe("Filter by status (default: pending)"),
    limit: z.number().optional().describe("Max results (default 10)"),
    resolve_id: z.string().optional().describe("Contradiction ID to resolve/dismiss"),
    resolution: z.string().optional().describe("Resolution text (required when resolving, optional when dismissing)"),
    resolve_status: z.enum(["resolved", "dismissed"]).optional().describe("New status for resolve_id (default: resolved)"),
    auto_dismiss: z.boolean().optional().describe("Auto-dismiss low-signal contradictions (deleted sources, consolidation artifacts, low quality, version/date changes)"),
  },
  async (args) => {
    try {
      // Auto-dismiss mode
      if (args.auto_dismiss) {
        const result = autoDismissContradictions(db);
        const summary = Object.entries(result.reasons)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ");
        return {
          content: [{ type: "text", text: `Auto-dismissed ${result.dismissed} contradictions.${summary ? `\nReasons: ${summary}` : ""}` }],
        };
      }

      // If resolving/dismissing a specific contradiction
      if (args.resolve_id) {
        const newStatus = args.resolve_status ?? "resolved";
        const result = updateContradiction(db, args.resolve_id, {
          status: newStatus,
          resolution: args.resolution,
        });
        if (!result) {
          return { content: [{ type: "text", text: `Contradiction ${args.resolve_id} not found.` }], isError: true };
        }
        return {
          content: [{ type: "text", text: `Contradiction ${args.resolve_id} marked as ${newStatus}.${args.resolution ? ` Resolution: ${args.resolution}` : ""}` }],
        };
      }

      // List contradictions
      const status = args.status ?? "pending";
      const limit = args.limit ?? 10;
      const contradictions = getContradictions(db, status, limit);

      if (contradictions.length === 0) {
        return { content: [{ type: "text", text: `No ${status} contradictions found.` }] };
      }

      const store = new MemoryStore(db);
      const lines = await Promise.all(contradictions.map(async (c) => {
        const memA = await store.getById(c.memory_a_id);
        const memB = await store.getById(c.memory_b_id);
        const previewA = memA ? memA.content.substring(0, 120).replace(/\n/g, " ") : "(deleted)";
        const previewB = memB ? memB.content.substring(0, 120).replace(/\n/g, " ") : "(deleted)";
        const parts = [
          `**${c.id}** (${c.status}) — ${c.created_at.slice(0, 10)}`,
          `  A [${c.memory_a_id}]: ${previewA}`,
          `  B [${c.memory_b_id}]: ${previewB}`,
          `  Reason: ${c.description}`,
        ];
        if (c.resolution) parts.push(`  Resolution: ${c.resolution}`);
        return parts.join("\n");
      }));

      return {
        content: [{ type: "text", text: `${status} contradictions (${contradictions.length}):\n\n${lines.join("\n\n")}` }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// Graceful shutdown
process.on("exit", () => {
  try { closeDb(); } catch {}
});

// Start
async function main() {
  // On Windows, MCP hosts may redirect stderr to "nul" which can create
  // a literal file in the CWD under some shell environments (git-bash/MSYS).
  // Suppress stderr to avoid this.
  if (process.platform === "win32") {
    process.stderr.write = () => true;
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export { server };

export function getRegisteredToolForTesting(name: string): unknown {
  const tools = (server as unknown as { _registeredTools?: unknown })
    ._registeredTools;
  if (!tools) return undefined;
  if (tools instanceof Map) {
    return tools.get(name);
  }
  if (Array.isArray(tools)) {
    return tools.find((tool) =>
      typeof tool === "object" &&
      tool !== null &&
      (tool as { name?: string }).name === name
    );
  }
  if (typeof tools === "object") {
    return (tools as Record<string, unknown>)[name];
  }
  return undefined;
}

if (process.env.EXOCORTEX_MCP_NO_AUTOSTART !== "1") {
  main().catch((err) => {
    console.error("Exocortex MCP server failed to start:", err);
    process.exit(1);
  });
}
