export type AgentTaskStatus = "pending" | "assigned" | "in_progress" | "completed" | "failed" | "blocked";
export type AgentTaskPriority = "low" | "medium" | "high" | "critical";

export interface AgentTask {
  id: string;
  title: string;
  description: string | null;
  assignee: string | null;
  created_by: string;
  status: AgentTaskStatus;
  priority: AgentTaskPriority;
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

export interface CreateAgentTaskInput {
  title: string;
  description?: string;
  assignee?: string;
  created_by: string;
  priority?: AgentTaskPriority;
  goal_id?: string;
  parent_task_id?: string;
  dependencies?: string[];
  metadata?: Record<string, unknown>;
  deadline?: string;
}

export interface UpdateAgentTaskInput {
  title?: string;
  description?: string;
  assignee?: string | null;
  status?: AgentTaskStatus;
  priority?: AgentTaskPriority;
  result?: string;
  metadata?: Record<string, unknown>;
  deadline?: string | null;
}

export interface AgentTaskFilter {
  assignee?: string;
  created_by?: string;
  status?: AgentTaskStatus;
  goal_id?: string;
  priority?: AgentTaskPriority;
  limit?: number;
}
