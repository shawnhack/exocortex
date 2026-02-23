import { Hono } from "hono";
import {
  getDb,
  getAnalyticsSummary,
  getAccessDistribution,
  getTagEffectiveness,
  getProducerQuality,
  getQualityTrend,
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
  const granularity =
    c.req.query("granularity") === "week" ? "week" : "month";
  const limit = parseIntQuery(c.req.query("limit"), 12, 1, 52);
  return c.json(getQualityTrend(db, granularity, limit));
});

export default analytics;
