import type { DatabaseSync } from "node:sqlite";
import { ulid } from "ulid";
import { MemoryStore } from "../memory/store.js";
import { cosineSimilarity } from "../memory/scoring.js";
import { getEmbeddingProvider } from "../embedding/manager.js";
import type {
  Goal,
  GoalStatus,
  CreateGoalInput,
  UpdateGoalInput,
  GoalWithProgress,
  GoalProgressEntry,
  Milestone,
  CreateMilestoneInput,
} from "./types.js";

interface GoalRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  deadline: string | null;
  metadata: string;
  embedding: Uint8Array | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function rowToGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status as Goal["status"],
    priority: row.priority as Goal["priority"],
    deadline: row.deadline,
    metadata: JSON.parse(row.metadata),
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
  };
}

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "as", "is", "was", "are", "were", "be",
  "been", "being", "have", "has", "had", "do", "does", "did", "will",
  "would", "could", "should", "may", "might", "shall", "can", "not",
  "this", "that", "these", "those", "it", "its", "my", "your", "our",
]);

const SEMANTIC_THRESHOLD = 0.4;

export class GoalStore {
  constructor(private db: DatabaseSync) {}

  create(input: CreateGoalInput): Goal {
    const id = ulid();
    const now = new Date().toISOString().replace("T", " ").replace("Z", "");

    this.db
      .prepare(
        `INSERT INTO goals (id, title, description, priority, deadline, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.title,
        input.description ?? null,
        input.priority ?? "medium",
        input.deadline ?? null,
        JSON.stringify(input.metadata ?? {}),
        now,
        now
      );

    return this.getById(id)!;
  }

  getById(id: string): Goal | null {
    const row = this.db
      .prepare("SELECT * FROM goals WHERE id = ?")
      .get(id) as GoalRow | undefined;

    return row ? rowToGoal(row) : null;
  }

  list(status?: GoalStatus): Goal[] {
    let rows: GoalRow[];
    if (status) {
      rows = this.db
        .prepare("SELECT * FROM goals WHERE status = ? ORDER BY created_at DESC")
        .all(status) as unknown as GoalRow[];
    } else {
      rows = this.db
        .prepare("SELECT * FROM goals ORDER BY created_at DESC")
        .all() as unknown as GoalRow[];
    }
    return rows.map(rowToGoal);
  }

  update(id: string, input: UpdateGoalInput): Goal | null {
    const existing = this.getById(id);
    if (!existing) return null;

    const now = new Date().toISOString().replace("T", " ").replace("Z", "");
    const sets: string[] = ["updated_at = ?"];
    const params: (string | null)[] = [now];

    if (input.title !== undefined) {
      sets.push("title = ?");
      params.push(input.title);
      // Clear embedding so it gets re-embedded on next comparison
      sets.push("embedding = NULL");
    }

    if (input.description !== undefined) {
      sets.push("description = ?");
      params.push(input.description);
      // Description change also invalidates the embedding
      sets.push("embedding = NULL");
    }

    if (input.status !== undefined) {
      sets.push("status = ?");
      params.push(input.status);

      if (input.status === "completed") {
        sets.push("completed_at = ?");
        params.push(now);
      } else {
        sets.push("completed_at = NULL");
      }
    }

    if (input.priority !== undefined) {
      sets.push("priority = ?");
      params.push(input.priority);
    }

    if (input.deadline !== undefined) {
      sets.push("deadline = ?");
      params.push(input.deadline);
    }

    if (input.metadata !== undefined) {
      // Merge with existing metadata
      const merged = { ...existing.metadata, ...input.metadata };
      // Remove null values
      for (const [k, v] of Object.entries(merged)) {
        if (v === null) delete merged[k];
      }
      sets.push("metadata = ?");
      params.push(JSON.stringify(merged));
    }

    params.push(id);

    this.db
      .prepare(`UPDATE goals SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);

    return this.getById(id);
  }

  delete(id: string): boolean {
    const result = this.db.prepare("DELETE FROM goals WHERE id = ?").run(id);
    return (result as { changes: number }).changes > 0;
  }

  /**
   * Log progress — creates a memory tagged ["goal-progress"] with metadata { goal_id }.
   * Returns the memory ID.
   */
  async logProgress(
    goalId: string,
    content: string,
    importance?: number
  ): Promise<string> {
    const goal = this.getById(goalId);
    if (!goal) throw new Error(`Goal ${goalId} not found`);

    const store = new MemoryStore(this.db);
    const result = await store.create({
      content,
      content_type: "note",
      source: "mcp",
      importance: importance ?? 0.5,
      tags: ["goal-progress"],
      metadata: { goal_id: goalId },
    });

    // Touch the goal's updated_at
    const now = new Date().toISOString().replace("T", " ").replace("Z", "");
    this.db
      .prepare("UPDATE goals SET updated_at = ? WHERE id = ?")
      .run(now, goalId);

    return result.memory.id;
  }

