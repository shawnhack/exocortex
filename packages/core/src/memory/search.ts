import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getEmbeddingProvider } from "../embedding/manager.js";
import type { SearchQuery, SearchResult, MemoryRow } from "./types.js";
import { getSetting, safeJsonParse } from "../db/schema.js";
import {
  cosineSimilarity,
  recencyScore,
  frequencyScore,
  usefulnessScore,
  valenceScore,
  qualityScore,
  goalRelevanceScore,
  tierBoost,
  computeHybridScore,
  getWeights,
  getRRFConfig,
  reciprocalRankFusion,
} from "./scoring.js";
import { EntityStore } from "../entities/store.js";
import { GoalStore } from "../goals/store.js";
import { MemoryLinkStore } from "./links.js";
import { getTagAliasMap, normalizeTags } from "./tag-normalization.js";
import { getMetadataTags } from "./metadata-classification.js";
import { incrementCounter } from "../observability/counters.js";
import type { RerankerProvider } from "./reranker.js";
import { isRerankEnabled, getRerankLimit, rerankResults } from "./reranker.js";

interface FtsMatch {
  rowid: number;
  rank: number;
}

export interface SearchMissAggregate {
  query: string;
  count: number;
  avg_max_score: number | null;
  last_seen: string;
}

export function getSearchMisses(
  db: DatabaseSync,
  limit = 10,
  sinceDays = 7
): SearchMissAggregate[] {
  const since = new Date(Date.now() - sinceDays * 86400000)
    .toISOString()
    .replace("T", " ")
    .replace("Z", "");

  return db
    .prepare(
      `SELECT query, COUNT(*) as count, AVG(max_score) as avg_max_score,
              MAX(created_at) as last_seen
       FROM search_misses
       WHERE created_at >= ?
       GROUP BY query
       ORDER BY count DESC
       LIMIT ?`
    )
    .all(since, limit) as unknown as SearchMissAggregate[];
}

export class MemorySearch {
  constructor(private db: DatabaseSync) {}

