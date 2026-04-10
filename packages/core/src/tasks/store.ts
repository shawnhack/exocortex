import type { DatabaseSync } from "node:sqlite";
import { ulid } from "ulid";
import type {
  AgentTask,
  AgentTaskStatus,
  CreateAgentTaskInput,
  UpdateAgentTaskInput,
  AgentTaskFilter,
} from "./types.js";

interface AgentTaskRow {
  id: string;
  title: string;
  description: string | null;
  assignee: string | null;
  created_by: string;
  status: string;
  priority: string;
  goal_id: string | null;
  parent_task_id: string | null;
  dependencies: string | null;
  result: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
  assigned_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  deadline: string | null;
}

function safeJsonParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try { return JSON.parse(json); } catch { return fallback; }
}

function rowToTask(row: AgentTaskRow): AgentTask {
  return {
    ...row,
    status: row.status as AgentTaskStatus,
    priority: row.priority as AgentTask["priority"],
    dependencies: safeJsonParse<string[]>(row.dependencies, []),
    metadata: safeJsonParse<Record<string, unknown>>(row.metadata, {}),
  };
}

function now(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

const initializedDbs = new WeakSet<object>();

function ensureSchema(db: DatabaseSync): void {
  if (initializedDbs.has(db)) return;
  initializedDbs.add(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      assignee TEXT,
      created_by TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'assigned', 'in_progress', 'completed', 'failed', 'blocked')),
      priority TEXT NOT NULL DEFAULT 'medium'
        CHECK(priority IN ('low', 'medium', 'high', 'critical')),
      goal_id TEXT,
      parent_task_id TEXT REFERENCES agent_tasks(id),
      dependencies TEXT DEFAULT '[]',
      result TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      assigned_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      deadline TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_assignee ON agent_tasks(assignee);
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_goal ON agent_tasks(goal_id);
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_created ON agent_tasks(created_at);
  `);
}

export class AgentTaskStore {
  constructor(private db: DatabaseSync) {
    ensureSchema(db);
  }

  create(input: CreateAgentTaskInput): AgentTask {
    const id = ulid();
    const ts = now();
    const assignedAt = input.assignee ? ts : null;
    const status = input.assignee ? "assigned" : "pending";

    this.db
      .prepare(
        `INSERT INTO agent_tasks (id, title, description, assignee, created_by, status, priority, goal_id, parent_task_id, dependencies, metadata, deadline, assigned_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.title,
        input.description ?? null,
        input.assignee ?? null,
        input.created_by,
        status,
        input.priority ?? "medium",
        input.goal_id ?? null,
        input.parent_task_id ?? null,
        JSON.stringify(input.dependencies ?? []),
        JSON.stringify(input.metadata ?? {}),
        input.deadline ?? null,
        assignedAt,
        ts,
        ts
      );

    return this.getById(id)!;
  }

  getById(id: string): AgentTask | null {
    const row = this.db
      .prepare("SELECT * FROM agent_tasks WHERE id = ?")
      .get(id) as AgentTaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  list(filter?: AgentTaskFilter): AgentTask[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.assignee) {
      conditions.push("assignee = ?");
      params.push(filter.assignee);
    }
    if (filter?.created_by) {
      conditions.push("created_by = ?");
      params.push(filter.created_by);
    }
    if (filter?.status) {
      conditions.push("status = ?");
      params.push(filter.status);
    }
    if (filter?.goal_id) {
      conditions.push("goal_id = ?");
      params.push(filter.goal_id);
    }
    if (filter?.priority) {
      conditions.push("priority = ?");
      params.push(filter.priority);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filter?.limit ?? 50;
    params.push(limit);

    const rows = this.db
      .prepare(`SELECT * FROM agent_tasks ${where} ORDER BY
        CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
        created_at DESC LIMIT ?`)
      .all(...(params as string[])) as unknown as AgentTaskRow[];

    return rows.map(rowToTask);
  }

  update(id: string, input: UpdateAgentTaskInput): AgentTask | null {
    const existing = this.getById(id);
    if (!existing) return null;

    const ts = now();
    const sets: string[] = ["updated_at = ?"];
    const params: (string | null)[] = [ts];

    if (input.title !== undefined) { sets.push("title = ?"); params.push(input.title); }
    if (input.description !== undefined) { sets.push("description = ?"); params.push(input.description); }
    if (input.priority !== undefined) { sets.push("priority = ?"); params.push(input.priority); }
    if (input.result !== undefined) { sets.push("result = ?"); params.push(input.result); }
    if (input.deadline !== undefined) { sets.push("deadline = ?"); params.push(input.deadline); }
    if (input.metadata !== undefined) {
      sets.push("metadata = ?");
      params.push(JSON.stringify({ ...existing.metadata, ...input.metadata }));
    }

    if (input.assignee !== undefined) {
      sets.push("assignee = ?");
      params.push(input.assignee);
      if (input.assignee && !existing.assigned_at) {
        sets.push("assigned_at = ?");
        params.push(ts);
      }
    }

    if (input.status !== undefined) {
      sets.push("status = ?");
      params.push(input.status);
      if (input.status === "in_progress" && !existing.started_at) {
        sets.push("started_at = ?");
        params.push(ts);
      }
      if ((input.status === "completed" || input.status === "failed") && !existing.completed_at) {
        sets.push("completed_at = ?");
        params.push(ts);
      }
    }

    params.push(id);
    this.db
      .prepare(`UPDATE agent_tasks SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);

    return this.getById(id);
  }

  /**
   * Claim the next available task for an agent.
   * Finds highest-priority pending/assigned task for this agent and marks it in_progress.
   */
  claim(assignee: string): AgentTask | null {
    const row = this.db
      .prepare(
        `SELECT * FROM agent_tasks
         WHERE assignee = ? AND status IN ('pending', 'assigned')
         ORDER BY
           CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
           created_at ASC
         LIMIT 1`
      )
      .get(assignee) as AgentTaskRow | undefined;

    if (!row) return null;

    return this.update(row.id, { status: "in_progress" });
  }

  /**
   * Complete a task with a result.
   */
  complete(id: string, result: string): AgentTask | null {
    return this.update(id, { status: "completed", result });
  }

  /**
   * Fail a task with an error message.
   */
  fail(id: string, error: string): AgentTask | null {
    return this.update(id, { status: "failed", result: error });
  }

  /**
   * Get subtasks for a parent task.
   */
  getSubtasks(parentId: string): AgentTask[] {
    const rows = this.db
      .prepare("SELECT * FROM agent_tasks WHERE parent_task_id = ? ORDER BY created_at ASC")
      .all(parentId) as unknown as AgentTaskRow[];
    return rows.map(rowToTask);
  }

  /**
   * Get tasks linked to a goal.
   */
  getForGoal(goalId: string): AgentTask[] {
    const rows = this.db
      .prepare("SELECT * FROM agent_tasks WHERE goal_id = ? ORDER BY created_at DESC")
      .all(goalId) as unknown as AgentTaskRow[];
    return rows.map(rowToTask);
  }

  /**
   * Summary stats for dashboard.
   */
  getStats(): { total: number; by_status: Record<string, number>; by_assignee: Record<string, number> } {
    const statusRows = this.db
      .prepare("SELECT status, COUNT(*) as count FROM agent_tasks GROUP BY status")
      .all() as Array<{ status: string; count: number }>;

    const assigneeRows = this.db
      .prepare("SELECT COALESCE(assignee, 'unassigned') as assignee, COUNT(*) as count FROM agent_tasks WHERE status NOT IN ('completed', 'failed') GROUP BY assignee")
      .all() as Array<{ assignee: string; count: number }>;

    const by_status: Record<string, number> = {};
    let total = 0;
    for (const r of statusRows) { by_status[r.status] = r.count; total += r.count; }

    const by_assignee: Record<string, number> = {};
    for (const r of assigneeRows) { by_assignee[r.assignee] = r.count; }

    return { total, by_status, by_assignee };
  }

  delete(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM agent_tasks WHERE id = ?")
      .run(id);
    return (result as { changes: number }).changes > 0;
  }
}
