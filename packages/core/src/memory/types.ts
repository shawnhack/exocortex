export type ContentType = "text" | "conversation" | "note" | "summary";
export type MemorySource =
  | "manual"
  | "cli"
  | "api"
  | "mcp"
  | "browser"
  | "import"
  | "consolidation";
export type MemoryTier =
  | "working"
  | "episodic"
  | "semantic"
  | "procedural"
  | "reference";

export interface Memory {
  id: string;
  content: string;
  content_type: ContentType;
  source: MemorySource;
  source_uri: string | null;
  provider: string | null;
  model_id: string | null;
  model_name: string | null;
  agent: string | null;
  session_id: string | null;
  conversation_id: string | null;
  embedding: Float32Array | null;
  is_metadata: boolean;
  importance: number;
  valence: number;
  access_count: number;
  last_accessed_at: string | null;
  parent_id: string | null;
  is_active: boolean;
  superseded_by: string | null;
  chunk_index: number | null;
  keywords?: string;
  metadata?: Record<string, unknown>;
  quality_score: number | null;
  tier: MemoryTier;
  expires_at: string | null;
  namespace: string | null;
  created_at: string;
  updated_at: string;
  tags?: string[];
}

export interface CreateMemoryInput {
  content: string;
  content_type?: ContentType;
  source?: MemorySource;
  source_uri?: string;
  provider?: string;
  model_id?: string;
  model_name?: string;
  agent?: string;
  session_id?: string;
  conversation_id?: string;
  importance?: number;
  valence?: number;
  parent_id?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  is_metadata?: boolean;
  tier?: MemoryTier;
  expires_at?: string;
  namespace?: string;
  /**
   * Benchmark artifacts are stored with lower default importance and reduced indexing/chunking.
   * Use for evaluation snapshots, regression reports, and query benchmark metadata.
   */
  benchmark?: boolean;
  /**
   * Opt-in semantic deduplication at store time. When true, checks if an existing memory
   * covers the same content (similarity > 0.85 AND word overlap > 60%). If a near-duplicate
   * is found, returns the existing memory ID with dedup_action="near_duplicate" instead of
   * creating a new memory. The caller can then decide whether to update or skip.
   */
  deduplicate?: boolean;
}

export interface UpdateMemoryInput {
  content?: string;
  content_type?: ContentType;
  source_uri?: string | null;
  provider?: string | null;
  model_id?: string | null;
  model_name?: string | null;
  agent?: string | null;
  session_id?: string | null;
  conversation_id?: string | null;
  importance?: number;
  valence?: number;
  is_active?: boolean;
  tags?: string[];
  metadata?: Record<string, unknown>;
  is_metadata?: boolean;
  tier?: MemoryTier;
  expires_at?: string | null;
  namespace?: string | null;
}

export interface SearchQuery {
  query: string;
  /**
   * LLM-provided semantic rephrasings of the query.
   * The calling LLM can supply alternative phrasings to bridge vocabulary gaps
   * (e.g. "auth flow" → "login authentication JWT tokens").
   * These feed into both vector embedding and FTS expansion.
   */
  expanded_query?: string;
  limit?: number;
  offset?: number;
  content_type?: ContentType;
  source?: MemorySource;
  tags?: string[];
  after?: string;
  before?: string;
  min_importance?: number;
  min_score?: number;
  active_only?: boolean;
  /**
   * Include benchmark/progress/regression metadata memories in default retrieval.
   * Defaults to false.
   */
  include_metadata?: boolean;
  namespace?: string;
  tier?: MemoryTier;
  session_id?: string;
}

export interface SearchResult {
  memory: Memory;
  score: number;
  vector_score: number;
  fts_score: number;
  recency_score: number;
  frequency_score: number;
  score_breakdown?: {
    usefulness: number;
    valence: number;
    quality: number;
    goal_relevance: number;
    graph: number;
  };
}

export interface MemoryStats {
  total_memories: number;
  active_memories: number;
  by_content_type: Record<string, number>;
  by_source: Record<string, number>;
  by_tier: Record<string, number>;
  total_entities: number;
  total_tags: number;
  oldest_memory: string | null;
  newest_memory: string | null;
}

export interface CreateMemoryResult {
  memory: Memory;
  superseded_id?: string;
  dedup_similarity?: number;
  dedup_action?: "superseded" | "skipped" | "merged" | "near_duplicate";
}

/** Raw row shape from SQLite (embedding as Buffer, is_active as integer) */
export interface MemoryRow {
  id: string;
  content: string;
  content_type: ContentType;
  source: MemorySource;
  source_uri: string | null;
  provider: string | null;
  model_id: string | null;
  model_name: string | null;
  agent: string | null;
  session_id: string | null;
  conversation_id: string | null;
  embedding: Uint8Array | null;
  content_hash: string | null;
  is_indexed: number;
  is_metadata: number;
  importance: number;
  valence: number;
  access_count: number;
  last_accessed_at: string | null;
  parent_id: string | null;
  is_active: number;
  superseded_by: string | null;
  chunk_index: number | null;
  keywords: string | null;
  metadata: string | null;
  quality_score: number | null;
  tier: string;
  expires_at: string | null;
  namespace: string | null;
  created_at: string;
  updated_at: string;
}
