import { Hono } from "hono";
import { z } from "zod";
import { getDb, PredictionStore } from "@exocortex/core";

const domainEnum = z.enum(["technical", "product", "market", "personal", "political", "scientific", "general"]);
const sourceEnum = z.enum(["user", "sentinel", "agent", "mcp"]);
const resolutionEnum = z.enum(["true", "false", "partial"]);

const createSchema = z.object({
  claim: z.string().min(1).max(2000),
  confidence: z.number().min(0).max(1),
  domain: domainEnum.optional(),
  source: sourceEnum.optional(),
  deadline: z.string().optional(),
  goal_id: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const resolveSchema = z.object({
  resolution: resolutionEnum,
  resolution_notes: z.string().max(5000).optional(),
  resolution_memory_id: z.string().optional(),
});

const voidSchema = z.object({
  void: z.literal(true),
  reason: z.string().max(2000).optional(),
});

const patchSchema = z.union([resolveSchema, voidSchema]);

const predictions = new Hono();

/**
 * GET /api/predictions — List predictions with optional filters.
 */
predictions.get("/api/predictions", (c) => {
  const db = getDb();
  const store = new PredictionStore(db);

  const status = c.req.query("status") as "open" | "resolved" | "voided" | undefined;
  const domain = c.req.query("domain") as "technical" | "product" | "market" | "personal" | "political" | "scientific" | "general" | undefined;
  const source = c.req.query("source") as "user" | "sentinel" | "agent" | "mcp" | undefined;
  const overdue = c.req.query("overdue") === "true";
  const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : undefined;

  const list = store.list({ status, domain, source, overdue, limit });

  return c.json({
    predictions: list,
    count: list.length,
  });
});

/**
 * GET /api/predictions/stats — Calibration stats.
 */
predictions.get("/api/predictions/stats", (c) => {
  const db = getDb();
  const store = new PredictionStore(db);

  const domain = c.req.query("domain") ?? undefined;
  const source = c.req.query("source") ?? undefined;

  const stats = store.getStats({ domain, source });
  return c.json(stats);
});

/**
 * GET /api/predictions/:id — Get a single prediction.
 */
predictions.get("/api/predictions/:id", (c) => {
  const db = getDb();
  const store = new PredictionStore(db);
  const id = c.req.param("id");

  const prediction = store.getById(id);
  if (!prediction) return c.json({ error: "Prediction not found" }, 404);

  return c.json(prediction);
});

/**
 * POST /api/predictions — Create a new prediction.
 */
predictions.post("/api/predictions", async (c) => {
  const db = getDb();
  const store = new PredictionStore(db);
  const body = await c.req.json();

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const prediction = store.create(parsed.data);
  return c.json(prediction, 201);
});

/**
 * PATCH /api/predictions/:id — Resolve or void a prediction.
 */
predictions.patch("/api/predictions/:id", async (c) => {
  const db = getDb();
  const store = new PredictionStore(db);
  const id = c.req.param("id");
  const body = await c.req.json();

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  try {
    if ("void" in parsed.data) {
      const updated = store.void(id, parsed.data.reason);
      if (!updated) return c.json({ error: "Prediction not found" }, 404);
      return c.json(updated);
    } else {
      const updated = store.resolve(id, parsed.data);
      if (!updated) return c.json({ error: "Prediction not found" }, 404);
      return c.json(updated);
    }
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      409
    );
  }
});

/**
 * DELETE /api/predictions/:id — Delete a prediction.
 */
predictions.delete("/api/predictions/:id", (c) => {
  const db = getDb();
  const store = new PredictionStore(db);
  const id = c.req.param("id");

  const deleted = store.delete(id);
  if (!deleted) return c.json({ error: "Prediction not found" }, 404);
  return c.json({ ok: true });
});

export default predictions;
