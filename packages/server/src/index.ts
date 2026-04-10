import { Hono } from "hono";
import { cors } from "hono/cors";
import { compress } from "hono/compress";
import { secureHeaders } from "hono/secure-headers";
import { serveStatic } from "@hono/node-server/serve-static";
import { serve } from "@hono/node-server";
import { getDb, initializeSchema } from "@exocortex/core";
import { errorHandler } from "./middleware/error.js";
import { authMiddleware } from "./middleware/auth.js";
import memoriesRoutes from "./routes/memories.js";
import entitiesRoutes from "./routes/entities.js";
import importRoutes from "./routes/import.js";
import intelligenceRoutes from "./routes/intelligence.js";
import chatRoutes from "./routes/chat.js";
import goalsRoutes from "./routes/goals.js";
import predictionsRoutes from "./routes/predictions.js";
import diaryRoutes from "./routes/diary.js";
import tasksRoutes from "./routes/tasks.js";
import linksRoutes from "./routes/links.js";
import healthRoutes from "./routes/health.js";
import analyticsRoutes from "./routes/analytics.js";
import retrievalRoutes from "./routes/retrieval.js";
import libraryRoutes from "./routes/library.js";
import mcpRoutes from "./routes/mcp.js";
import contextSyncRoutes from "./routes/context-sync.js";
import { startScheduler, stopScheduler } from "./scheduler.js";
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
  app.use("*", compress({ threshold: 1024 }));

  // Security headers (Hono built-in — sets 12 headers including HSTS, CORP, COOP)
  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
      },
      referrerPolicy: "strict-origin-when-cross-origin",
      xFrameOptions: "DENY",
      // Disable HSTS since we serve over localhost HTTP
      strictTransportSecurity: false,
    })
  );

  // Agent discovery files (no auth required)
  const publicDir = path.resolve(import.meta.dirname ?? ".", "..", "public");
  app.get("/llms.txt", (c) => {
    const file = path.join(publicDir, "llms.txt");
    if (!fs.existsSync(file)) return c.text("Not found", 404);
    return c.text(fs.readFileSync(file, "utf-8"));
  });
  app.get("/SKILL.md", (c) => {
    const file = path.join(publicDir, "SKILL.md");
    if (!fs.existsSync(file)) return c.text("Not found", 404);
    return c.text(fs.readFileSync(file, "utf-8"));
  });
  app.get("/a2a.json", (c) => {
    const file = path.join(publicDir, "a2a.json");
    if (!fs.existsSync(file)) return c.json({ error: "Not found" }, 404);
    return c.json(JSON.parse(fs.readFileSync(file, "utf-8")));
  });
  app.get("/.well-known/a2a.json", (c) => {
    const file = path.join(publicDir, "a2a.json");
    if (!fs.existsSync(file)) return c.json({ error: "Not found" }, 404);
    return c.json(JSON.parse(fs.readFileSync(file, "utf-8")));
  });
  app.get("/openapi.json", (c) => {
    const file = path.join(publicDir, "openapi.json");
    if (!fs.existsSync(file)) return c.json({ error: "Not found" }, 404);
    return c.json(JSON.parse(fs.readFileSync(file, "utf-8")));
  });

  // MCP route (before auth — MCP protocol handles its own sessions)
  app.route("/", mcpRoutes);

  // Auth middleware on API routes (health exempt above)
  app.use("/api/*", authMiddleware);

  app.route("/", healthRoutes);
  app.route("/", memoriesRoutes);
  app.route("/", entitiesRoutes);
  app.route("/", importRoutes);
  app.route("/", intelligenceRoutes);
  app.route("/", chatRoutes);
  app.route("/", goalsRoutes);
  app.route("/", predictionsRoutes);
  app.route("/", diaryRoutes);
  app.route("/", tasksRoutes);
  app.route("/", linksRoutes);
  app.route("/", analyticsRoutes);
  app.route("/", retrievalRoutes);
  app.route("/", libraryRoutes);
  app.route("/", contextSyncRoutes);

  // Serve dashboard static files if built
  const dashboardDist = path.resolve(
    import.meta.dirname ?? ".",
    "../../dashboard/dist"
  );

  if (fs.existsSync(dashboardDist)) {
    // Content-hashed assets — cache aggressively (1 year, immutable)
    app.use("/assets/*", async (c, next) => {
      await next();
      if (c.res.status === 200) {
        c.res.headers.set("Cache-Control", "public, max-age=31536000, immutable");
      }
    });
    app.use(
      "/assets/*",
      serveStatic({ root: dashboardDist, rewriteRequestPath: (p) => p })
    );

    // Serve root-level static files (icon.svg, favicon, etc.)
    app.get("*", async (c, next) => {
      const urlPath = new URL(c.req.url).pathname;
      if (urlPath !== "/" && !urlPath.startsWith("/api/")) {
        const filePath = path.join(dashboardDist, urlPath);
        const resolved = path.resolve(filePath);
        if (
          !resolved.startsWith(path.resolve(dashboardDist) + path.sep) &&
          resolved !== path.resolve(dashboardDist)
        ) {
          await next();
          return;
        }
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

    // SPA fallback: serve index.html for non-API routes (cached at startup)
    const indexPath = path.join(dashboardDist, "index.html");
    const indexHtml = fs.existsSync(indexPath)
      ? fs.readFileSync(indexPath, "utf-8")
      : null;
    app.get("*", (c) => {
      if (indexHtml) return c.html(indexHtml);
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

  const server = serve({
    fetch: app.fetch,
    port,
    hostname: host,
  }, (info) => {
    console.log(`Exocortex server listening on http://${host}:${info.port}`);
    // Signal PM2 that the process is ready to accept connections
    if (typeof process.send === "function") {
      process.send("ready");
    }
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log("[exocortex] Shutting down...");
    stopScheduler();
    server.close(() => {
      console.log("[exocortex] Server closed");
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // PM2 graceful shutdown on Windows (POSIX signals don't work on Windows,
  // so PM2 sends an IPC message instead when shutdown_with_message is enabled)
  process.on("message", (msg) => {
    if (msg === "shutdown") {
      shutdown();
    }
  });
}
