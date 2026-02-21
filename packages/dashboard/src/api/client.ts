const BASE = "";

async function request<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

// Types
export interface Memory {
  id: string;
  content: string;
  content_type: string;
  source: string;
  source_uri: string | null;
  provider: string | null;
  model_id: string | null;
  model_name: string | null;
  agent: string | null;
  session_id: string | null;
  conversation_id: string | null;
  importance: number;
  access_count: number;
  last_accessed_at: string | null;
  parent_id: string | null;
  superseded_by: string | null;
  is_active: boolean;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  tags?: string[];
}

export interface SearchResult {
  memory: Memory;
  score: number;
  vector_score: number;
  fts_score: number;
  recency_score: number;
  frequency_score: number;
}

export interface Entity {
  id: string;
  name: string;
  type: string;
  aliases: string[];
  metadata: Record<string, unknown>;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface MemoryLinkResult {
  memory_id: string;
  link_type: string;
  strength: number;
  direction: "outgoing" | "incoming";
  created_at: string;
  preview: {
    id: string;
    content: string;
    content_type: string;
    importance: number;
    created_at: string;
  } | null;
}

export interface Goal {
  id: string;
  title: string;
  description: string | null;
  status: "active" | "completed" | "stalled" | "abandoned";
  priority: "low" | "medium" | "high" | "critical";
  deadline: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface Milestone {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed";
  order: number;
  deadline: string | null;
  completed_at: string | null;
}

export interface GoalWithProgress extends Goal {
  progress: Array<{ id: string; content: string; created_at: string }>;
  milestones: Milestone[];
}

export interface Stats {
  total_memories: number;
  active_memories: number;
  by_content_type: Record<string, number>;
  by_source: Record<string, number>;
  total_entities: number;
  total_tags: number;
  oldest_memory: string | null;
  newest_memory: string | null;
}

// Memory API
export const api = {
  searchMemories(
    query: string,
    limit = 20,
    tags?: string[],
    offset = 0,
    filters?: { content_type?: string; after?: string; before?: string; min_importance?: number }
  ) {
    return request<{ results: SearchResult[]; count: number }>(
      "/api/memories/search",
      {
        method: "POST",
        body: JSON.stringify({
          query,
          limit,
          offset,
          tags,
          ...filters,
        }),
      }
    );
  },

  getRecent(
    limit = 20,
    offset = 0,
    tags?: string[],
    filters?: { content_type?: string; after?: string; before?: string; min_importance?: number }
  ) {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (tags && tags.length > 0) params.set("tags", tags.join(","));
    if (filters?.content_type) params.set("content_type", filters.content_type);
    if (filters?.after) params.set("after", filters.after);
    if (filters?.before) params.set("before", filters.before);
    if (filters?.min_importance !== undefined) params.set("min_importance", String(filters.min_importance));
    return request<{ results: Memory[]; count: number }>(
      `/api/memories/recent?${params}`
    );
  },

  getMemory(id: string) {
    return request<Memory>(`/api/memories/${id}`);
  },

  createMemory(data: {
    content: string;
    content_type?: string;
    tags?: string[];
    importance?: number;
    source_uri?: string;
    provider?: string;
    model_id?: string;
    model_name?: string;
    agent?: string;
    session_id?: string;
    conversation_id?: string;
    metadata?: Record<string, unknown>;
  }) {
    return request<Memory>("/api/memories", {
      method: "POST",
      body: JSON.stringify({ ...data, source: "api" }),
    });
  },

  updateMemory(id: string, data: Partial<Memory>) {
    return request<Memory>(`/api/memories/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  },

  deleteMemory(id: string) {
    return request<{ ok: boolean }>(`/api/memories/${id}`, {
      method: "DELETE",
    });
  },

  archiveMemory(id: string) {
    return request<Memory>(`/api/memories/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ is_active: false }),
    });
  },

  importMemories(
    memories: Array<{
      content: string;
      content_type?: string;
      tags?: string[];
      importance?: number;
    }>
  ) {
    return request<{ imported: number; failed: number; errors: string[] }>(
      "/api/memories/import",
      { method: "POST", body: JSON.stringify({ memories }) }
    );
  },

  // Entities
  getEntities(options?: { type?: string; tags?: string[] }) {
    const params = new URLSearchParams();
    if (options?.type) params.set("type", options.type);
    if (options?.tags && options.tags.length > 0) params.set("tags", options.tags.join(","));
    const qs = params.toString() ? `?${params}` : "";
    return request<{ results: Entity[]; count: number }>(
      `/api/entities${qs}`
    );
  },

  getEntity(id: string) {
    return request<Entity>(`/api/entities/${id}`);
  },

  getEntityMemories(id: string) {
    return request<{ entity: Entity; memories: Memory[]; count: number }>(
      `/api/entities/${id}/memories`
    );
  },

  getEntityTags() {
    return request<{ tags: string[] }>("/api/entities/tags");
  },

  getEntityRelationships(id: string) {
    return request<{
      results: Array<{ entity: Entity; relationship: string; direction: "outgoing" | "incoming" }>;
      count: number;
    }>(`/api/entities/${id}/relationships`);
  },

  updateEntity(id: string, data: Partial<Pick<Entity, "name" | "type" | "aliases" | "tags">>) {
    return request<Entity>(`/api/entities/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  },

  deleteEntity(id: string) {
    return request<{ ok: boolean }>(`/api/entities/${id}`, {
      method: "DELETE",
    });
  },

  // Memory links
  getMemoryLinks(id: string) {
    return request<{ links: MemoryLinkResult[]; count: number }>(
      `/api/memories/${id}/links`
    );
  },

  // Goals
  getGoals(status?: string) {
    const qs = status ? `?status=${status}` : "?status=all";
    return request<{ goals: Goal[]; count: number }>(`/api/goals${qs}`);
  },

  getGoal(id: string) {
    return request<GoalWithProgress>(`/api/goals/${id}`);
  },

  createGoal(data: { title: string; description?: string; priority?: string; deadline?: string }) {
    return request<Goal>("/api/goals", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  updateGoal(id: string, data: Partial<Goal>) {
    return request<Goal>(`/api/goals/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  },

  deleteGoal(id: string) {
    return request<{ ok: boolean }>(`/api/goals/${id}`, {
      method: "DELETE",
    });
  },

  getEntityGraph() {
    return request<{
      entities: Entity[];
      relationships: Array<{
        source_id: string;
        target_id: string;
        relationship: string;
      }>;
    }>("/api/entities/graph");
  },

  getTimeline(options?: { limit?: number; includeMemories?: boolean }) {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.includeMemories) params.set("include_memories", "true");
    const qs = params.toString() ? `?${params}` : "";
    return request<Array<{ date: string; count: number; memories: any[] }>>(`/api/timeline${qs}`);
  },

  getTemporalStats() {
    return request<{
      total_days: number;
      avg_per_day: number;
      most_active_day: string | null;
      most_active_count: number;
      streak_current: number;
      streak_longest: number;
    }>("/api/temporal-stats");
  },

  // Archived / Trash
  getArchived(limit = 20, offset = 0) {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    return request<{ results: Memory[]; count: number }>(
      `/api/memories/archived?${params}`
    );
  },

  restoreMemory(id: string) {
    return request<{ ok: boolean }>(`/api/memories/${id}/restore`, {
      method: "POST",
    });
  },

  // Chat (RAG)
  chat(message: string, history?: Array<{ role: "user" | "assistant"; content: string }>, conversationId?: string) {
    return request<{ response: string; sources: Memory[]; conversation_id: string }>(
      "/api/chat",
      {
        method: "POST",
        body: JSON.stringify({ message, history, conversation_id: conversationId }),
      }
    );
  },

  // Export
  async exportData() {
    const res = await fetch(`${BASE}/api/export`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  // System
  getStats() {
    return request<Stats>("/api/stats");
  },

  getSettings() {
    return request<Record<string, string>>("/api/settings");
  },

  updateSettings(settings: Record<string, string>) {
    return request<Record<string, string>>("/api/settings", {
      method: "PATCH",
      body: JSON.stringify(settings),
    });
  },
};
