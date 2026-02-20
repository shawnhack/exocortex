import { Hono } from "hono";
import { getDb, GoalStore } from "@exocortex/core";

const goals = new Hono();

/**
 * GET /api/goals — List goals, optionally filtered by status.
 * Query params: status (active|completed|stalled|abandoned), default: active
 */
goals.get("/api/goals", (c) => {
  const db = getDb();
  const store = new GoalStore(db);
  const status = (c.req.query("status") ?? "active") as "active" | "completed" | "stalled" | "abandoned";

  const goalsList = store.list(status);

  return c.json({
    goals: goalsList.map((g) => ({
      id: g.id,
      title: g.title,
      description: g.description,
      status: g.status,
      priority: g.priority,
      deadline: g.deadline,
      metadata: g.metadata,
      created_at: g.created_at,
      updated_at: g.updated_at,
      completed_at: g.completed_at,
    })),
    count: goalsList.length,
  });
});

export default goals;
