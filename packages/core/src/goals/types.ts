export type GoalStatus = 'active' | 'completed' | 'stalled' | 'abandoned';
export type GoalPriority = 'low' | 'medium' | 'high' | 'critical';

export interface Goal {
  id: string;
  title: string;
  description: string | null;
  status: GoalStatus;
  priority: GoalPriority;
  deadline: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface CreateGoalInput {
  title: string;
  description?: string;
  priority?: GoalPriority;
  deadline?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateGoalInput {
  title?: string;
  description?: string;
  status?: GoalStatus;
  priority?: GoalPriority;
  deadline?: string;
  metadata?: Record<string, unknown>;
}

export interface GoalWithProgress extends Goal {
  progress: GoalProgressEntry[];
}

export interface GoalProgressEntry {
  id: string;
  content: string;
  created_at: string;
}
