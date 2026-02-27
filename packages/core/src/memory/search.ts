import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getEmbeddingProvider } from "../embedding/manager.js";
import type { SearchQuery, SearchResult, MemoryRow } from "./types.js";
import { getSetting } from "../db/schema.js";
import {
  cosineSimilarity,
  recencyScore,
  frequencyScore,
  usefulnessScore,
  valenceScore,
  qualityScore,
  goalRelevanceScore,
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

  async search(query: SearchQuery): Promise<SearchResult[]> {
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
      } catch {}
    }

    // Build WHERE clauses for filtering
    const conditions: string[] = ["m.is_active = 1"];
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

    // Use LLM-provided expanded query for richer retrieval if supplied
    const baseQuery = query.expanded_query
      ? `${query.query} ${query.expanded_query}`
      : query.query;

    // Query expansion via entity graph
    const expansion = this.expandQuery(baseQuery);
    const embeddingText = expansion ? expansion.expandedText : baseQuery;
    const ftsText = query.query;
    const extraFtsTerms = expansion ? expansion.expandedTerms : [];

    // Get FTS matches FIRST (so we can include them in candidate pool)
    // Uses String() keys to avoid BigInt/Number mismatch from node:sqlite
    const ftsMatches = new Map<string, number>();
    const ftsRowids: number[] = [];
    try {
      let ftsQuery = this.sanitizeFtsQuery(ftsText);
      if (extraFtsTerms.length > 0) {
        const extraTermsStr = extraFtsTerms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
        ftsQuery = `${ftsQuery} OR ${extraTermsStr}`;
      }
      const rawKeywordBoost = parseFloat(getSetting(this.db, "scoring.keyword_boost") ?? "2.0");
      const keywordBoost = Number.isFinite(rawKeywordBoost) ? rawKeywordBoost : 2.0;
      const ftsRows = this.db
        .prepare(
          `SELECT rowid, bm25(memories_fts, 1.0, ${keywordBoost}) as rank FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT 200`
        )
        .all(ftsQuery) as unknown as FtsMatch[];

      // Normalize FTS ranks (rank is negative in FTS5, more negative = better)
      if (ftsRows.length > 0) {
        const minRank = Math.min(...ftsRows.map((r) => r.rank));
        const maxRank = Math.max(...ftsRows.map((r) => r.rank));
        const range = maxRank - minRank || 1;

        for (const row of ftsRows) {
          // Invert: most negative (best) → 1.0, least negative → 0.0
          ftsMatches.set(String(row.rowid), (maxRank - row.rank) / range);
          ftsRowids.push(Number(row.rowid));
        }
      }
    } catch {
      // FTS query may fail on unusual input; continue with vector-only
    }

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
    try {
      const provider = await getEmbeddingProvider();
      queryEmbedding = await provider.embed(embeddingText);
    } catch {
      // Fall back to FTS-only if embedding fails
    }

    // Configurable min_score threshold (query param overrides setting)
    const minScore = query.min_score ??
      parseFloat(getSetting(this.db, "scoring.min_score") ?? "0.15");

    // Tag boost weight
    const tagBoost = parseFloat(
      getSetting(this.db, "scoring.tag_boost") ?? "0.10"
    );

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
    const needsQualityCompute = rows.some((r) => (r as any).quality_score == null);
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
      const recency = recencyScore(row.created_at, weights.recencyDecay, row.importance, (row as any).quality_score ?? undefined);
      const freq = frequencyScore(row.access_count, maxAccessCount);
      const usefulCount = (row as any).useful_count ?? 0;
      const usefulness = usefulnessScore(usefulCount);
      const valence = valenceScore((row as any).valence ?? 0);
      const memTags = candidateTagMap.get(row.id) ?? [];
      const goalRelevance = goalRelevanceScore(memTags, goalKeywords, row.content);
      const persistedQuality = (row as any).quality_score as number | null;
      let quality: number;
      if (persistedQuality != null) {
        quality = persistedQuality;
      } else {
        const ageDays = (now - new Date(row.created_at + "Z").getTime()) / (1000 * 60 * 60 * 24);
        quality = qualityScore(row.importance, usefulCount, row.access_count, linkCountMap.get(row.id) ?? 0, ageDays);
      }

      candidates.push({ row, vectorScore, ftsScore, recency, freq, usefulness, valence, quality, goalRelevance });
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
      const rrfMinScore = query.min_score ??
        parseFloat(getSetting(this.db, "scoring.rrf_min_score") ?? "0.001");

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
            const denominator = rrfConfig.k + Math.max(10, candidates.length);
            baseRrf = 1 / denominator;
          }
        }

        // Post-RRF multiplicative boost from recency + frequency + usefulness + valence + quality
        const boostMultiplier = 1 + weights.recency * c.recency + weights.frequency * c.freq + weights.usefulness * c.usefulness + weights.valence * c.valence + weights.quality * c.quality + weights.goalGated * c.goalRelevance;
        let score = baseRrf * boostMultiplier;

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

        // Additive usefulness + valence + quality + goal boosts (only positive, never penalizes)
        score += weights.usefulness * c.usefulness;
        score += weights.valence * c.valence;
        score += weights.quality * c.quality;
        score += weights.goalGated * c.goalRelevance;

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

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Confidence gap filter: remove results far below the top score
    const gapRatio = parseFloat(getSetting(this.db, "search.score_gap_ratio") ?? "0.15");
    const qualityFloor = parseFloat(getSetting(this.db, "search.quality_floor") ?? "0.08");
    const topScore = scored[0]?.score ?? 0;
    if (topScore > 0) {
      const minAllowed = topScore * gapRatio;
      scored = scored.filter(s => s.score >= minAllowed && s.quality >= qualityFloor);
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
          metadata: rawMeta ? JSON.parse(rawMeta) : undefined,
          tags: tagMap.get(row.id) ?? [],
        },
        score: p.score,
        vector_score: p.vectorScore,
        fts_score: p.ftsScore,
        recency_score: p.recency,
        frequency_score: p.freq,
        score_breakdown: {
          usefulness: p.usefulness,
          valence: p.valence,
          quality: p.quality,
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
          // Strength-weighted score (0.3-0.8 range based on link strength)
          const linkScore = 0.3 + ref.strength * 0.5;
          scores.set(ref.id, Math.max(scores.get(ref.id) ?? 0, linkScore));
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

  private sanitizeFtsQuery(query: string): string {
    // Escape special FTS5 characters
    const cleaned = query
      .replace(/['"(){}[\]*:^~!@#$%&\\]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!cleaned) return '""';

    // Split into words and join with OR for broader matching
    const terms = cleaned.split(" ").filter(Boolean);
    if (terms.length === 1) return `"${terms[0]}"`;

    return terms.map((t) => `"${t}"`).join(" OR ");
  }
}