  async search(query: SearchQuery, reranker?: RerankerProvider): Promise<SearchResult[]> {
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;
    const weights = getWeights(this.db);
    const aliasMap = getTagAliasMap(this.db);
    const normalizedTagFilter = normalizeTags(query.tags, aliasMap);
    const metadataTags = getMetadataTags(this.db, aliasMap);
    const metadataMode = (getSetting(this.db, "search.metadata_mode") ?? "penalize").toLowerCase();
    const rawPenalty = parseFloat(getSetting(this.db, "search.metadata_penalty") ?? "0.35");
    const metadataPenalty = Number.isFinite(rawPenalty)
      ? Math.max(0, Math.min(rawPenalty, 1))
      : 0.35;
    const metadataRequested = this.isMetadataExplicitlyRequested(
      query,
      metadataTags,
      aliasMap
    );

    // Goal-gated retrieval: build keyword set from active goals
    let goalKeywords = new Set<string>();
    if (weights.goalGated > 0) {
      try {
        const goalStore = new GoalStore(this.db);
        const activeGoals = goalStore.list("active");
        const STOP = new Set(["the","a","an","and","or","of","to","in","for","is","on","v1","v2"]);
        for (const goal of activeGoals) {
          const words = goal.title.toLowerCase().split(/[\s\-_/]+/).filter((w: string) => w.length >= 2 && !STOP.has(w));
          for (const w of words) goalKeywords.add(w);
          const milestones = goalStore.getMilestones(goal.id);
          for (const m of milestones) {
            const mWords = m.title.toLowerCase().split(/[\s\-_/]+/).filter((w: string) => w.length >= 2 && !STOP.has(w));
            for (const w of mWords) goalKeywords.add(w);
          }
        }
      } catch (err) {
        console.warn("[search] Goal keyword extraction failed:", (err as Error).message);
      }
    }

    // Build WHERE clauses for filtering
    const conditions: string[] = ["m.is_active = 1", "m.parent_id IS NULL"];
    const params: (string | number)[] = [];

    if (query.content_type) {
      conditions.push("m.content_type = ?");
      params.push(query.content_type);
    }

    if (query.source) {
      conditions.push("m.source = ?");
      params.push(query.source);
    }

    if (query.after) {
      conditions.push("m.created_at >= ?");
      params.push(query.after);
    }

    if (query.before) {
      conditions.push("m.created_at <= ?");
      params.push(query.before);
    }

    if (query.min_importance !== undefined) {
      conditions.push("m.importance >= ?");
      params.push(query.min_importance);
    }

    if (normalizedTagFilter.length > 0) {
      const placeholders = normalizedTagFilter.map(() => "?").join(", ");
      conditions.push(
        `m.id IN (SELECT memory_id FROM memory_tags WHERE tag IN (${placeholders}))`
      );
      params.push(...normalizedTagFilter);
    }

    if (query.namespace) {
      conditions.push("m.namespace = ?");
      params.push(query.namespace);
    }

    if (query.tier) {
      conditions.push("m.tier = ?");
      params.push(query.tier);
    }

    // Working-tier memories are session-scoped: exclude from general search
    // unless explicitly filtered to working tier or same session
    if (!query.tier || query.tier !== "working") {
      if (query.session_id) {
        conditions.push("(m.tier != 'working' OR m.session_id = ?)");
        params.push(query.session_id);
      } else {
        conditions.push("m.tier != 'working'");
      }
    }

    let excludedMetadataCount = 0;
    if (!metadataRequested && metadataMode === "exclude") {
      if (metadataTags.size > 0) {
        try {
          const baseWhere = conditions.join(" AND ");
          const excluded = this.db
            .prepare(
              `SELECT COUNT(*) as count FROM memories m WHERE ${baseWhere} AND m.is_metadata = 1`
            )
            .get(...params) as { count: number };
          excludedMetadataCount = excluded.count ?? 0;
        } catch {
          excludedMetadataCount = 0;
        }
      }
      conditions.push("m.is_metadata = 0");
      incrementCounter(this.db, "search.metadata_excluded_queries");
    }

    const whereClause = conditions.join(" AND ");

    // Candidate pool: fetch enough rows for scoring, but cap proportionally
    const candidateLimit = Math.min(1000, Math.max(100, (offset + limit) * 10));

    // Use LLM-provided expanded query for richer retrieval if supplied,
    // otherwise auto-generate heuristic rephrasings.
    // Auto expansion is embedding-only — injecting synonyms into FTS reduces
    // precision because FTS scores all terms equally. Embeddings handle synonyms
    // naturally via vector similarity.
    const autoExpansion = !query.expanded_query
      ? this.generateAutoExpansion(query.query)
      : null;

    // Entity graph expansion runs on original query + LLM-provided expansion (if any),
    // but NOT on auto-generated heuristic expansion (those are embedding-only)
    const entityExpandBase = query.expanded_query
      ? `${query.query} ${query.expanded_query}`
      : query.query;
    const expansion = this.expandQuery(entityExpandBase);

    // Build embedding text: original query + all expansion sources
    const expansionParts = [query.query];
    if (query.expanded_query) expansionParts.push(query.expanded_query);
    if (autoExpansion) expansionParts.push(autoExpansion);
    if (expansion) expansionParts.push(expansion.expandedTerms.join(" "));
    const embeddingText = expansionParts.join(" ");

    // FTS stays on original query + entity graph terms only (no auto expansion)
    const ftsText = query.query;
    const extraFtsTerms = expansion ? expansion.expandedTerms : [];

    // Get FTS matches using two-pass AND+OR search
    // Uses String() keys to avoid BigInt/Number mismatch from node:sqlite
    const rawKeywordBoost = parseFloat(getSetting(this.db, "scoring.keyword_boost") ?? "2.0");
    const keywordBoost = Number.isFinite(rawKeywordBoost) ? rawKeywordBoost : 2.0;

    // Build full FTS text with entity expansion terms
    let fullFtsText = ftsText;
    if (extraFtsTerms.length > 0) {
      fullFtsText = `${ftsText} ${extraFtsTerms.join(" ")}`;
    }

    const { matches: ftsMatches, rowids: ftsRowids } = this.twoPassFts(fullFtsText, keywordBoost);

    // Build candidate pool: FTS matches + recent memories
    // This ensures keyword-matched older memories are always included
    let rows: (MemoryRow & { _rowid: number })[];

    if (ftsRowids.length > 0) {
      // Fetch FTS-matched rows that pass filters
      const ftsPlaceholders = ftsRowids.map(() => "?").join(", ");
      const ftsMatchRows = this.db
        .prepare(
          `SELECT m.*, m.rowid as _rowid FROM memories m WHERE ${whereClause} AND m.rowid IN (${ftsPlaceholders})`
        )
        .all(...params, ...ftsRowids) as unknown as (MemoryRow & { _rowid: number })[];

      const ftsIds = new Set(ftsMatchRows.map((r) => r.id));

      // Fill remaining pool with recent memories (excluding FTS matches)
      const recentLimit = Math.max(0, candidateLimit - ftsMatchRows.length);
      let recentRows: (MemoryRow & { _rowid: number })[] = [];
      if (recentLimit > 0) {
        recentRows = this.db
          .prepare(
            `SELECT m.*, m.rowid as _rowid FROM memories m WHERE ${whereClause} ORDER BY created_at DESC LIMIT ${recentLimit}`
          )
          .all(...params) as unknown as (MemoryRow & { _rowid: number })[];
        recentRows = recentRows.filter((r) => !ftsIds.has(r.id));
      }

      rows = [...ftsMatchRows, ...recentRows];
    } else {
      rows = this.db
        .prepare(
          `SELECT m.*, m.rowid as _rowid FROM memories m WHERE ${whereClause} ORDER BY created_at DESC LIMIT ${candidateLimit}`
        )
        .all(...params) as unknown as (MemoryRow & { _rowid: number })[];
    }

    if (excludedMetadataCount > 0) {
      incrementCounter(this.db, "search.metadata_excluded_memories", excludedMetadataCount);
    }

    if (rows.length === 0) return [];

    // Get query embedding (use expanded text if available)
    let queryEmbedding: Float32Array | null = null;
    let searchMode: "hybrid" | "fts_only" = "hybrid";
    try {
      const provider = await getEmbeddingProvider();
      queryEmbedding = await provider.embed(embeddingText);
    } catch {
      // Fall back to FTS-only if embedding fails
      searchMode = "fts_only";
    }

    // Configurable min_score threshold (query param overrides setting)
    const parsedMinScore = parseFloat(getSetting(this.db, "scoring.min_score") ?? "0.15");
    const minScore = query.min_score ??
      (Number.isFinite(parsedMinScore) ? parsedMinScore : 0.15);

    // Tag boost weight
    const parsedTagBoost = parseFloat(
      getSetting(this.db, "scoring.tag_boost") ?? "0.10"
    );
    const tagBoost = Number.isFinite(parsedTagBoost) ? parsedTagBoost : 0.10;

    // Batch-fetch tags for ALL candidates (needed for tag boosting)
    const candidateTagMap = new Map<string, string[]>();
    if (rows.length > 0 && tagBoost > 0) {
      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(", ");
      const tagRows = this.db
        .prepare(`SELECT memory_id, tag FROM memory_tags WHERE memory_id IN (${placeholders})`)
        .all(...ids) as Array<{ memory_id: string; tag: string }>;
      for (const t of tagRows) {
        const arr = candidateTagMap.get(t.memory_id);
        if (arr) arr.push(t.tag);
        else candidateTagMap.set(t.memory_id, [t.tag]);
      }
    }

    // Extract query terms for tag matching (lowercase, >2 chars)
    const queryTerms = query.query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2);

