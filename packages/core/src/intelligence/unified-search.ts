import type { DatabaseSync } from "node:sqlite";
import { MemorySearch } from "../memory/search.js";
import type { SearchResult } from "../memory/types.js";
import type { RerankerProvider } from "../memory/reranker.js";

/**
 * Unified search across all retrievable surfaces in the exocortex database:
 * memories, predictions, contradictions, goals, and agent_tasks.
 *
 * Each surface has its own native ranking. Memories use the full hybrid
 * search pipeline (vector + FTS + graph + scoring). Structured surfaces
 * (predictions/contradictions/goals/tasks) use case-insensitive substring
 * matching on their primary text fields, ranked by recency.
 *
 * Why grouped instead of interleaved: heterogeneous surfaces don't share
 * a common scoring scale, and forcing one would either bias results
 * toward memories (which have richer signal) or flatten meaningful
 * differences. Returning grouped output lets the caller decide how to
 * present them while still surfacing matches across all 5 tables in a
 * single round-trip.
 */

export type UnifiedSearchSurface =
  | "memories"
  | "predictions"
  | "contradictions"
  | "goals"
  | "tasks";

export interface UnifiedSearchOptions {
  /** Max results per surface. Default 5. */
  limit_per_surface?: number;
  /** Restrict to specific surfaces. Default: all five. */
  surfaces?: UnifiedSearchSurface[];
  /** Only include predictions/goals/tasks with status in this set. */
  status_filter?: string[];
  /** Optional reranker for the memory search step. */
  reranker?: RerankerProvider;
  /** Forwarded to memory search. */
  namespace?: string;
}

export interface UnifiedSearchResult {
  query: string;
  memories: SearchResult[];
  predictions: PredictionHit[];
  contradictions: ContradictionHit[];
  goals: GoalHit[];
  tasks: TaskHit[];
  total_hits: number;
  surfaces_searched: UnifiedSearchSurface[];
}

export interface PredictionHit {
  id: string;
  claim: string;
  confidence: number;
  status: string;
  domain: string;
  deadline: string | null;
  resolution: string | null;
  created_at: string;
}

export interface ContradictionHit {
  id: string;
  description: string;
  status: string;
  memory_a_id: string;
  memory_b_id: string;
  resolution: string | null;
  created_at: string;
}

export interface GoalHit {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  deadline: string | null;
  created_at: string;
}

export interface TaskHit {
  id: string;
  title: string;
  description: string | null;
  status: string;
  assignee: string | null;
  goal_id: string | null;
  deadline: string | null;
  created_at: string;
}

const ALL_SURFACES: UnifiedSearchSurface[] = [
  "memories",
  "predictions",
  "contradictions",
  "goals",
  "tasks",
];

/**
 * Test whether a SQLite table exists. Used because not every deployment
 * has all five tables (e.g. tasks/goals are optional features). Missing
 * tables produce an empty array rather than an error.
 */
function tableExists(db: DatabaseSync, name: string): boolean {
  try {
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = ?"
      )
      .get(name) as { name: string } | undefined;
    return row !== undefined;
  } catch {
    return false;
  }
}

/** Build a `WHERE col LIKE ? OR col2 LIKE ?` fragment with a single bound pattern. */
function likePattern(query: string): string {
  // Escape SQL LIKE wildcards so user-supplied % and _ don't act as wildcards
  const escaped = query.replace(/[%_\\]/g, (c) => `\\${c}`);
  return `%${escaped}%`;
}

