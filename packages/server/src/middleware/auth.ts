import { timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { getDb, getSetting } from "@exocortex/core";

/** Constant-time string comparison to prevent timing attacks */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export async function authMiddleware(c: Context, next: Next) {
  const db = getDb();
  const token = getSetting(db, "auth.token");

  // If no token configured, allow all requests (backwards-compatible)
  if (!token) {
    await next();
    return;
  }

  // Accept token via Authorization header or X-Exocortex-Token
  const authHeader = c.req.header("Authorization");
  const tokenHeader = c.req.header("X-Exocortex-Token");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if ((tokenHeader && safeEqual(tokenHeader, token)) || (bearerToken && safeEqual(bearerToken, token))) {
    await next();
    return;
  }

  return c.json({ error: "Unauthorized" }, 401);
}