    // Get max access count for frequency normalization
    const maxAccess = this.db
      .prepare("SELECT MAX(access_count) as max FROM memories WHERE is_active = 1")
      .get() as { max: number | null };
    const maxAccessCount = maxAccess?.max ?? 0;

    // Batch-fetch link counts for quality score computation — only needed
    // when some rows lack a persisted quality_score
    const linkCountMap = new Map<string, number>();
    const needsQualityCompute = rows.some((r) => r.quality_score == null);
    if (rows.length > 0 && weights.quality > 0 && needsQualityCompute) {
      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(", ");
      const linkRows = this.db
        .prepare(
          `SELECT id, COUNT(*) as lc FROM (
            SELECT source_id as id FROM memory_links WHERE source_id IN (${placeholders})
            UNION ALL
            SELECT target_id as id FROM memory_links WHERE target_id IN (${placeholders})
          ) GROUP BY id`
        )
        .all(...ids, ...ids) as Array<{ id: string; lc: number }>;
      for (const lr of linkRows) {
        linkCountMap.set(lr.id, lr.lc);
      }
    }

    // Compute per-candidate component scores
    const now = Date.now();
    const candidates: Array<{
      row: MemoryRow & { _rowid: number };
      vectorScore: number;
      ftsScore: number;
      recency: number;
      freq: number;
      usefulness: number;
      valence: number;
      quality: number;
      goalRelevance: number;
    }> = [];

    for (const row of rows) {
      let vectorScore = 0;
      if (queryEmbedding && row.embedding) {
        const bytes = row.embedding as unknown as Uint8Array;
        const memEmbedding = new Float32Array(new Uint8Array(bytes).buffer);
        vectorScore = Math.max(0, cosineSimilarity(queryEmbedding, memEmbedding));
      }

      const ftsScore = ftsMatches.get(String(row._rowid)) ?? 0;
      const recency = recencyScore(row.created_at, weights.recencyDecay, row.importance, row.quality_score ?? undefined);
      const freq = frequencyScore(row.access_count, maxAccessCount);
      const usefulCount = row.useful_count ?? 0;
      const usefulness = usefulnessScore(usefulCount);
      const valence = valenceScore(row.valence ?? 0);
      const memTags = candidateTagMap.get(row.id) ?? [];
      const goalRelevance = goalRelevanceScore(memTags, goalKeywords, row.content);
      const persistedQuality = row.quality_score;
      let quality: number;
      if (persistedQuality != null) {
        quality = persistedQuality;
      } else {
        const ageDays = (now - new Date(row.created_at + "Z").getTime()) / (1000 * 60 * 60 * 24);
        quality = qualityScore(row.importance, usefulCount, row.access_count, linkCountMap.get(row.id) ?? 0, ageDays);
      }

      candidates.push({ row, vectorScore, ftsScore, recency, freq, usefulness, valence, quality, goalRelevance });
    }

    // Supersession demotion: memories with superseded_by set get heavily penalized
    // so obsolete decisions/approaches don't clutter results
    const supersededIds = new Set<string>();
    for (const c of candidates) {
      if (c.row.superseded_by) supersededIds.add(c.row.id);
    }

    // Graph-proximity scores (if weight > 0)
    // Use a pre-pass: sort candidates by vector+fts to find top seeds for link proximity
    let graphScores = new Map<string, number>();
    if (weights.graph > 0) {
      const preSorted = [...candidates]
        .sort((a, b) => (b.vectorScore + b.ftsScore) - (a.vectorScore + a.ftsScore));
      const topSeedIds = preSorted.slice(0, 20).filter((c) => c.vectorScore > 0 || c.ftsScore > 0).map((c) => c.row.id);
      graphScores = this.getGraphProximityScores(query.query, candidates.map((c) => c.row.id), topSeedIds);
    }

    // RRF or legacy scoring
    const rrfConfig = getRRFConfig(this.db);
    let scored: Array<{ row: MemoryRow & { _rowid: number }; score: number; vectorScore: number; ftsScore: number; recency: number; freq: number; usefulness: number; valence: number; quality: number; goalRelevance: number }> = [];
    let penalizedMetadataCount = 0;

