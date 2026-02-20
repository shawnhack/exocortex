import { Hono } from "hono";
import { getDb, GoalStore } from "@exocortex/core";

const goals = new Hono();

/**
 * GET /api/goals — List goals, optionally filtered by status.
 * Query params: status (active|completed|stalled|abandoned|all), default: active
 */
goals.get("/api/goals", (c) => {
  const db = getDb();
  const store = new GoalStore(db);
  const statusParam = c.req.query("status") ?? "active";

  let goalsList;
  if (statusParam === "all") {
    // Fetch all statuses
    const active = store.list("active");
    const completed = store.list("completed");
    const stalled = store.list("stalled");
    const abandoned = store.list("abandoned");
    goalsList = [...active, ...stalled, ...completed, ...abandoned];
  } else {
    goalsList = store.list(statusParam as "active" | "completed" | "stalled" | "abandoned");
  }

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

/**
 * GET /api/goals/:id — Get a single goal with milestones and progress.
 */
goals.get("/api/goals/:id", (c) => {
  const db = getDb();
  const store = new GoalStore(db);
  const id = c.req.param("id");

  const goal = store.getWithProgress(id);
  if (!goal) return c.json({ error: "Goal not found" }, 404);

  return c.json(goal);
});

/**
 * POST /api/goals — Create a new goal.
 */
goals.post("/api/goals", async (c) => {
  const db = getDb();
  const store = new GoalStore(db);
  const body = await c.req.json();

  const goal = store.create({
    title: body.title,
    description: body.description,
    priority: body.priority,
    deadline: body.deadline,
    metadata: body.metadata,
  });

  return c.json(goal, 201);
});

/**
 * PATCH /api/goals/:id — Update a goal.
 */
goals.patch("/api/goals/:id", async (c) => {
  const db = getDb();
  const store = new GoalStore(db);
  const id = c.req.param("id");
  const body = await c.req.json();

  const updated = store.update(id, {
    title: body.title,
    description: body.description,
    status: body.status,
    priority: body.priority,
    deadline: body.deadline,
    metadata: body.metadata,
  });

  if (!updated) return c.json({ error: "Goal not found" }, 404);
  return c.json(updated);
});

/**
 * DELETE /api/goals/:id — Delete a goal.
 */
goals.delete("/api/goals/:id", (c) => {
  const db = getDb();
  const store = new GoalStore(db);
  const id = c.req.param("id");

  const deleted = store.delete(id);
  if (!deleted) return c.json({ error: "Goal not found" }, 404);
  return c.json({ ok: true });
});

export default goals;
