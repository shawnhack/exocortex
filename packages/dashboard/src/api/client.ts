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
  expires_at: string | null;
  namespace: string | null;
  tier: string;
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
  score_breakdown?: {
    usefulness: number;
    valence: number;
    quality: number;
    goal_relevance: number;
    graph: number;
  };
}

export interface EmbeddingHealth {
  currentModel: string;
  dimensions: number;
  totalEmbedded: number;
  mismatchedModel: number;
  missingEmbedding: number;
}

export interface DecayCandidate {
  id: string;
  content: string;
  importance: number;
  access_count: number;
  created_at: string;
  last_accessed_at: string | null;
  reason: string;
}

export interface TagHealth {
  totalTags: number;
  mergeCount: number;
  aliasMap: Record<string, string>;
  suggestions: Array<{
    from: string;
    to: string;
    similarity: number;
    fromCount: number;
    toCount: number;
  }>;
}

export interface SearchMiss {
  query: string;
  count: number;
  avg_max_score: number | null;
  last_seen: string;
}

export interface RegressionRunSummary {
  run_id: string;
  query_count: number;
  alerts: number;
  avg_overlap: number;
  created_at: string;
}

export interface RegressionQueryResult {
  query: string;
  overlap_at_10: number;
  avg_rank_shift: number;
  exact_order: boolean;
  alert: boolean;
  created_at: string;
}

export interface ReembedResult {
  processed: number;
  failed: number;
}

export interface AutoConsolidateResult {
  clustersFound: number;
  clustersConsolidated: number;
  memoriesMerged: number;
  summaryIds: string[];
}

export interface KnowledgeGap {
  query: string;
  count: number;
  avg_max_score: number | null;
  last_seen: string;
  severity: "critical" | "warning" | "info";
}

export interface QueryOutcome {
  query: string;
  search_count: number;
  result_count_avg: number;
  feedback_count: number;
  feedback_ratio: number;
  last_queried_at: string;
}

