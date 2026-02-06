import { Hono } from "hono";
import { z } from "zod";
import {
  getDb,
  findClusters,
  consolidateCluster,
  generateBasicSummary,
  getConsolidations,
  detectContradictions,
  recordContradiction,
  getContradictions,
  updateContradiction,
  getTimeline,
  getTemporalStats,
  archiveStaleMemories,
  adjustImportance,
} from "@exocortex/core";

const intelligence = new Hono();
const contradictionStatusSchema = z.enum(["pending", "resolved", "dismissed"]);

function parseIntQuery(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

// POST /api/consolidate — find clusters and optionally consolidate them
intelligence.post("/api/consolidate", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const dryRun = body.dry_run ?? false;
  const minSimilarity = body.min_similarity ?? 0.75;
  const minClusterSize = body.min_cluster_size ?? 3;

  const db = getDb();
  const clusters = findClusters(db, { minSimilarity, minClusterSize });

  if (dryRun) {
    return c.json({ dry_run: true, clusters });
  }

  const results: Array<{ cluster_topic: string; summary_id: string; members: number }> = [];

  for (const cluster of clusters) {
    const summary = generateBasicSummary(db, cluster.memberIds);
    const summaryId = await consolidateCluster(db, cluster, summary);
    results.push({
      cluster_topic: cluster.topic,
      summary_id: summaryId,
      members: cluster.memberIds.length,
    });
  }

  return c.json({ clusters_found: clusters.length, consolidated: results });
});

// GET /api/consolidations — list consolidation history
intelligence.get("/api/consolidations", (c) => {
  const limit = parseIntQuery(c.req.query("limit"), 20, 1, 500);
  const db = getDb();
  return c.json(getConsolidations(db, limit));
});

// POST /api/contradictions/detect — scan for contradictions
intelligence.post("/api/contradictions/detect", (c) => {
  const db = getDb();
  const candidates = detectContradictions(db);

  // Record all detected contradictions
  const recorded = candidates.map((candidate) => recordContradiction(db, candidate));

  return c.json({ detected: recorded.length, contradictions: recorded });
});

// GET /api/contradictions — list contradictions
intelligence.get("/api/contradictions", (c) => {
  const statusParam = c.req.query("status");
  if (statusParam && !contradictionStatusSchema.safeParse(statusParam).success) {
    return c.json({ error: "Invalid status filter" }, 400);
  }
  const status = statusParam as "pending" | "resolved" | "dismissed" | undefined;
  const limit = parseIntQuery(c.req.query("limit"), 50, 1, 500);
  const db = getDb();
  return c.json(getContradictions(db, status, limit));
});

// GET /api/contradictions/:id
intelligence.get("/api/contradictions/:id", (c) => {
  const db = getDb();
  const all = getContradictions(db);
  const contradiction = all.find((ct) => ct.id === c.req.param("id"));
  if (!contradiction) return c.json({ error: "Not found" }, 404);
  return c.json(contradiction);
});

const contradictionUpdateSchema = z.object({
  status: z.enum(["pending", "resolved", "dismissed"]).optional(),
  resolution: z.string().optional(),
});

// PATCH /api/contradictions/:id
intelligence.patch("/api/contradictions/:id", async (c) => {
  const body = contradictionUpdateSchema.parse(await c.req.json());
  const db = getDb();
  const updated = updateContradiction(db, c.req.param("id"), body);
  if (!updated) return c.json({ error: "Not found" }, 404);
  return c.json(updated);
});

// POST /api/archive — archive stale memories
intelligence.post("/api/archive", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const dryRun = body.dry_run ?? false;
  const staleDays = body.stale_days;
  const maxImportance = body.max_importance;
  const maxAccessCount = body.max_access_count;
  const abandonedDays = body.abandoned_days;

  const db = getDb();
  const result = archiveStaleMemories(db, {
    dryRun,
    staleDays,
    maxImportance,
    maxAccessCount,
    abandonedDays,
  });

  return c.json(result);
});

// POST /api/importance-adjust — adjust importance based on access patterns
intelligence.post("/api/importance-adjust", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const dryRun = body.dry_run ?? false;
  const boostThreshold = body.boost_threshold;
  const decayAgeDays = body.decay_age_days;

  const db = getDb();
  const result = adjustImportance(db, {
    dryRun,
    boostThreshold,
    decayAgeDays,
  });

  return c.json(result);
});

// GET /api/timeline — memory timeline
intelligence.get("/api/timeline", (c) => {
  const after = c.req.query("after");
  const before = c.req.query("before");
  const limit = parseIntQuery(c.req.query("limit"), 30, 1, 365);
  const includeMemories = c.req.query("include_memories") === "true";

  const db = getDb();
  return c.json(getTimeline(db, { after, before, limit, includeMemories }));
});

// GET /api/temporal-stats — temporal analysis
intelligence.get("/api/temporal-stats", (c) => {
  const db = getDb();
  return c.json(getTemporalStats(db));
});

export default intelligence;