    if (rrfConfig.enabled) {
      // Build ranked lists from candidates with non-zero scores
      const vectorList = candidates
        .filter((c) => c.vectorScore > 0)
        .map((c) => ({ id: c.row.id, score: c.vectorScore }));
      const ftsList = candidates
        .filter((c) => c.ftsScore > 0)
        .map((c) => ({ id: c.row.id, score: c.ftsScore }));

      const rankedLists = [
        { entries: vectorList, weight: weights.vector },
        { entries: ftsList, weight: weights.fts },
      ];

      // Add graph-proximity as a ranked list if enabled
      if (graphScores.size > 0) {
        const graphList = Array.from(graphScores.entries())
          .map(([id, score]) => ({ id, score }));
        rankedLists.push({ entries: graphList, weight: weights.graph });
      }

      const rrfScores = reciprocalRankFusion(rankedLists, rrfConfig.k);

      // RRF min_score (query param overrides setting, but use RRF-specific default)
      const parsedRrfMinScore = parseFloat(getSetting(this.db, "scoring.rrf_min_score") ?? "0.001");
      const rrfMinScore = query.min_score ??
        (Number.isFinite(parsedRrfMinScore) ? parsedRrfMinScore : 0.001);

      // Find max RRF score for proportional tag boost
      let maxRrf = 0;
      for (const s of rrfScores.values()) {
        if (s > maxRrf) maxRrf = s;
      }

      for (const c of candidates) {
        let baseRrf = rrfScores.get(c.row.id) ?? 0;
        const memTags = candidateTagMap.get(c.row.id) ?? [];
        const hasQueryTagMatch =
          queryTerms.length > 0 &&
          queryTerms.some((term) => memTags.some((tag) => tag.includes(term)));

        // Tag-only fallback: allow retrieval of explicitly tag-filtered memories
        // even when they have no vector/FTS score (e.g. benchmark artifacts).
        if (baseRrf === 0) {
          const hasTagFilterMatch =
            normalizedTagFilter.length > 0 &&
            normalizedTagFilter.some((tag) => memTags.includes(tag));
          if (hasTagFilterMatch) {
            baseRrf = 1 / (rrfConfig.k + 1);
          } else if (hasQueryTagMatch) {
            // Use count of RRF-scored results as rank position (stable regardless of total candidates)
            const rrfScoredCount = rrfScores.size;
            const denominator = rrfConfig.k + Math.max(10, rrfScoredCount) + 1;
            baseRrf = 1 / denominator;
          }
        }

        // Post-RRF multiplicative boost from recency + frequency + usefulness + valence + quality + importance + tier
        const memTier = c.row.tier ?? "episodic";
        const boostMultiplier = 1 + weights.recency * c.recency + weights.frequency * c.freq + weights.usefulness * c.usefulness + weights.valence * c.valence + weights.quality * c.quality + weights.goalGated * c.goalRelevance + weights.importance * c.row.importance + tierBoost(memTier);
        let score = baseRrf * boostMultiplier;

        // Superseded memories get 80% demotion (before tag boost so tags can't undo it)
        if (supersededIds.has(c.row.id)) {
          score *= 0.2;
        }

        // Tag boost scaled to RRF range
        if (tagBoost > 0 && hasQueryTagMatch) {
          const scale = maxRrf > 0 ? maxRrf : 1 / (rrfConfig.k + 1);
          score += tagBoost * scale;
        }

        if (
          !metadataRequested &&
          metadataMode !== "exclude" &&
          metadataPenalty < 1 &&
          c.row.is_metadata === 1
        ) {
          penalizedMetadataCount++;
          score *= metadataPenalty;
        }

        if (score >= rrfMinScore) {
          scored.push({ row: c.row, score, vectorScore: c.vectorScore, ftsScore: c.ftsScore, recency: c.recency, freq: c.freq, usefulness: c.usefulness, valence: c.valence, quality: c.quality, goalRelevance: c.goalRelevance });
        }
      }
    } else {
      // Legacy weighted average scoring
      for (const c of candidates) {
        let score = computeHybridScore(
          c.vectorScore,
          c.ftsScore,
          c.recency,
          c.freq,
          weights
        );

        // Additive usefulness + valence + quality + importance + goal + tier boosts
        score += weights.usefulness * c.usefulness;
        score += weights.valence * c.valence;
        score += weights.quality * c.quality;
        score += weights.importance * c.row.importance;
        score += weights.goalGated * c.goalRelevance;
        const memTierLegacy = c.row.tier ?? "episodic";
        score *= (1 + tierBoost(memTierLegacy));

        if (tagBoost > 0 && queryTerms.length > 0) {
          const memTags = candidateTagMap.get(c.row.id);
          if (memTags) {
            const hasMatch = queryTerms.some((term) =>
              memTags.some((tag) => tag.includes(term))
            );
            if (hasMatch) {
              score += tagBoost;
            }
          }
        }

        // Superseded memories get 80% demotion (before tag boost so tags can't undo it)
        if (supersededIds.has(c.row.id)) {
          score *= 0.2;
        }

        if (
          !metadataRequested &&
          metadataMode !== "exclude" &&
          metadataPenalty < 1 &&
          c.row.is_metadata === 1
        ) {
          penalizedMetadataCount++;
          score *= metadataPenalty;
        }

        if (score >= minScore) {
          scored.push({ row: c.row, score, vectorScore: c.vectorScore, ftsScore: c.ftsScore, recency: c.recency, freq: c.freq, usefulness: c.usefulness, valence: c.valence, quality: c.quality, goalRelevance: c.goalRelevance });
        }
      }
    }