  /**
   * Get goal with recent progress entries and milestones.
   */
  getWithProgress(
    id: string,
    progressLimit = 10
  ): GoalWithProgress | null {
    const goal = this.getById(id);
    if (!goal) return null;

    const progress = this.getProgressEntries(id, progressLimit);
    const milestones = this.getMilestones(id);

    return { ...goal, progress, milestones };
  }

  /**
   * Add a milestone to a goal. Stored in metadata.milestones JSON array.
   */
  addMilestone(goalId: string, input: CreateMilestoneInput): Milestone {
    const goal = this.getById(goalId);
    if (!goal) throw new Error(`Goal ${goalId} not found`);

    const milestones: Milestone[] = (goal.metadata.milestones as Milestone[]) ?? [];
    const maxOrder = milestones.length > 0
      ? Math.max(...milestones.map((m) => m.order))
      : 0;

    const milestone: Milestone = {
      id: ulid(),
      title: input.title,
      status: 'pending',
      order: input.order ?? maxOrder + 1,
      deadline: input.deadline ?? null,
      completed_at: null,
    };

    milestones.push(milestone);
    this.update(goalId, { metadata: { milestones } });

    return milestone;
  }

  /**
   * Update a milestone within a goal.
   */
  updateMilestone(
    goalId: string,
    milestoneId: string,
    updates: Partial<Pick<Milestone, 'title' | 'status' | 'order' | 'deadline'>>
  ): Milestone | null {
    const goal = this.getById(goalId);
    if (!goal) return null;

    const milestones: Milestone[] = (goal.metadata.milestones as Milestone[]) ?? [];
    const idx = milestones.findIndex((m) => m.id === milestoneId);
    if (idx === -1) return null;

    if (updates.title !== undefined) milestones[idx].title = updates.title;
    if (updates.status !== undefined) {
      milestones[idx].status = updates.status;
      if (updates.status === 'completed') {
        milestones[idx].completed_at = new Date().toISOString().replace("T", " ").replace("Z", "");
      }
    }
    if (updates.order !== undefined) milestones[idx].order = updates.order;
    if (updates.deadline !== undefined) milestones[idx].deadline = updates.deadline;

    this.update(goalId, { metadata: { milestones } });
    return milestones[idx];
  }

  /**
   * Remove a milestone from a goal.
   */
  removeMilestone(goalId: string, milestoneId: string): boolean {
    const goal = this.getById(goalId);
    if (!goal) return false;

    const milestones: Milestone[] = (goal.metadata.milestones as Milestone[]) ?? [];
    const idx = milestones.findIndex((m) => m.id === milestoneId);
    if (idx === -1) return false;

    milestones.splice(idx, 1);
    this.update(goalId, { metadata: { milestones } });
    return true;
  }

  /**
   * Get milestones for a goal, sorted by order.
   */
  getMilestones(goalId: string): Milestone[] {
    const goal = this.getById(goalId);
    if (!goal) return [];

    const milestones: Milestone[] = (goal.metadata.milestones as Milestone[]) ?? [];
    return milestones.sort((a, b) => a.order - b.order);
  }

  /**
   * Find stalled goals — active goals with no progress in N days.
   */
  findStalled(stallDays = 7): Goal[] {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - stallDays);
    const cutoffStr = cutoff.toISOString().replace("T", " ").replace("Z", "");

    // Get active goals
    const activeGoals = this.list("active");

