import type { Context, Next } from "hono";

export async function errorHandler(c: Context, next: Next) {
  try {
    await next();
  } catch (err: unknown) {
    // JSON parse errors should return 400, not 500
    if (err instanceof SyntaxError) {
      return c.json({ error: "Invalid JSON in request body" }, 400);
    }

    const status =
      err instanceof Error && "status" in err
        ? (err as any).status
        : 500;
    const message = status >= 500
      ? "Internal server error"
      : (err instanceof Error ? err.message : "Internal server error");

    console.error(`[ERROR] ${c.req.method} ${c.req.path}:`, err instanceof Error ? err.message : err);

    return c.json({ error: message }, status);
  }
}
