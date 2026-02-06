import { Hono } from "hono";
import { getDb } from "@exocortex/core";

const health = new Hono();

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

export default health;
