import { Hono } from "hono";
import { z } from "zod";
import { getDb, GoalStore } from "@exocortex/core";

const createGoalSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(5000).optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  deadline: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const updateGoalSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(5000).nullable().optional(),
  status: z.enum(["active", "completed", "stalled", "abandoned"]).optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  deadline: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

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

  const parsed = createGoalSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const goal = store.create({
    title: parsed.data.title,
    description: parsed.data.description,
    priority: parsed.data.priority,
    deadline: parsed.data.deadline,
    metadata: parsed.data.metadata,
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

  const parsed = updateGoalSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const updated = store.update(id, {
    title: parsed.data.title,
    description: parsed.data.description ?? undefined,
    status: parsed.data.status,
    priority: parsed.data.priority,
    deadline: parsed.data.deadline ?? undefined,
    metadata: parsed.data.metadata,
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
