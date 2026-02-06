import type { Context, Next } from "hono";

export async function errorHandler(c: Context, next: Next) {
  try {
    await next();
  } catch (err: unknown) {
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