    return activeGoals.filter((goal) => {
      // Check for any progress memory with this goal_id after the cutoff
      const recentProgress = this.db
        .prepare(
          `SELECT COUNT(*) as count FROM memories m
           INNER JOIN memory_tags mt ON m.id = mt.memory_id AND mt.tag = 'goal-progress'
           WHERE m.is_active = 1
             AND m.metadata LIKE ?
             AND m.created_at >= ?`
        )
        .get(`%"goal_id":"${goal.id}"%`, cutoffStr) as { count: number };

      return recentProgress.count === 0;
    });
  }

  /**
   * Detect active goals relevant to the given content.
   * Uses semantic (embedding) matching when available, falls back to keywords.
   * Returns goals sorted by relevance (best first).
   */
  async detectRelevantGoals(
    content: string,
    contentEmbedding?: Float32Array | null
  ): Promise<Goal[]> {
    const activeGoals = this.list("active");
    if (activeGoals.length === 0) return [];

    // Try semantic matching when we have an embedding for the content
    if (contentEmbedding) {
      const goalEmbeddings = await this.ensureGoalEmbeddings(activeGoals);
      if (goalEmbeddings.size > 0) {
        const matches: Array<{ goal: Goal; score: number }> = [];

        for (const goal of activeGoals) {
          const goalEmb = goalEmbeddings.get(goal.id);
          if (!goalEmb) continue;

          const similarity = cosineSimilarity(contentEmbedding, goalEmb);
          if (similarity >= SEMANTIC_THRESHOLD) {
            matches.push({ goal, score: similarity });
          }
        }

        if (matches.length > 0) {
          matches.sort((a, b) => b.score - a.score);
          return matches.map((m) => m.goal);
        }
      }
    }

    // Fallback: keyword matching
    return this.detectRelevantGoalsByKeyword(content, activeGoals);
  }

  /**
   * Auto-link a newly stored memory to relevant active goals.
   * Adds goal-progress + goal-progress-implicit tags and goal_id metadata.
   * Returns IDs of linked goals.
   */
  async autoLinkProgress(
    memoryId: string,
    content: string,
    contentEmbedding?: Float32Array | null
  ): Promise<string[]> {
    const relevant = await this.detectRelevantGoals(content, contentEmbedding);
    if (relevant.length === 0) return [];

    const goal = relevant[0];

    // Add tags
    const insertTag = this.db.prepare(
      "INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)"
    );
    insertTag.run(memoryId, "goal-progress");
    insertTag.run(memoryId, "goal-progress-implicit");

    // Merge goal_id into existing metadata
    const row = this.db
      .prepare("SELECT metadata FROM memories WHERE id = ?")
      .get(memoryId) as { metadata: string | null } | undefined;
    const existing: Record<string, unknown> = row?.metadata
      ? JSON.parse(row.metadata)
      : {};
    existing.goal_id = goal.id;
    this.db
      .prepare("UPDATE memories SET metadata = ? WHERE id = ?")
      .run(JSON.stringify(existing), memoryId);

    // Touch goal's updated_at
    const now = new Date().toISOString().replace("T", " ").replace("Z", "");
    this.db
      .prepare("UPDATE goals SET updated_at = ? WHERE id = ?")
      .run(now, goal.id);

    return [goal.id];
  }

  /**
   * Ensure all given goals have embeddings. Embeds missing ones lazily.
   * Returns a map of goal ID → Float32Array embedding.
   */
  private async ensureGoalEmbeddings(
    goals: Goal[]
  ): Promise<Map<string, Float32Array>> {
    const embeddings = new Map<string, Float32Array>();
    const toEmbed: Goal[] = [];

    for (const goal of goals) {
      const row = this.db
        .prepare("SELECT embedding FROM goals WHERE id = ?")
        .get(goal.id) as { embedding: Uint8Array | null } | undefined;

      if (row?.embedding) {
        const bytes = row.embedding as unknown as Uint8Array;
        embeddings.set(
          goal.id,
          new Float32Array(new Uint8Array(bytes).buffer)
        );
      } else {
        toEmbed.push(goal);
      }
    }

    if (toEmbed.length > 0) {
      try {
        const provider = await getEmbeddingProvider();
        for (const goal of toEmbed) {
          const text = goal.description
            ? `${goal.title}: ${goal.description}`
            : goal.title;
          const embedding = await provider.embed(text);
          const blob = new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);
          this.db
            .prepare("UPDATE goals SET embedding = ? WHERE id = ?")
            .run(blob, goal.id);
          embeddings.set(goal.id, embedding);
        }
      } catch {
        // Embedding provider unavailable — return what we have
      }
    }

    return embeddings;
  }

  /**
   * Keyword-based goal matching (fallback when embeddings unavailable).
   */
  private detectRelevantGoalsByKeyword(
    content: string,
    activeGoals: Goal[]
  ): Goal[] {
    const contentLower = content.toLowerCase();
    const matches: Array<{ goal: Goal; score: number }> = [];

    for (const goal of activeGoals) {
      const titleWords = goal.title
        .toLowerCase()
        .split(/[\s\-_/]+/)
        .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));

      if (titleWords.length === 0) continue;

      const matchCount = titleWords.filter((w) => contentLower.includes(w)).length;
      const ratio = matchCount / titleWords.length;

      if (ratio >= 0.5 && matchCount >= 1) {
        matches.push({ goal, score: ratio });
      }
    }

    matches.sort((a, b) => b.score - a.score);
    return matches.map((m) => m.goal);
  }

  /**
   * Get progress entries for a goal from memories.
   */
  private getProgressEntries(
    goalId: string,
    limit: number
  ): GoalProgressEntry[] {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.content, m.created_at FROM memories m
         INNER JOIN memory_tags mt ON m.id = mt.memory_id AND mt.tag = 'goal-progress'
         WHERE m.is_active = 1
           AND m.metadata LIKE ?
         ORDER BY m.created_at DESC
         LIMIT ?`
      )
      .all(`%"goal_id":"${goalId}"%`, limit) as Array<{
      id: string;
      content: string;
      created_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      content: r.content,
      created_at: r.created_at,
    }));
  }
}
