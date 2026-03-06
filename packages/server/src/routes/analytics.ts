import { Hono } from "hono";
import {
  getDb,
  getSetting,
  getAnalyticsSummary,
  getAccessDistribution,
  getTagEffectiveness,
  getProducerQuality,
  getQualityTrend,
  getQualityDistribution,
  getQualityHistogram,
  getArchiveCandidates,
  suggestTagMerges,
  getTagAliasMap,
  getSearchMisses,
  getQueryOutcomes,
} from "@exocortex/core";

const analytics = new Hono();

function parseIntQuery(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

analytics.get("/api/analytics/summary", (c) => {
  const db = getDb();
  return c.json(getAnalyticsSummary(db));
});

analytics.get("/api/analytics/access-distribution", (c) => {
  const db = getDb();
  return c.json(getAccessDistribution(db));
});

analytics.get("/api/analytics/tag-effectiveness", (c) => {
  const db = getDb();
  const limit = parseIntQuery(c.req.query("limit"), 20, 1, 100);
  return c.json(getTagEffectiveness(db, limit));
});

analytics.get("/api/analytics/producer-quality", (c) => {
  const db = getDb();
  const by = c.req.query("by") === "agent" ? "agent" : "model";
  const limit = parseIntQuery(c.req.query("limit"), 15, 1, 100);
  return c.json(getProducerQuality(db, by, limit));
});

analytics.get("/api/analytics/quality-trend", (c) => {
  const db = getDb();
  const g = c.req.query("granularity");
  const granularity: "day" | "week" | "month" =
    g === "day" ? "day" : g === "week" ? "week" : "month";
  const limit = parseIntQuery(c.req.query("limit"), 12, 1, 90);
  return c.json(getQualityTrend(db, granularity, limit));
});

analytics.get("/api/analytics/quality-distribution", (c) => {
  const db = getDb();
  return c.json(getQualityDistribution(db));
});

analytics.get("/api/analytics/quality-histogram", (c) => {
  const db = getDb();
  return c.json(getQualityHistogram(db));
});

// Imp 1: Embedding health
analytics.get("/api/analytics/embedding-health", (c) => {
  const db = getDb();
  const currentModel = getSetting(db, "embedding.model") ?? "unknown";
  const dimensions = parseInt(getSetting(db, "embedding.dimensions") ?? "0", 10);

  const totalEmbedded = (
    db.prepare("SELECT COUNT(*) as count FROM memories WHERE embedding IS NOT NULL AND is_active = 1").get() as { count: number }
  ).count;

  const mismatchedModel = (
    db.prepare(
      "SELECT COUNT(*) as count FROM memories WHERE embedding IS NOT NULL AND embedding_model IS NOT NULL AND embedding_model != ? AND is_active = 1"
    ).get(currentModel) as { count: number }
  ).count;

  const missingEmbedding = (
    db.prepare("SELECT COUNT(*) as count FROM memories WHERE embedding IS NULL AND is_active = 1").get() as { count: number }
  ).count;

  return c.json({ currentModel, dimensions, totalEmbedded, mismatchedModel, missingEmbedding });
});

// Imp 3: Decay preview
analytics.get("/api/analytics/decay-preview", (c) => {
  const db = getDb();
  const candidates = getArchiveCandidates(db);
  const total = candidates.length;
  const top50 = candidates.slice(0, 50).map((c) => ({
    ...c,
    content: c.content.length > 120 ? c.content.slice(0, 120) + "..." : c.content,
  }));
  return c.json({ candidates: top50, total });
});

// Imp 4: Tag health
analytics.get("/api/analytics/tag-health", (c) => {
  const db = getDb();

  const totalTags = (
    db.prepare("SELECT COUNT(DISTINCT tag) as count FROM memory_tags").get() as { count: number }
  ).count;

  const aliasMap = getTagAliasMap(db);
  const mergeCount = Object.keys(aliasMap).length;

  const suggestions = suggestTagMerges(db, { limit: 10 });

  return c.json({ totalTags, mergeCount, aliasMap, suggestions });
});

// Imp 5: Search misses
analytics.get("/api/analytics/search-misses", (c) => {
  const db = getDb();
  const limit = parseIntQuery(c.req.query("limit"), 20, 1, 100);
  const days = parseIntQuery(c.req.query("days"), 7, 1, 90);
  const misses = getSearchMisses(db, limit, days);
  return c.json(misses);
});

// Knowledge gaps: persistent search misses over threshold
analytics.get("/api/analytics/knowledge-gaps", (c) => {
  const minCount = parseIntQuery(c.req.query("min_count"), 3, 1, 100);
  const days = parseIntQuery(c.req.query("days"), 14, 1, 90);
  const limit = parseIntQuery(c.req.query("limit"), 20, 1, 100);
  const db = getDb();
  const misses = getSearchMisses(db, limit, days);
  const gaps = misses
    .filter((m) => m.count >= minCount)
    .map((m) => ({
      ...m,
      severity: m.count >= 10 ? "critical" : m.count >= 5 ? "warning" : "info",
    }));
  return c.json(gaps);
});

// Query outcome analytics
analytics.get("/api/analytics/query-outcomes", (c) => {
  const db = getDb();
  const limit = parseIntQuery(c.req.query("limit"), 20, 1, 100);
  const minSearches = parseIntQuery(c.req.query("min_searches"), 2, 1, 10000);
  const sortBy = (c.req.query("sort_by") ?? "searches") as
    | "searches"
    | "feedback_ratio"
    | "zero_feedback";
  return c.json(getQueryOutcomes(db, { limit, minSearches, sortBy }));
});

export default analytics;
