import { Hono } from "hono";
import { z } from "zod";
import { getDb, getJobHealth, recordJobOutcome } from "@exocortex/core";

const health = new Hono();

const jobOutcomeSchema = z.object({
  job_name: z.string().min(1).max(200),
  success: z.boolean(),
  duration_ms: z.number().int().min(0).optional(),
  error: z.string().max(2000).optional(),
});

health.get("/health", (c) => {
  try {
    const db = getDb();
    const result = db.prepare("SELECT 1 as ok").get() as { ok: number };
    return c.json({
      status: "ok",
      db: result.ok === 1 ? "connected" : "error",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  } catch {
    return c.json({ status: "error", db: "disconnected" }, 503);
  }
});

health.post("/api/job-outcomes", async (c) => {
  const body = await c.req.json();
  const parsed = jobOutcomeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  recordJobOutcome(getDb(), parsed.data);
  return c.json({ ok: true });
});

health.get("/api/job-health", (c) => {
  const windowDays = Number.parseInt(c.req.query("window_days") ?? "14", 10);
  const alertThreshold = Number.parseFloat(c.req.query("alert_threshold") ?? "0.70");
  return c.json(getJobHealth(getDb(), {
    windowDays: Number.isFinite(windowDays) ? windowDays : 14,
    alertThreshold: Number.isFinite(alertThreshold) ? alertThreshold : 0.70,
  }));
});

export default health;
