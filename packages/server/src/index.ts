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
import healthRoutes from "./routes/health.js";
import { startScheduler } from "./scheduler.js";
import path from "node:path";
import fs from "node:fs";

export function createApp(): Hono {
  const app = new Hono();

  app.use("*", cors());
  app.use("*", errorHandler);

  app.route("/", healthRoutes);
  app.route("/", memoriesRoutes);
  app.route("/", entitiesRoutes);
  app.route("/", importRoutes);
  app.route("/", intelligenceRoutes);
  app.route("/", chatRoutes);

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

export function startServer(port = 3210): void {
  const db = getDb();
  initializeSchema(db);

  const app = createApp();

  startScheduler();

  console.log(`Exocortex server starting on http://localhost:${port}`);

  serve({
    fetch: app.fetch,
    port,
  }, (info) => {
    console.log(`Exocortex server listening on http://localhost:${info.port}`);
  });
}