export interface ConsolidationCluster {
  centroidId: string;
  memberIds: string[];
  avgSimilarity: number;
  topic: string;
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

export interface Prediction {
  id: string;
  claim: string;
  confidence: number;
  domain: string;
  status: "open" | "resolved" | "voided";
  resolution: "true" | "false" | "partial" | null;
  resolution_notes: string | null;
  source: string;
  goal_id: string | null;
  deadline: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface CalibrationStats {
  total_predictions: number;
  resolved_count: number;
  brier_score: number;
  overconfidence_bias: number;
  calibration_curve: Array<{ range_start: number; range_end: number; predicted_avg: number; actual_freq: number; count: number }>;
  domain_breakdown: Array<{ domain: string; brier_score: number; accuracy: number; count: number }>;
  trend: Array<{ month: string; brier_score: number; count: number }>;
}

export interface AgentTaskItem {
  id: string;
  title: string;
  description: string | null;
  assignee: string | null;
  created_by: string;
  status: "pending" | "assigned" | "in_progress" | "completed" | "failed" | "blocked";
  priority: "low" | "medium" | "high" | "critical";
  goal_id: string | null;
  parent_task_id: string | null;
  dependencies: string[];
  result: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  assigned_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  deadline: string | null;
}

export interface DiaryAgent {
  agent: string;
  entries: number;
  lastEntry: string;
}

export interface DiaryEntry {
  id: string;
  agent: string;
  entry: string;
  topic: string;
  created_at: string;
}

export interface AnalyticsSummary {
  totalActive: number;
  neverAccessedPct: number;
  usefulPct: number;
  medianAccessCount: number;
}

export interface AccessBucket {
  label: string;
  count: number;
}

export interface TagEffectiveness {
  tag: string;
  memoryCount: number;
  avgUsefulCount: number;
}

export interface ProducerQuality {
  producer: string;
  memoryCount: number;
  avgUsefulCount: number;
}

export interface QualityTrendEntry {
  period: string;
  created: number;
  totalMemories: number;
  searches: number;
  avgUseful: number;
  neverAccessedPct: number;
}

export interface QualityDistribution {
  avg: number;
  median: number;
  p10: number;
  p90: number;
  highQuality: number;
  lowQuality: number;
  total: number;
}

export interface HierarchyEpisode {
  id: string;
  content: string;
  importance: number;
  created_at: string;
  tags: string[];
  linked: boolean;
}

export interface HierarchyTheme {
  id: string;
  content: string;
  importance: number;
  created_at: string;
  linked: boolean;
  episodes: HierarchyEpisode[];
}

export interface HierarchyEpoch {
  id: string;
  content: string;
  importance: number;
  created_at: string;
  month: string;
  themes: HierarchyTheme[];
}

export interface TemporalHierarchy {
  epochs: HierarchyEpoch[];
  orphan_themes: HierarchyTheme[];
  time_range: { start: string; end: string } | null;
}

export interface LibraryDocument {
  id: string;
  title: string;
  url: string;
  description: string | null;
  total_chars: number;
  chunk_count: number;
  importance: number;
  tier: string;
  namespace: string | null;
  tags: string[];
  ingested_at: string;
  created_at: string;
}

export interface LibraryDocumentChunk {
  id: string;
  index: number;
  content: string;
  chars: number;
}

export interface LibraryDocumentDetail extends LibraryDocument {
  content: string;
  chunks: LibraryDocumentChunk[];
}

export interface ResearchSourceResult {
  url: string;
  title: string;
  status: "ingested" | "failed" | "skipped";
  chunks_stored?: number;
  total_chars?: number;
  error?: string;
  parent_id?: string;
}

export interface ResearchResult {
  topic: string;
  queries_run: string[];
  sources_found: number;
  sources_ingested: number;
  sources_failed: number;
  sources_skipped: number;
  total_chunks: number;
  total_chars: number;
  sources: ResearchSourceResult[];
}

export interface Stats {
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

// Memory API
export const api = {
  searchMemories(
    query: string,
    limit = 20,
    tags?: string[],
    offset = 0,
    filters?: { content_type?: string; after?: string; before?: string; min_importance?: number; namespace?: string; tier?: string }
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
    filters?: { content_type?: string; after?: string; before?: string; min_importance?: number; tier?: string }
  ) {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (tags && tags.length > 0) params.set("tags", tags.join(","));
    if (filters?.content_type) params.set("content_type", filters.content_type);
    if (filters?.after) params.set("after", filters.after);
    if (filters?.before) params.set("before", filters.before);
    if (filters?.min_importance !== undefined) params.set("min_importance", String(filters.min_importance));
    if (filters?.tier) params.set("tier", filters.tier);
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

  bulkTag(ids: string[], addTags?: string[], removeTags?: string[]) {
    return request<{ ok: boolean; affected: number }>("/api/memories/bulk-tag", {
      method: "POST",
      body: JSON.stringify({ ids, add_tags: addTags, remove_tags: removeTags }),
    });
  },

  bulkUpdateImportance(ids: string[], importance: number) {
    return request<{ ok: boolean; affected: number }>("/api/memories/bulk-update", {
      method: "POST",
      body: JSON.stringify({ ids, importance }),
    });
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

  // Predictions
  getPredictions(filters?: { status?: string; domain?: string; overdue?: boolean }) {
    const params = new URLSearchParams();
    if (filters?.status && filters.status !== "all") params.set("status", filters.status);
    if (filters?.domain && filters.domain !== "all") params.set("domain", filters.domain);
    if (filters?.overdue) params.set("overdue", "true");
    const qs = params.toString() ? `?${params}` : "";
    return request<{ predictions: Prediction[]; count: number }>(`/api/predictions${qs}`);
  },

  getPredictionStats() {
    return request<CalibrationStats>("/api/predictions/stats");
  },

  createPrediction(data: { claim: string; confidence: number; domain?: string; deadline?: string }) {
    return request<Prediction>("/api/predictions", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  resolvePrediction(id: string, data: { resolution: string; resolution_notes?: string }) {
    return request<Prediction>(`/api/predictions/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  },

  voidPrediction(id: string, reason?: string) {
    return request<Prediction>(`/api/predictions/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ void: true, reason }),
    });
  },

  deletePrediction(id: string) {
    return request<{ ok: boolean }>(`/api/predictions/${id}`, {
      method: "DELETE",
    });
  },

  // Agent Tasks
  getTasks(filters?: { assignee?: string; status?: string; goal_id?: string; priority?: string }) {
    const params = new URLSearchParams();
    if (filters?.assignee) params.set("assignee", filters.assignee);
    if (filters?.status && filters.status !== "all") params.set("status", filters.status);
    if (filters?.goal_id) params.set("goal_id", filters.goal_id);
    if (filters?.priority && filters.priority !== "all") params.set("priority", filters.priority);
    const qs = params.toString() ? `?${params}` : "";
    return request<{ tasks: AgentTaskItem[]; count: number }>(`/api/tasks${qs}`);
  },

  getTaskStats() {
    return request<{ total: number; by_status: Record<string, number>; by_assignee: Record<string, number> }>("/api/tasks/stats");
  },

  updateTask(id: string, data: Record<string, unknown>) {
    return request<AgentTaskItem>(`/api/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  },

  deleteTask(id: string) {
    return request<{ ok: boolean }>(`/api/tasks/${id}`, {
      method: "DELETE",
    });
  },

  // Diary
  getDiaryAgents() {
    return request<{ agents: DiaryAgent[] }>("/api/diary/agents");
  },

  getDiaryEntries(agent: string, opts?: { topic?: string; limit?: number }) {
    const params = new URLSearchParams();
    if (opts?.topic) params.set("topic", opts.topic);
    if (opts?.limit) params.set("limit", String(opts.limit));
    const qs = params.toString() ? `?${params}` : "";
    return request<{ entries: DiaryEntry[]; count: number }>(`/api/diary/${encodeURIComponent(agent)}${qs}`);
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

  getEntityGraphAnalysis() {
    return request<{
      centrality: Array<{
        entityId: string;
        entityName: string;
        degree: number;
        betweenness: number;
        memoryCount: number;
      }>;
      communities: Array<{
        id: number;
        members: Array<{ entityId: string; entityName: string }>;
        size: number;
        internalEdges: number;
      }>;
      stats: { nodeCount: number; edgeCount: number; components: number; avgDegree: number };
    }>("/api/entities/graph/analysis");
  },

  getHierarchy(options?: { month?: string; after?: string; before?: string; maxEpisodes?: number }) {
    const params = new URLSearchParams();
    if (options?.month) params.set("month", options.month);
    if (options?.after) params.set("after", options.after);
    if (options?.before) params.set("before", options.before);
    if (options?.maxEpisodes) params.set("max_episodes", String(options.maxEpisodes));
    const qs = params.toString() ? `?${params}` : "";
    return request<TemporalHierarchy>(`/api/hierarchy${qs}`);
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

  // Analytics
  getAnalyticsSummary() {
    return request<AnalyticsSummary>("/api/analytics/summary");
  },

  getAccessDistribution() {
    return request<AccessBucket[]>("/api/analytics/access-distribution");
  },

  getTagEffectiveness(limit = 20) {
    return request<TagEffectiveness[]>(
      `/api/analytics/tag-effectiveness?limit=${limit}`
    );
  },

  getProducerQuality(by: "model" | "agent" = "model", limit = 15) {
    return request<ProducerQuality[]>(
      `/api/analytics/producer-quality?by=${by}&limit=${limit}`
    );
  },

  getQualityTrend(granularity: "day" | "week" | "month" = "day", limit = 30) {
    return request<QualityTrendEntry[]>(
      `/api/analytics/quality-trend?granularity=${granularity}&limit=${limit}`
    );
  },

  getQualityDistribution() {
    return request<QualityDistribution>("/api/analytics/quality-distribution");
  },

  // Library
  getLibraryDocuments(limit = 50, offset = 0, search?: string) {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (search) params.set("search", search);
    return request<{
      documents: LibraryDocument[];
      total: number;
    }>(`/api/library/documents?${params}`);
  },

  getLibraryDocument(id: string) {
    return request<LibraryDocumentDetail>(`/api/library/documents/${id}`);
  },

  ingestUrl(data: {
    url: string;
    content?: string;
    title?: string;
    tags?: string[];
    importance?: number;
    tier?: string;
    namespace?: string;
    chunk_size?: number;
    chunk_overlap?: number;
  }) {
    return request<{
      url: string;
      title: string;
      description: string | null;
      parent_id: string;
      chunks_stored: number;
      total_chars: number;
      replaced: number;
      tier: string;
    }>("/api/library/ingest", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  deleteDocument(id: string) {
    return request<{ ok: boolean; deleted: number }>(
      `/api/library/documents/${id}`,
      { method: "DELETE" }
    );
  },

  researchTopic(data: {
    topic: string;
    queries?: string[];
    max_sources?: number;
    tags?: string[];
    tier?: string;
    namespace?: string;
  }) {
    return request<ResearchResult>("/api/library/research", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  getQualityHistogram() {
    return request<Array<{ bucket: string; count: number }>>(
      "/api/analytics/quality-histogram"
    );
  },

  getEmbeddingHealth() {
    return request<EmbeddingHealth>("/api/analytics/embedding-health");
  },

  getDecayPreview() {
    return request<{ candidates: DecayCandidate[]; total: number }>(
      "/api/analytics/decay-preview"
    );
  },

  getTagHealth() {
    return request<TagHealth>("/api/analytics/tag-health");
  },

  getSearchMisses(limit = 20, days = 7) {
    return request<SearchMiss[]>(
      `/api/analytics/search-misses?limit=${limit}&days=${days}`
    );
  },

  getConsolidationPreview() {
    return request<{ dry_run: boolean; clusters: ConsolidationCluster[] }>(
      "/api/consolidate",
      { method: "POST", body: JSON.stringify({ dry_run: true }) }
    );
  },

  getNamespaces() {
    return request<{ namespaces: string[] }>("/api/memories/namespaces");
  },

  // Retrieval regression
  getRegressionRuns(limit = 10) {
    return request<{ runs: RegressionRunSummary[] }>(
      `/api/retrieval-regression/runs?limit=${limit}`
    );
  },

  getRegressionLatest() {
    return request<{ run_id: string | null; golden_count: number; results: RegressionQueryResult[] }>(
      "/api/retrieval-regression/latest"
    );
  },

  // Reembed
  triggerReembed() {
    return request<ReembedResult>("/api/reembed", { method: "POST" });
  },

  // Auto-consolidation
  triggerAutoConsolidate() {
    return request<AutoConsolidateResult>("/api/auto-consolidate", {
      method: "POST",
    });
  },

  // Knowledge gaps
  getKnowledgeGaps(minCount = 3, days = 14) {
    return request<KnowledgeGap[]>(
      `/api/analytics/knowledge-gaps?min_count=${minCount}&days=${days}`
    );
  },

  getQueryOutcomes(limit = 20, minSearches = 2, sortBy: "searches" | "feedback_ratio" | "zero_feedback" = "searches") {
    return request<QueryOutcome[]>(
      `/api/analytics/query-outcomes?limit=${limit}&min_searches=${minSearches}&sort_by=${sortBy}`
    );
  },

  getHealthChecks() {
    return request<{ overall: string; checks: Array<{ name: string; status: string; message: string; value?: number }> }>(
      "/api/health-checks"
    );
  },

  getLintReport() {
    return request<{ overall: string; issues: Array<{ category: string; severity: string; message: string; count?: number }>; stats: Record<string, unknown> }>(
      "/api/lint"
    );
  },

  getRegressionHistory(limit = 30) {
    return request<{ runs: Array<{ run_id: string; avg_overlap: number; query_count: number; alerts: number; created_at: string }> }>(
      `/api/retrieval-regression/history?limit=${limit}`
    );
  },
};
