import { Hono } from "hono";
import { getDb, AgentTaskStore } from "@exocortex/core";
import type { AgentTaskStatus, AgentTaskPriority } from "@exocortex/core";

const tasks = new Hono();

/**
 * GET /api/tasks — List tasks with optional filters.
 */
tasks.get("/api/tasks", (c) => {
  const db = getDb();
  const store = new AgentTaskStore(db);

  const assignee = c.req.query("assignee") ?? undefined;
  const status = c.req.query("status") as AgentTaskStatus | undefined;
  const goal_id = c.req.query("goal_id") ?? undefined;
  const priority = c.req.query("priority") as AgentTaskPriority | undefined;
  const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : undefined;

  const list = store.list({ assignee, status, goal_id, priority, limit });
  return c.json({ tasks: list, count: list.length });
});

/**
 * GET /api/tasks/stats — Task queue stats.
 */
tasks.get("/api/tasks/stats", (c) => {
  const db = getDb();
  const store = new AgentTaskStore(db);
  return c.json(store.getStats());
});

/**
 * GET /api/tasks/:id — Get a single task.
 */
tasks.get("/api/tasks/:id", (c) => {
  const db = getDb();
  const store = new AgentTaskStore(db);
  const task = store.getById(c.req.param("id"));
  if (!task) return c.json({ error: "Task not found" }, 404);
  return c.json(task);
});

/**
 * GET /api/tasks/:id/subtasks — Get subtasks.
 */
tasks.get("/api/tasks/:id/subtasks", (c) => {
  const db = getDb();
  const store = new AgentTaskStore(db);
  const subtasks = store.getSubtasks(c.req.param("id"));
  return c.json({ subtasks, count: subtasks.length });
});

/**
 * POST /api/tasks — Create a task.
 */
tasks.post("/api/tasks", async (c) => {
  const db = getDb();
  const store = new AgentTaskStore(db);
  const body = await c.req.json();

  if (!body.title || !body.created_by) {
    return c.json({ error: "title and created_by are required" }, 400);
  }

  const task = store.create(body);
  return c.json(task, 201);
});

/**
 * PATCH /api/tasks/:id — Update a task.
 */
tasks.patch("/api/tasks/:id", async (c) => {
  const db = getDb();
  const store = new AgentTaskStore(db);
  const body = await c.req.json();

  const updated = store.update(c.req.param("id"), body);
  if (!updated) return c.json({ error: "Task not found" }, 404);
  return c.json(updated);
});

/**
 * DELETE /api/tasks/:id — Delete a task.
 */
tasks.delete("/api/tasks/:id", (c) => {
  const db = getDb();
  const store = new AgentTaskStore(db);
  const deleted = store.delete(c.req.param("id"));
  if (!deleted) return c.json({ error: "Task not found" }, 404);
  return c.json({ ok: true });
});

export default tasks;
