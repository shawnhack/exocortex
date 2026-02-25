import type { Context, Next } from "hono";
import { getDb, getSetting } from "@exocortex/core";

export async function authMiddleware(c: Context, next: Next) {
  const db = getDb();
  const token = getSetting(db, "auth.token");

  // If no token configured, allow all requests (backwards-compatible)
  if (!token) {
    await next();
    return;
  }

  const authHeader = c.req.header("Authorization");
  if (!authHeader || authHeader !== `Bearer ${token}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  await next();
}
