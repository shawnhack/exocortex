import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import { serve } from "@hono/node-server";
import { getDb, initializeSchema } from "@exocortex/core";
import { errorHandler } from "./middleware/error.js";
import memoriesRoutes from "./routes/memories.js";
import entitiesRoutes from "./routes/entities.js";
import importRoutes from "./routes/import.js";
import intelligenceRoutes from "./routes/intelligence.js";
import chatRoutes from "./routes/chat.js";
import goalsRoutes from "./routes/goals.js";
import linksRoutes from "./routes/links.js";
import healthRoutes from "./routes/health.js";
import { startScheduler } from "./scheduler.js";
import path from "node:path";
import fs from "node:fs";

function getAllowedCorsOrigins(): string[] {
  const raw = process.env.EXOCORTEX_CORS_ORIGINS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export function createApp(): Hono {
  const app = new Hono();

  const allowedCorsOrigins = getAllowedCorsOrigins();
  if (allowedCorsOrigins.length > 0) {
    const allowSet = new Set(allowedCorsOrigins);
    app.use(
      "*",
      cors({
        origin: (origin) => {
          if (!origin) return undefined;
          return allowSet.has(origin) ? origin : undefined;
        },
        allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization", "X-Exocortex-Token"],
      })
    );
  }
  app.use("*", errorHandler);

  app.route("/", healthRoutes);
  app.route("/", memoriesRoutes);
  app.route("/", entitiesRoutes);
  app.route("/", importRoutes);
  app.route("/", intelligenceRoutes);
  app.route("/", chatRoutes);
  app.route("/", goalsRoutes);
  app.route("/", linksRoutes);

  // Serve dashboard static files if built
  const dashboardDist = path.resolve(
    import.meta.dirname ?? ".",
    "../../dashboard/dist"
  );

  if (fs.existsSync(dashboardDist)) {
    app.use(
      "/assets/*",
      serveStatic({ root: dashboardDist, rewriteRequestPath: (p) => p })
    );

    // Serve root-level static files (icon.svg, favicon, etc.)
    app.get("*", async (c, next) => {
      const urlPath = new URL(c.req.url).pathname;
      if (urlPath !== "/" && !urlPath.startsWith("/api/")) {
        const filePath = path.join(dashboardDist, urlPath);
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const ext = path.extname(filePath).toLowerCase();
          const mimeTypes: Record<string, string> = {
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".ico": "image/x-icon",
            ".json": "application/json",
            ".webmanifest": "application/manifest+json",
          };
          const contentType = mimeTypes[ext] || "application/octet-stream";
          const content = fs.readFileSync(filePath);
          return c.body(content, 200, { "Content-Type": contentType });
        }
      }
      await next();
    });

    // SPA fallback: serve index.html for non-API routes
    app.get("*", (c) => {
      const indexPath = path.join(dashboardDist, "index.html");
      if (fs.existsSync(indexPath)) {
        const html = fs.readFileSync(indexPath, "utf-8");
        return c.html(html);
      }
      return c.text("Dashboard not built. Run: pnpm --filter @exocortex/dashboard build", 404);
    });
  }

  return app;
}

export function startServer(
  port = 3210,
  host = process.env.EXOCORTEX_HOST ?? "127.0.0.1"
): void {
  const db = getDb();
  initializeSchema(db);

  const app = createApp();

  startScheduler();

  console.log(`Exocortex server starting on http://${host}:${port}`);

  serve({
    fetch: app.fetch,
    port,
    hostname: host,
  }, (info) => {
    console.log(`Exocortex server listening on http://${host}:${info.port}`);
  });
}
