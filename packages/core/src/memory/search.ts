import type { DatabaseSync } from "node:sqlite";
import { getEmbeddingProvider } from "../embedding/manager.js";
import type { SearchQuery, SearchResult, MemoryRow } from "./types.js";
import { getSetting } from "../db/schema.js";
import {
  cosineSimilarity,
  recencyScore,
  frequencyScore,
  computeHybridScore,
  getWeights,
  getRRFConfig,
  reciprocalRankFusion,
} from "./scoring.js";

interface FtsMatch {
  rowid: number;
  rank: number;
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

    // Get FTS matches FIRST (so we can include them in candidate pool)
    const ftsMatches = new Map<string, number>();
    const ftsRowids: number[] = [];
    try {
      const ftsRows = this.db
        .prepare(
          "SELECT rowid, rank FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT 200"
        )
        .all(this.sanitizeFtsQuery(query.query)) as unknown as FtsMatch[];

      // Normalize FTS ranks (rank is negative in FTS5, more negative = better)
      if (ftsRows.length > 0) {
        const minRank = Math.min(...ftsRows.map((r) => r.rank));
        const maxRank = Math.max(...ftsRows.map((r) => r.rank));
        const range = maxRank - minRank || 1;

        for (const row of ftsRows) {
          // Invert: most negative (best) → 1.0, least negative → 0.0
          // Use String() for consistent key type (node:sqlite returns bigint)
          ftsMatches.set(String(row.rowid), (maxRank - row.rank) / range);
          ftsRowids.push(Number(row.rowid));
        }
      }
    } catch {
      // FTS query may fail on unusual input; continue with vector-only
    }

    // Build candidate pool: FTS matches + recent memories (ensures keyword matches are always included)
    let rows: (MemoryRow & { _rowid: number })[];
    
    if (ftsRowids.length > 0) {
      // First, get all FTS matches that pass filters
      const ftsPlaceholders = ftsRowids.map(() => "?").join(", ");
      const ftsMatchRows = this.db
        .prepare(
          `SELECT m.*, m.rowid as _rowid FROM memories m WHERE ${whereClause} AND m.rowid IN (${ftsPlaceholders})`
        )
        .all(...params, ...ftsRowids) as unknown as (MemoryRow & { _rowid: number })[];
      
      // Collect FTS match IDs to exclude from recent pool
      const ftsIds = new Set(ftsMatchRows.map(r => r.id));
      
      // Then get recent memories (excluding FTS matches to avoid dupes)
      const recentLimit = Math.max(0, candidateLimit - ftsMatchRows.length);
      let recentRows: (MemoryRow & { _rowid: number })[] = [];
      if (recentLimit > 0) {
        recentRows = this.db
          .prepare(
            `SELECT m.*, m.rowid as _rowid FROM memories m WHERE ${whereClause} ORDER BY created_at DESC LIMIT ${recentLimit}`
          )
          .all(...params) as unknown as (MemoryRow & { _rowid: number })[];
        // Filter out duplicates (FTS matches already included)
        recentRows = recentRows.filter(r => !ftsIds.has(r.id));
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

    // Get query embedding
    let queryEmbedding: Float32Array | null = null;
    try {
      const provider = await getEmbeddingProvider();
      queryEmbedding = await provider.embed(query.query);
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

      candidates.push({ row, vectorScore, ftsScore, recency, freq });
    }

    // RRF or legacy scoring
    const rrfConfig = getRRFConfig(this.db);
    const scored: Array<{ row: MemoryRow & { _rowid: number }; score: number; vectorScore: number; ftsScore: number; recency: number; freq: number }> = [];

    if (rrfConfig.enabled) {
      // Build ranked lists from candidates with non-zero scores
      const vectorList = candidates
        .filter((c) => c.vectorScore > 0)
        .map((c) => ({ id: c.row.id, score: c.vectorScore }));
      const ftsList = candidates
        .filter((c) => c.ftsScore > 0)
        .map((c) => ({ id: c.row.id, score: c.ftsScore }));

      const rrfScores = reciprocalRankFusion(
        [
          { entries: vectorList, weight: weights.vector },
          { entries: ftsList, weight: weights.fts },
        ],
        rrfConfig.k
      );

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

        // Post-RRF multiplicative boost from recency + frequency
        const boostMultiplier = 1 + weights.recency * c.recency + weights.frequency * c.freq;
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
          scored.push({ row: c.row, score, vectorScore: c.vectorScore, ftsScore: c.ftsScore, recency: c.recency, freq: c.freq });
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
          scored.push({ row: c.row, score, vectorScore: c.vectorScore, ftsScore: c.ftsScore, recency: c.recency, freq: c.freq });
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

    return page.map((p) => {
      const { _rowid, metadata: rawMeta, ...row } = p.row;
      return {
        memory: {
          ...row,
          embedding: null,
          is_active: row.is_active === 1,
          superseded_by: row.superseded_by ?? null,
          chunk_index: row.chunk_index ?? null,
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