export async function unifiedSearch(
  db: DatabaseSync,
  query: string,
  options: UnifiedSearchOptions = {},
): Promise<UnifiedSearchResult> {
  const limit = options.limit_per_surface ?? 5;
  const surfaces = options.surfaces ?? ALL_SURFACES;
  const pattern = likePattern(query);
  const statusList = options.status_filter && options.status_filter.length > 0
    ? options.status_filter
    : null;

  const result: UnifiedSearchResult = {
    query,
    memories: [],
    predictions: [],
    contradictions: [],
    goals: [],
    tasks: [],
    total_hits: 0,
    surfaces_searched: [],
  };

  // --- memories: use full hybrid search pipeline ---
  if (surfaces.includes("memories")) {
    result.surfaces_searched.push("memories");
    try {
      const memSearch = new MemorySearch(db);
      result.memories = await memSearch.search(
        { query, limit, namespace: options.namespace },
        options.reranker,
      );
    } catch {
      // Search failures (missing embeddings provider, etc.) shouldn't fail
      // the whole unified call — other surfaces remain useful.
      result.memories = [];
    }
  }

  // --- predictions ---
  if (surfaces.includes("predictions") && tableExists(db, "predictions")) {
    result.surfaces_searched.push("predictions");
    const statusClause = statusList
      ? ` AND status IN (${statusList.map(() => "?").join(", ")})`
      : "";
    const sql = `
      SELECT id, claim, confidence, status, domain, deadline, resolution, created_at
      FROM predictions
      WHERE (LOWER(claim) LIKE LOWER(?) ESCAPE '\\'
             OR LOWER(COALESCE(resolution_notes, '')) LIKE LOWER(?) ESCAPE '\\')${statusClause}
      ORDER BY created_at DESC
      LIMIT ?
    `;
    const params: unknown[] = [pattern, pattern];
    if (statusList) params.push(...statusList);
    params.push(limit);
    try {
      result.predictions = db.prepare(sql).all(...(params as never[])) as unknown as PredictionHit[];
    } catch {
      result.predictions = [];
    }
  }

  // --- contradictions ---
  if (surfaces.includes("contradictions") && tableExists(db, "contradictions")) {
    result.surfaces_searched.push("contradictions");
    const statusClause = statusList
      ? ` AND status IN (${statusList.map(() => "?").join(", ")})`
      : "";
    const sql = `
      SELECT id, description, status, memory_a_id, memory_b_id, resolution, created_at
      FROM contradictions
      WHERE (LOWER(description) LIKE LOWER(?) ESCAPE '\\'
             OR LOWER(COALESCE(resolution, '')) LIKE LOWER(?) ESCAPE '\\')${statusClause}
      ORDER BY created_at DESC
      LIMIT ?
    `;
    const params: unknown[] = [pattern, pattern];
    if (statusList) params.push(...statusList);
    params.push(limit);
    try {
      result.contradictions = db.prepare(sql).all(...(params as never[])) as unknown as ContradictionHit[];
    } catch {
      result.contradictions = [];
    }
  }

  // --- goals ---
  if (surfaces.includes("goals") && tableExists(db, "goals")) {
    result.surfaces_searched.push("goals");
    const statusClause = statusList
      ? ` AND status IN (${statusList.map(() => "?").join(", ")})`
      : "";
    const sql = `
      SELECT id, title, description, status, priority, deadline, created_at
      FROM goals
      WHERE (LOWER(title) LIKE LOWER(?) ESCAPE '\\'
             OR LOWER(COALESCE(description, '')) LIKE LOWER(?) ESCAPE '\\')${statusClause}
      ORDER BY
        CASE status WHEN 'active' THEN 0 ELSE 1 END,
        CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        created_at DESC
      LIMIT ?
    `;
    const params: unknown[] = [pattern, pattern];
    if (statusList) params.push(...statusList);
    params.push(limit);
    try {
      result.goals = db.prepare(sql).all(...(params as never[])) as unknown as GoalHit[];
    } catch {
      result.goals = [];
    }
  }

  // --- tasks ---
  if (surfaces.includes("tasks") && tableExists(db, "agent_tasks")) {
    result.surfaces_searched.push("tasks");
    const statusClause = statusList
      ? ` AND status IN (${statusList.map(() => "?").join(", ")})`
      : "";
    const sql = `
      SELECT id, title, description, status, assignee, goal_id, deadline, created_at
      FROM agent_tasks
      WHERE (LOWER(title) LIKE LOWER(?) ESCAPE '\\'
             OR LOWER(COALESCE(description, '')) LIKE LOWER(?) ESCAPE '\\'
             OR LOWER(COALESCE(result, '')) LIKE LOWER(?) ESCAPE '\\')${statusClause}
      ORDER BY
        CASE status WHEN 'in_progress' THEN 0 WHEN 'assigned' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
        created_at DESC
      LIMIT ?
    `;
    const params: unknown[] = [pattern, pattern, pattern];
    if (statusList) params.push(...statusList);
    params.push(limit);
    try {
      result.tasks = db.prepare(sql).all(...(params as never[])) as unknown as TaskHit[];
    } catch {
      result.tasks = [];
    }
  }

  result.total_hits =
    result.memories.length +
    result.predictions.length +
    result.contradictions.length +
    result.goals.length +
    result.tasks.length;

  return result;
}
