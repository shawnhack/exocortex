export type ContentType = "text" | "conversation" | "note" | "summary";
export type MemorySource =
  | "manual"
  | "cli"
  | "api"
  | "mcp"
  | "browser"
  | "import"
  | "consolidation";

export interface Memory {
  id: string;
  content: string;
  content_type: ContentType;
  source: MemorySource;
  source_uri: string | null;
  embedding: Float32Array | null;
  importance: number;
  access_count: number;
  last_accessed_at: string | null;
  parent_id: string | null;
  is_active: boolean;
  superseded_by: string | null;
  chunk_index: number | null;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  tags?: string[];
}

export interface CreateMemoryInput {
  content: string;
  content_type?: ContentType;
  source?: MemorySource;
  source_uri?: string;
  importance?: number;
  parent_id?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface UpdateMemoryInput {
  content?: string;
  content_type?: ContentType;
  importance?: number;
  is_active?: boolean;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface SearchQuery {
  query: string;
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
}

export interface SearchResult {
  memory: Memory;
  score: number;
  vector_score: number;
  fts_score: number;
  recency_score: number;
  frequency_score: number;
}

export interface MemoryStats {
  total_memories: number;
  active_memories: number;
  by_content_type: Record<string, number>;
  by_source: Record<string, number>;
  total_entities: number;
  total_tags: number;
  oldest_memory: string | null;
  newest_memory: string | null;
}

export interface CreateMemoryResult {
  memory: Memory;
  superseded_id?: string;
  dedup_similarity?: number;
}

/** Raw row shape from SQLite (embedding as Buffer, is_active as integer) */
export interface MemoryRow {
  id: string;
  content: string;
  content_type: ContentType;
  source: MemorySource;
  source_uri: string | null;
  embedding: Uint8Array | null;
  importance: number;
  access_count: number;
  last_accessed_at: string | null;
  parent_id: string | null;
  is_active: number;
  superseded_by: string | null;
  chunk_index: number | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}
