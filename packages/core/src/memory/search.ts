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
  computeHybridScore,
  getWeights,
  getRRFConfig,
  reciprocalRankFusion,
} from "./scoring.js";
import { EntityStore } from "../entities/store.js";
import { MemoryLinkStore } from "./links.js";

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

    if (query.tags && query.tags.length > 0) {
      const placeholders = query.tags.map(() => "?").join(", ");
      conditions.push(
        `m.id IN (SELECT memory_id FROM memory_tags WHERE tag IN (${placeholders}))`
      );
      params.push(...query.tags.map((t) => t.toLowerCase().trim()));
    }

    const whereClause = conditions.join(" AND ");

    // Candidate pool: fetch enough rows for scoring, but cap proportionally
    const candidateLimit = Math.min(1000, Math.max(100, (offset + limit) * 10));

    // Query expansion via entity graph
    const expansion = this.expandQuery(query.query);
    const embeddingText = expansion ? expansion.expandedText : query.query;
    const ftsText = query.query;
    const extraFtsTerms = expansion ? expansion.expandedTerms : [];

    // Get FTS matches FIRST (so we can include them in candidate pool)
    // Uses String() keys to avoid BigInt/Number mismatch from node:sqlite
    const ftsMatches = new Map<string, number>();
    const ftsRowids: number[] = [];
    try {
      let ftsQuery = this.sanitizeFtsQuery(ftsText);
      if (extraFtsTerms.length > 0) {
        const extraTermsStr = extraFtsTerms.map((t) => `"${t}"`).join(" OR ");
        ftsQuery = `${ftsQuery} OR ${extraTermsStr}`;
      }
      const ftsRows = this.db
        .prepare(
          "SELECT rowid, rank FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT 200"
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

    // Compute per-candidate component scores
    const candidates: Array<{
      row: MemoryRow & { _rowid: number };
      vectorScore: number;
      ftsScore: number;
      recency: number;
      freq: number;
      usefulness: number;
    }> = [];

    for (const row of rows) {
      let vectorScore = 0;
      if (queryEmbedding && row.embedding) {
        const bytes = row.embedding as unknown as Uint8Array;
        const memEmbedding = new Float32Array(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength / 4
        );
        vectorScore = Math.max(0, cosineSimilarity(queryEmbedding, memEmbedding));
      }

      const ftsScore = ftsMatches.get(String(row._rowid)) ?? 0;
      const recency = recencyScore(row.created_at, weights.recencyDecay, row.importance);
      const freq = frequencyScore(row.access_count, maxAccessCount);
      const usefulness = usefulnessScore((row as any).useful_count ?? 0);

      candidates.push({ row, vectorScore, ftsScore, recency, freq, usefulness });
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
    const scored: Array<{ row: MemoryRow & { _rowid: number }; score: number; vectorScore: number; ftsScore: number; recency: number; freq: number; usefulness: number }> = [];

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
        const baseRrf = rrfScores.get(c.row.id) ?? 0;

        // Post-RRF multiplicative boost from recency + frequency + usefulness
        const boostMultiplier = 1 + weights.recency * c.recency + weights.frequency * c.freq + weights.usefulness * c.usefulness;
        let score = baseRrf * boostMultiplier;

        // Tag boost scaled to RRF range
        if (tagBoost > 0 && queryTerms.length > 0 && maxRrf > 0) {
          const memTags = candidateTagMap.get(c.row.id);
          if (memTags) {
            const hasMatch = queryTerms.some((term) =>
              memTags.some((tag) => tag.includes(term))
            );
            if (hasMatch) {
              score += tagBoost * maxRrf;
            }
          }
        }

        if (score >= rrfMinScore) {
          scored.push({ row: c.row, score, vectorScore: c.vectorScore, ftsScore: c.ftsScore, recency: c.recency, freq: c.freq, usefulness: c.usefulness });
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

        // Additive usefulness boost (only positive, never penalizes)
        score += weights.usefulness * c.usefulness;

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

        if (score >= minScore) {
          scored.push({ row: c.row, score, vectorScore: c.vectorScore, ftsScore: c.ftsScore, recency: c.recency, freq: c.freq, usefulness: c.usefulness });
        }
      }
    }

    // Sort by score descending, apply offset + limit
    scored.sort((a, b) => b.score - a.score);
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

    return page.map((p) => {
      const { _rowid, metadata: rawMeta, ...row } = p.row;
      return {
        memory: {
          ...row,
          embedding: null,
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
      };
    });
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

  private expandQuery(
    query: string
  ): { expandedText: string; expandedTerms: string[] } | null {
    const enabled = getSetting(this.db, "search.query_expansion");
    if (enabled !== "true") return null;

    const words = query
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .map((w) => w.toLowerCase());

    if (words.length === 0) return null;

    const entityStore = new EntityStore(this.db);
    const additionalTerms = new Set<string>();
    const queryLower = query.toLowerCase();

    for (const word of words) {
      const entity = entityStore.getByName(word);
      if (!entity) continue;

      // Add entity aliases
      for (const alias of entity.aliases) {
        const aliasLower = alias.toLowerCase();
        if (!queryLower.includes(aliasLower)) {
          additionalTerms.add(alias);
        }
      }

      // Add names of related entities (limit 5)
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

    if (additionalTerms.size === 0) return null;

    const terms = Array.from(additionalTerms);
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