    if (
      !metadataRequested &&
      metadataMode !== "exclude" &&
      metadataPenalty < 1 &&
      penalizedMetadataCount > 0
    ) {
      incrementCounter(this.db, "search.metadata_penalized_queries");
      incrementCounter(this.db, "search.metadata_penalized_memories", penalizedMetadataCount);
    }

    // Sort by score descending, with deterministic tie-breaking by ID
    scored.sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id));

    // Supersession dedup: if a superseded memory and its replacement both appear,
    // drop the superseded one entirely instead of just demoting it
    const resultIds = new Set(scored.map(s => s.row.id));
    scored = scored.filter(s => {
      const supersededBy = s.row.superseded_by;
      if (supersededBy && resultIds.has(supersededBy)) {
        return false; // replacement is present — drop the stale version
      }
      return true;
    });

    // Confidence gap filter: remove results far below the top score
    const parsedGapRatio = parseFloat(getSetting(this.db, "search.score_gap_ratio") ?? "0.15");
    const gapRatio = Number.isFinite(parsedGapRatio) ? parsedGapRatio : 0.15;
    const parsedQualityFloor = parseFloat(getSetting(this.db, "search.quality_floor") ?? "0.08");
    const qualityFloor = Number.isFinite(parsedQualityFloor) ? parsedQualityFloor : 0.08;
    const topScore = scored[0]?.score ?? 0;
    if (topScore > 0) {
      const minAllowed = topScore * gapRatio;
      scored = scored.filter(s => s.score >= minAllowed && s.quality >= qualityFloor);
    }

    // Optional LLM re-ranking (qmd-inspired)
    // Only runs when enabled in settings AND a reranker provider is supplied
    let rerankApplied = false;
    if (reranker && isRerankEnabled(this.db) && scored.length > 1) {
      try {
        const rerankLimit = getRerankLimit(this.db);
        const toRerank = scored.slice(0, rerankLimit);
        const contents = toRerank.map(s => s.row.content);
        const reranked = await rerankResults(query.query, contents, reranker, rerankLimit);

        // Blend rerank scores with existing scores (60% original, 40% rerank)
        for (const rr of reranked) {
          if (rr.index < toRerank.length) {
            toRerank[rr.index].score = toRerank[rr.index].score * 0.6 + rr.rerankScore * 0.4;
          }
        }

        // Re-sort after blending
        scored.sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id));
        rerankApplied = true;
      } catch {
        // Re-ranking failure is non-critical — fall through to original order
      }
    }

    // Apply offset + limit
    const page = scored.slice(offset, offset + limit);

    // Build tag map for final results — reuse candidateTagMap if available, otherwise fetch
    let tagMap: Map<string, string[]>;
    if (candidateTagMap.size > 0) {
      tagMap = candidateTagMap;
    } else {
      tagMap = new Map();
      if (page.length > 0) {
        const ids = page.map((p) => p.row.id);
        const placeholders = ids.map(() => "?").join(", ");
        const tagRows = this.db
          .prepare(`SELECT memory_id, tag FROM memory_tags WHERE memory_id IN (${placeholders})`)
          .all(...ids) as Array<{ memory_id: string; tag: string }>;
        for (const t of tagRows) {
          const arr = tagMap.get(t.memory_id);
          if (arr) arr.push(t.tag);
          else tagMap.set(t.memory_id, [t.tag]);
        }
      }
    }

    // Log search miss if no results after scoring
    if (page.length === 0) {
      const maxScore = scored.length > 0 ? scored[0].score : null;
      this.logSearchMiss(query.query, scored.length, maxScore, query);
    }

    // Track co-retrieval for link building
    if (page.length >= 2) {
      this.trackCoRetrieval(query.query, page.map((p) => p.row.id));
    }

    // Track query outcome analytics
    this.trackQueryOutcome(query.query, page.length);

    return page.map((p) => {
      const {
        _rowid,
        metadata: rawMeta,
        content_hash: _contentHash,
        is_indexed: _isIndexed,
        is_metadata: isMetadata,
        ...row
      } = p.row;
      return {
        memory: {
          ...row,
          embedding: null,
          is_metadata: isMetadata === 1,
          is_active: row.is_active === 1,
          superseded_by: row.superseded_by ?? null,
          chunk_index: row.chunk_index ?? null,
          keywords: row.keywords ?? undefined,
          metadata: safeJsonParse<Record<string, unknown> | undefined>(rawMeta, undefined),
          tier: (p.row.tier ?? "episodic") as import("./types.js").MemoryTier,
          tags: tagMap.get(row.id) ?? [],
        },
        score: p.score,
        vector_score: p.vectorScore,
        fts_score: p.ftsScore,
        recency_score: p.recency,
        frequency_score: p.freq,
        search_mode: searchMode,
        reranked: rerankApplied,
        score_breakdown: {
          usefulness: p.usefulness,
          valence: p.valence,
          quality: p.quality,
          importance: p.row.importance,
          goal_relevance: p.goalRelevance,
          graph: graphScores.get(p.row.id) ?? 0,
        },
      };
    });
  }

  private isMetadataExplicitlyRequested(
    query: SearchQuery,
    metadataTags: Set<string>,
    aliasMap: Record<string, string>
  ): boolean {
    if (query.include_metadata === true) return true;

    if (query.tags && query.tags.length > 0) {
      const requested = new Set(normalizeTags(query.tags, aliasMap));
      for (const tag of requested) {
        if (metadataTags.has(tag)) return true;
      }
    }

    const q = query.query.toLowerCase();
    for (const tag of metadataTags) {
      if (q.includes(tag) || q.includes(tag.replace(/-/g, " "))) {
        return true;
      }
    }

    return false;
  }

  private logSearchMiss(
    query: string,
    resultCount: number,
    maxScore: number | null,
    filters: SearchQuery
  ): void {
    try {
      const filterObj: Record<string, unknown> = {};
      if (filters.tags) filterObj.tags = filters.tags;
      if (filters.content_type) filterObj.content_type = filters.content_type;
      if (filters.after) filterObj.after = filters.after;
      if (filters.before) filterObj.before = filters.before;

      const filterStr = Object.keys(filterObj).length > 0
        ? JSON.stringify(filterObj)
        : null;

      this.db
        .prepare(
          `INSERT INTO search_misses (query, result_count, max_score, filters)
           VALUES (?, ?, ?, ?)`
        )
        .run(query, resultCount, maxScore, filterStr);
    } catch {
      // Non-critical — don't fail searches over logging
    }
  }

  private getGraphProximityScores(
    query: string,
    candidateIds: string[],
    topScoredIds: string[]
  ): Map<string, number> {
    const scores = new Map<string, number>();
    const candidateSet = new Set(candidateIds);

    // --- Entity-graph proximity ---
    const entityStore = new EntityStore(this.db);
    const words = query
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .map((w) => w.toLowerCase());

    const queryEntities: string[] = [];
    for (const word of words) {
      const entity = entityStore.getByName(word);
      if (entity) queryEntities.push(entity.id);
    }

    if (queryEntities.length > 0) {
      // Direct-linked memories (1-hop) score 1.0
      for (const entityId of queryEntities) {
        const memoryIds = entityStore.getMemoriesForEntity(entityId);
        for (const mid of memoryIds) {
          if (candidateSet.has(mid)) {
            scores.set(mid, Math.max(scores.get(mid) ?? 0, 1.0));
          }
        }
      }

      // Indirect memories (2-hop via related entities) score 0.5
      for (const entityId of queryEntities) {
        const related = entityStore.getRelatedEntities(entityId);
        let count = 0;
        for (const rel of related) {
          if (count >= 10) break;
          const memoryIds = entityStore.getMemoriesForEntity(rel.entity.id);
          for (const mid of memoryIds) {
            if (candidateSet.has(mid) && !scores.has(mid)) {
              scores.set(mid, 0.5);
            }
          }
          count++;
        }
      }
    }

    // --- Memory-link proximity ---
    // Candidates linked to top-scoring results get a boost
    if (topScoredIds.length > 0) {
      const linkStore = new MemoryLinkStore(this.db);
      const refs = linkStore.getLinkedRefs(topScoredIds);
      for (const ref of refs) {
        if (candidateSet.has(ref.id)) {
          if (ref.link_type === "supersedes") {
            // The linked memory was superseded by a top result — demote it heavily
            scores.set(ref.id, Math.min(scores.get(ref.id) ?? 0.1, 0.1));
          } else {
            // Strength-weighted score (0.3-0.8 range based on link strength)
            const linkScore = 0.3 + ref.strength * 0.5;
            scores.set(ref.id, Math.max(scores.get(ref.id) ?? 0, linkScore));
          }
        }
      }
    }

    return scores;
  }

  private buildReverseTagAliasMap(
    aliasMap: Record<string, string>
  ): Map<string, string[]> {
    const reverse = new Map<string, string[]>();
    for (const [alias, canonical] of Object.entries(aliasMap)) {
      const arr = reverse.get(canonical);
      if (arr) arr.push(alias);
      else reverse.set(canonical, [alias]);
    }
    return reverse;
  }

  /**
   * Generate heuristic-based query expansion when no explicit expanded_query is provided.
   * Produces synonyms and morphological variants for common domain terms.
   */
  private generateAutoExpansion(query: string): string | null {
    const enabled = getSetting(this.db, "search.auto_expansion");
    if (enabled?.toLowerCase() === "false") return null;

    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (words.length === 0) return null;

    // Domain synonym map — covers terms that actually caused search friction
    const SYNONYMS: Record<string, string[]> = {
      export: ["generate", "output", "vault", "pipeline"],
      import: ["ingest", "load", "parse"],
      obsidian: ["vault", "markdown", "wikilink"],
      gardening: ["maintenance", "cleanup", "consolidation", "pruning"],
      consolidation: ["merge", "gardening", "clustering"],
      maintenance: ["gardening", "cleanup", "upkeep"],
      audit: ["review", "check", "inspect", "verify"],
      compile: ["build", "generate", "assemble"],
      wiki: ["article", "documentation", "knowledge"],
      optimize: ["tuning", "improve", "enhance"],
      retrieval: ["search", "recall", "finding"],
      search: ["retrieval", "query", "find"],
      friction: ["miss", "gap", "failure"],
      quality: ["score", "health", "metric"],
      prediction: ["forecast", "estimate", "calibration"],
      goal: ["objective", "milestone", "target"],
      technique: ["learning", "pattern", "how-to"],
      bug: ["fix", "error", "issue", "broken"],
      decision: ["chose", "selected", "architecture"],
    };

    const expansions = new Set<string>();
    for (const word of words) {
      const synonyms = SYNONYMS[word];
      if (synonyms) {
        for (const syn of synonyms) {
          if (!words.includes(syn)) {
            expansions.add(syn);
          }
        }
      }
    }

    // Also generate compound forms — join adjacent words with hyphens
    // since tags often use kebab-case (e.g., "memory gardening" → "memory-gardening")
    if (words.length >= 2) {
      for (let i = 0; i < words.length - 1; i++) {
        expansions.add(`${words[i]}-${words[i + 1]}`);
      }
    }

    if (expansions.size === 0) return null;

    // Cap at 8 terms to avoid noise
    return Array.from(expansions).slice(0, 8).join(" ");
  }

  private expandQuery(
    query: string
  ): { expandedText: string; expandedTerms: string[] } | null {
    const enabled = getSetting(this.db, "search.query_expansion");
    if (enabled !== "true") return null;

    const maxTerms = parseInt(
      getSetting(this.db, "search.expansion_max_terms") ?? "15",
      10
    );

    const words = query
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .map((w) => w.toLowerCase());

    if (words.length === 0) return null;

    const entityStore = new EntityStore(this.db);
    const additionalTerms = new Set<string>();
    const queryLower = query.toLowerCase();

    // (a) Single-word entity matching (existing logic)
    for (const word of words) {
      const entity = entityStore.getByName(word);
      if (!entity) continue;

      for (const alias of entity.aliases) {
        const aliasLower = alias.toLowerCase();
        if (!queryLower.includes(aliasLower)) {
          additionalTerms.add(alias);
        }
      }

      const related = entityStore.getRelatedEntities(entity.id);
      let count = 0;
      for (const rel of related) {
        if (count >= 5) break;
        const relNameLower = rel.entity.name.toLowerCase();
        if (!queryLower.includes(relNameLower)) {
          additionalTerms.add(rel.entity.name);
          count++;
        }
      }
    }

    // (a) N-gram entity matching (2-word and 3-word)
    for (const n of [2, 3]) {
      for (let i = 0; i <= words.length - n; i++) {
        const ngram = words.slice(i, i + n).join(" ");
        const entity = entityStore.getByName(ngram);
        if (!entity) continue;

        for (const alias of entity.aliases) {
          const aliasLower = alias.toLowerCase();
          if (!queryLower.includes(aliasLower)) {
            additionalTerms.add(alias);
          }
        }

        const related = entityStore.getRelatedEntities(entity.id);
        let count = 0;
        for (const rel of related) {
          if (count >= 5) break;
          const relNameLower = rel.entity.name.toLowerCase();
          if (!queryLower.includes(relNameLower)) {
            additionalTerms.add(rel.entity.name);
            count++;
          }
        }
      }
    }

    // (b) Bidirectional tag alias expansion
    const aliasMap = getTagAliasMap(this.db);
    const reverseMap = this.buildReverseTagAliasMap(aliasMap);
    for (const word of words) {
      // alias -> canonical
      if (aliasMap[word] && !queryLower.includes(aliasMap[word])) {
        additionalTerms.add(aliasMap[word]);
      }
      // canonical -> all aliases
      const aliases = reverseMap.get(word);
      if (aliases) {
        for (const alias of aliases) {
          if (!queryLower.includes(alias)) {
            additionalTerms.add(alias);
          }
        }
      }
    }

    // (c) Zero-FTS keyword fallback
    if (additionalTerms.size === 0) {
      let ftsHasResults = false;
      try {
        const ftsQuery = this.sanitizeFtsQuery(query);
        const ftsRows = this.db
          .prepare(
            "SELECT rowid FROM memories_fts WHERE memories_fts MATCH ? LIMIT 1"
          )
          .all(ftsQuery) as unknown[];
        ftsHasResults = ftsRows.length > 0;
      } catch {
        // FTS may fail on unusual input
      }

      if (!ftsHasResults) {
        try {
          const recentRows = this.db
            .prepare(
              "SELECT content FROM memories WHERE is_active = 1 ORDER BY created_at DESC LIMIT 10"
            )
            .all() as Array<{ content: string }>;
          const extraTerms = new Set<string>();
          for (const row of recentRows) {
            const contentWords = row.content
              .split(/\s+/)
              .map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, ""))
              .filter((w) => w.length > 3);
            for (const cw of contentWords) {
              if (extraTerms.size >= 5) break;
              for (const qw of words) {
                if (
                  cw.length >= 4 &&
                  qw.length >= 4 &&
                  cw.slice(0, 4) === qw.slice(0, 4) &&
                  cw !== qw
                ) {
                  extraTerms.add(cw);
                  break;
                }
              }
            }
            if (extraTerms.size >= 5) break;
          }
          for (const t of extraTerms) {
            additionalTerms.add(t);
          }
        } catch {
          // Non-critical
        }
      }
    }

    if (additionalTerms.size === 0) return null;

    // (d) Cap total expansion terms
    const terms = Array.from(additionalTerms).slice(0, maxTerms);
    return {
      expandedText: `${query} ${terms.join(" ")}`,
      expandedTerms: terms,
    };
  }

  private trackCoRetrieval(query: string, resultIds: string[]): void {
    try {
      const hash = createHash("sha256").update(query).digest("hex").slice(0, 16);
      const top10 = resultIds.slice(0, 10);
      this.db
        .prepare(
          "INSERT INTO co_retrievals (query_hash, memory_ids, result_count) VALUES (?, ?, ?)"
        )
        .run(hash, JSON.stringify(top10), top10.length);
    } catch {
      // Non-critical — don't fail searches over tracking
    }
  }

  private trackQueryOutcome(query: string, resultCount: number): void {
    try {
      const hash = createHash("sha256")
        .update(query.toLowerCase().trim())
        .digest("hex")
        .slice(0, 16);
      const now = new Date().toISOString().replace("T", " ").replace("Z", "");

      // Upsert: increment search_count, update rolling average result_count
      const existing = this.db
        .prepare("SELECT id, search_count, result_count_avg FROM query_outcomes WHERE query_hash = ?")
        .get(hash) as { id: number; search_count: number; result_count_avg: number } | undefined;

      if (existing) {
        const newCount = existing.search_count + 1;
        const newAvg =
          (existing.result_count_avg * existing.search_count + resultCount) / newCount;
        this.db
          .prepare(
            "UPDATE query_outcomes SET search_count = ?, result_count_avg = ?, last_queried_at = ? WHERE query_hash = ?"
          )
          .run(newCount, newAvg, now, hash);
      } else {
        this.db
          .prepare(
            "INSERT INTO query_outcomes (query_hash, query, search_count, result_count_avg, last_queried_at) VALUES (?, ?, 1, ?, ?)"
          )
          .run(hash, query, resultCount, now);
      }
    } catch {
      // Non-critical
    }
  }

  /** Stopwords that pollute FTS results when used as query terms */
  private static readonly FTS_STOPWORDS = new Set([
    "what", "when", "where", "who", "how", "did", "was", "the", "are", "has", "have",
    "does", "can", "will", "about", "with", "from", "that", "this", "for", "you", "your",
    "would", "could", "should", "some", "any", "been", "being", "more", "also", "into",
    "than", "then", "there", "their", "which", "were", "they", "them", "very", "just",
    "but", "not", "all", "its", "his", "her", "our", "she", "him", "had", "may", "might",
    "still", "recommend", "suggest", "give", "tell",
  ]);

  private sanitizeFtsQuery(query: string): string {
    // Escape special FTS5 characters
    const cleaned = query
      .replace(/['"(){}[\]*:^~!@#$%&\\]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!cleaned) return '""';

    // Remove stopwords for better precision
    const terms = cleaned.split(" ")
      .filter(Boolean)
      .filter((t) => !MemorySearch.FTS_STOPWORDS.has(t.toLowerCase()));

    if (terms.length === 0) {
      // All words were stopwords — fall back to original terms
      const fallback = cleaned.split(" ").filter(Boolean);
      return fallback.map((t) => `"${t}"`).join(" OR ");
    }
    if (terms.length === 1) return `"${terms[0]}"`;

    return terms.map((t) => `"${t}"`).join(" OR ");
  }

  /**
   * Two-pass FTS query: AND first (high precision), then OR (high recall).
   * Returns merged match map with AND results getting a precision bonus.
   */
  private twoPassFts(query: string, keywordBoost: number): { matches: Map<string, number>; rowids: number[] } {
    const matches = new Map<string, number>();
    const rowids: number[] = [];

    const cleaned = query
      .replace(/['"(){}[\]*:^~!@#$%&\\]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) return { matches, rowids };

    const terms = cleaned.split(" ")
      .filter(Boolean)
      .filter((t) => !MemorySearch.FTS_STOPWORDS.has(t.toLowerCase()));

    if (terms.length === 0) return { matches, rowids };

    // Pass 1: AND query (all content words must appear)
    if (terms.length >= 3) {
      try {
        const andQuery = terms.slice(0, 8).map((t) => `"${t}"`).join(" AND ");
        const andRows = this.db
          .prepare(
            `SELECT rowid, bm25(memories_fts, 1.0, ${keywordBoost}) as rank FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT 100`
          )
          .all(andQuery) as unknown as FtsMatch[];

        if (andRows.length > 0) {
          const minRank = Math.min(...andRows.map((r) => r.rank));
          const maxRank = Math.max(...andRows.map((r) => r.rank));
          const range = maxRank - minRank || 1;
          for (const row of andRows) {
            // AND matches get 1.3x precision bonus
            const score = ((maxRank - row.rank) / range) * 1.3;
            matches.set(String(row.rowid), score);
            rowids.push(Number(row.rowid));
          }
        }
      } catch {
        // AND query can fail if terms don't exist in index
      }
    }

    // Pass 2: OR query (any content word)
    try {
      const orQuery = terms.slice(0, 10).map((t) => `"${t}"`).join(" OR ");
      const orRows = this.db
        .prepare(
          `SELECT rowid, bm25(memories_fts, 1.0, ${keywordBoost}) as rank FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT 200`
        )
        .all(orQuery) as unknown as FtsMatch[];

      if (orRows.length > 0) {
        const minRank = Math.min(...orRows.map((r) => r.rank));
        const maxRank = Math.max(...orRows.map((r) => r.rank));
        const range = maxRank - minRank || 1;
        for (const row of orRows) {
          const score = (maxRank - row.rank) / range;
          const existing = matches.get(String(row.rowid)) ?? 0;
          matches.set(String(row.rowid), Math.max(existing, score));
          if (!rowids.includes(Number(row.rowid))) rowids.push(Number(row.rowid));
        }
      }
    } catch {
      // FTS can fail on unusual input
    }

    return { matches, rowids };
  }
}
