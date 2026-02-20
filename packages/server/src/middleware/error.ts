import type { Context, Next } from "hono";

export async function errorHandler(c: Context, next: Next) {
  try {
    await next();
  } catch (err: unknown) {
    // JSON parse errors should return 400, not 500
    if (err instanceof SyntaxError) {
      return c.json({ error: "Invalid JSON in request body" }, 400);
    }

    const message =
      err instanceof Error ? err.message : "Internal server error";
    const status =
      err instanceof Error && "status" in err
        ? (err as any).status
        : 500;

    console.error(`[ERROR] ${c.req.method} ${c.req.path}:`, message);

    return c.json({ error: message }, status);
  }
}
