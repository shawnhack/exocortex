import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { getDb, getSetting } from "@exocortex/core";
import { isX402Enabled, build402Response, verifyX402Payment, getPrice } from "./x402.js";

/** Constant-time string comparison using HMAC to avoid length-dependent timing leaks */
function safeEqual(a: string, b: string): boolean {
  const ha = createHmac("sha256", "exocortex").update(a).digest();
  const hb = createHmac("sha256", "exocortex").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export async function authMiddleware(c: Context, next: Next) {
  const db = getDb();
  const token = getSetting(db, "auth.token");

  // If no token configured, allow all requests (backwards-compatible)
  if (!token) {
    await next();
    return;
  }

  // 1. Try token auth (Bearer header or X-Exocortex-Token)
  const authHeader = c.req.header("Authorization");
  const tokenHeader = c.req.header("X-Exocortex-Token");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if ((tokenHeader && safeEqual(tokenHeader, token)) || (bearerToken && safeEqual(bearerToken, token))) {
    await next();
    return;
  }

  // 2. Try x402 payment (if configured)
  const paymentTx = c.req.header("X-Payment");
  if (paymentTx && isX402Enabled()) {
    const wallet = process.env.EXOCORTEX_PAYMENT_WALLET!;
    const price = getPrice(c.req.method, c.req.path);
    const valid = await verifyX402Payment(paymentTx, wallet, price);
    if (valid) {
      await next();
      return;
    }
    return c.json({ error: "x402 payment verification failed" }, 402);
  }

  // 3. No valid auth — return 402 with payment info (if x402 enabled) or 401
  if (isX402Enabled()) {
    return build402Response(c);
  }

  return c.json({ error: "Unauthorized" }, 401);
}
