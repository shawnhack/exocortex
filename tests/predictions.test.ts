import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  initializeSchema,
  PredictionStore,
  setEmbeddingProvider,
  resetEmbeddingProvider,
} from "@exocortex/core";
import type { EmbeddingProvider } from "@exocortex/core";

class MockEmbeddingProvider implements EmbeddingProvider {
  embed(text: string): Promise<Float32Array> {
    const arr = new Float32Array(8);
    for (let i = 0; i < text.length; i++) {
      arr[i % 8] += text.charCodeAt(i) / 1000;
    }
    let norm = 0;
    for (let i = 0; i < arr.length; i++) norm += arr[i] * arr[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < arr.length; i++) arr[i] /= norm;
    return Promise.resolve(arr);
  }

  embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  dimensions(): number {
    return 8;
  }
}

let db: DatabaseSync;
let store: PredictionStore;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  initializeSchema(db);
  setEmbeddingProvider(new MockEmbeddingProvider());
  store = new PredictionStore(db);
});

afterEach(() => {
  db.close();
  resetEmbeddingProvider();
});

describe("PredictionStore CRUD", () => {
  it("creates a prediction with all fields", () => {
    const p = store.create({
      claim: "BTC will reach 100k by end of 2026",
      confidence: 0.75,
      domain: "market",
      source: "user",
      deadline: "2026-12-31",
      goal_id: "GOAL123",
      metadata: { context: "crypto analysis" },
    });

    expect(p.id).toBeTruthy();
    expect(p.claim).toBe("BTC will reach 100k by end of 2026");
    expect(p.confidence).toBe(0.75);
    expect(p.domain).toBe("market");
    expect(p.status).toBe("open");
    expect(p.resolution).toBeNull();
    expect(p.source).toBe("user");
    expect(p.goal_id).toBe("GOAL123");
    expect(p.deadline).toBe("2026-12-31");
    expect(p.metadata).toEqual({ context: "crypto analysis" });
    expect(p.created_at).toBeTruthy();
    expect(p.resolved_at).toBeNull();
  });

  it("creates with defaults", () => {
    const p = store.create({
      claim: "Simple prediction",
      confidence: 0.5,
    });

    expect(p.domain).toBe("general");
    expect(p.source).toBe("user");
    expect(p.deadline).toBeNull();
    expect(p.goal_id).toBeNull();
    expect(p.metadata).toEqual({});
  });

  it("rejects invalid confidence", () => {
    expect(() => store.create({ claim: "test", confidence: 1.5 })).toThrow(
      "Confidence must be between 0 and 1"
    );
    expect(() => store.create({ claim: "test", confidence: -0.1 })).toThrow(
      "Confidence must be between 0 and 1"
    );
  });

  it("getById returns prediction or null", () => {
    const p = store.create({ claim: "test", confidence: 0.6 });
    expect(store.getById(p.id)).toBeTruthy();
    expect(store.getById("nonexistent")).toBeNull();
  });

  it("lists with filters", () => {
    store.create({ claim: "A", confidence: 0.5, domain: "technical" });
    store.create({ claim: "B", confidence: 0.7, domain: "market" });
    store.create({ claim: "C", confidence: 0.3, domain: "technical", source: "sentinel" });

    const all = store.list();
    expect(all).toHaveLength(3);

    const techOnly = store.list({ domain: "technical" });
    expect(techOnly).toHaveLength(2);

    const sentinelOnly = store.list({ source: "sentinel" });
    expect(sentinelOnly).toHaveLength(1);
    expect(sentinelOnly[0].claim).toBe("C");

    const limited = store.list({ limit: 1 });
    expect(limited).toHaveLength(1);
  });

  it("overdue filter works", () => {
    store.create({ claim: "Past", confidence: 0.5, deadline: "2020-01-01" });
    store.create({ claim: "Future", confidence: 0.5, deadline: "2099-01-01" });
    store.create({ claim: "No deadline", confidence: 0.5 });

    const overdue = store.list({ overdue: true });
    expect(overdue).toHaveLength(1);
    expect(overdue[0].claim).toBe("Past");
  });

  it("findOverdue returns open past-deadline predictions", () => {
    store.create({ claim: "Past", confidence: 0.5, deadline: "2020-01-01" });
    store.create({ claim: "Future", confidence: 0.5, deadline: "2099-01-01" });

    const overdue = store.findOverdue();
    expect(overdue).toHaveLength(1);
    expect(overdue[0].claim).toBe("Past");
  });

  it("deletes a prediction", () => {
    const p = store.create({ claim: "to delete", confidence: 0.5 });
    expect(store.delete(p.id)).toBe(true);
    expect(store.getById(p.id)).toBeNull();
    expect(store.delete("nonexistent")).toBe(false);
  });
});

describe("PredictionStore resolution", () => {
  it("resolves true", () => {
    const p = store.create({ claim: "will happen", confidence: 0.8 });
    const resolved = store.resolve(p.id, {
      resolution: "true",
      resolution_notes: "It happened!",
    });

    expect(resolved!.status).toBe("resolved");
    expect(resolved!.resolution).toBe("true");
    expect(resolved!.resolution_notes).toBe("It happened!");
    expect(resolved!.resolved_at).toBeTruthy();
  });

  it("resolves false", () => {
    const p = store.create({ claim: "won't happen", confidence: 0.9 });
    const resolved = store.resolve(p.id, { resolution: "false" });

    expect(resolved!.status).toBe("resolved");
    expect(resolved!.resolution).toBe("false");
  });

  it("resolves partial", () => {
    const p = store.create({ claim: "maybe", confidence: 0.5 });
    const resolved = store.resolve(p.id, { resolution: "partial" });

    expect(resolved!.status).toBe("resolved");
    expect(resolved!.resolution).toBe("partial");
  });

  it("prevents double-resolve", () => {
    const p = store.create({ claim: "test", confidence: 0.6 });
    store.resolve(p.id, { resolution: "true" });

    expect(() => store.resolve(p.id, { resolution: "false" })).toThrow(
      "already resolved"
    );
  });

  it("voids a prediction", () => {
    const p = store.create({ claim: "test", confidence: 0.6 });
    const voided = store.void(p.id, "No longer relevant");

    expect(voided!.status).toBe("voided");
    expect(voided!.resolution_notes).toBe("No longer relevant");
  });

  it("prevents voiding a resolved prediction", () => {
    const p = store.create({ claim: "test", confidence: 0.6 });
    store.resolve(p.id, { resolution: "true" });

    expect(() => store.void(p.id)).toThrow("already resolved");
  });

  it("returns null for nonexistent id", () => {
    expect(store.resolve("fake", { resolution: "true" })).toBeNull();
    expect(store.void("fake")).toBeNull();
  });
});

describe("PredictionStore calibration", () => {
  it("returns zeroed stats with 0 resolved predictions", () => {
    store.create({ claim: "open one", confidence: 0.7 });

    const stats = store.getStats();
    expect(stats.total_predictions).toBe(1);
    expect(stats.resolved_count).toBe(0);
    expect(stats.brier_score).toBe(0);
    expect(stats.overconfidence_bias).toBe(0);
    expect(stats.calibration_curve).toEqual([]);
    expect(stats.domain_breakdown).toEqual([]);
    expect(stats.trend).toEqual([]);
  });

  it("computes correct Brier score for known predictions", () => {
    // 4 predictions with known outcomes:
    // P1: conf=0.9, true  → (0.9-1.0)^2 = 0.01
    // P2: conf=0.8, false → (0.8-0.0)^2 = 0.64
    // P3: conf=0.3, true  → (0.3-1.0)^2 = 0.49
    // P4: conf=0.6, partial → (0.6-0.5)^2 = 0.01
    // Brier = (0.01 + 0.64 + 0.49 + 0.01) / 4 = 0.2875

    const p1 = store.create({ claim: "P1", confidence: 0.9 });
    const p2 = store.create({ claim: "P2", confidence: 0.8 });
    const p3 = store.create({ claim: "P3", confidence: 0.3 });
    const p4 = store.create({ claim: "P4", confidence: 0.6 });

    store.resolve(p1.id, { resolution: "true" });
    store.resolve(p2.id, { resolution: "false" });
    store.resolve(p3.id, { resolution: "true" });
    store.resolve(p4.id, { resolution: "partial" });

    const stats = store.getStats();
    expect(stats.resolved_count).toBe(4);
    expect(stats.brier_score).toBeCloseTo(0.2875, 3);
  });

  it("detects perfect calibration (Brier = 0)", () => {
    // All predictions at 100% confidence, all true
    const p1 = store.create({ claim: "Sure1", confidence: 1.0 });
    const p2 = store.create({ claim: "Sure2", confidence: 1.0 });
    store.resolve(p1.id, { resolution: "true" });
    store.resolve(p2.id, { resolution: "true" });

    const stats = store.getStats();
    expect(stats.brier_score).toBe(0);
    expect(stats.overconfidence_bias).toBe(0);
  });

  it("detects worst case (Brier = 1)", () => {
    // 100% confident, all wrong
    const p1 = store.create({ claim: "Wrong1", confidence: 1.0 });
    const p2 = store.create({ claim: "Wrong2", confidence: 1.0 });
    store.resolve(p1.id, { resolution: "false" });
    store.resolve(p2.id, { resolution: "false" });

    const stats = store.getStats();
    expect(stats.brier_score).toBe(1);
    expect(stats.overconfidence_bias).toBe(1);
  });

  it("builds calibration curve buckets", () => {
    // Put predictions in different confidence ranges
    const p1 = store.create({ claim: "low", confidence: 0.15 });
    const p2 = store.create({ claim: "mid", confidence: 0.55 });
    const p3 = store.create({ claim: "high", confidence: 0.85 });

    store.resolve(p1.id, { resolution: "false" });
    store.resolve(p2.id, { resolution: "true" });
    store.resolve(p3.id, { resolution: "true" });

    const stats = store.getStats();
    expect(stats.calibration_curve.length).toBeGreaterThanOrEqual(3);

    // Check bucket for 0.1-0.2 range (conf 0.15)
    const lowBucket = stats.calibration_curve.find(
      (b) => b.range_start === 0.1
    );
    expect(lowBucket).toBeTruthy();
    expect(lowBucket!.count).toBe(1);
    expect(lowBucket!.actual_freq).toBe(0); // false → 0
  });

  it("detects overconfidence", () => {
    // High confidence but wrong
    const p1 = store.create({ claim: "over1", confidence: 0.9 });
    const p2 = store.create({ claim: "over2", confidence: 0.8 });
    store.resolve(p1.id, { resolution: "false" });
    store.resolve(p2.id, { resolution: "false" });

    const stats = store.getStats();
    expect(stats.overconfidence_bias).toBeGreaterThan(0);
  });

  it("domain breakdown", () => {
    const p1 = store.create({ claim: "tech1", confidence: 0.8, domain: "technical" });
    const p2 = store.create({ claim: "mkt1", confidence: 0.7, domain: "market" });

    store.resolve(p1.id, { resolution: "true" });
    store.resolve(p2.id, { resolution: "false" });

    const stats = store.getStats();
    expect(stats.domain_breakdown).toHaveLength(2);

    const techStats = stats.domain_breakdown.find((d) => d.domain === "technical");
    expect(techStats).toBeTruthy();
    expect(techStats!.accuracy).toBe(1);

    const mktStats = stats.domain_breakdown.find((d) => d.domain === "market");
    expect(mktStats).toBeTruthy();
    expect(mktStats!.accuracy).toBe(0);
  });

  it("monthly trend", () => {
    const p1 = store.create({ claim: "t1", confidence: 0.8 });
    const p2 = store.create({ claim: "t2", confidence: 0.6 });

    store.resolve(p1.id, { resolution: "true" });
    store.resolve(p2.id, { resolution: "false" });

    const stats = store.getStats();
    // Both resolved in same month
    expect(stats.trend.length).toBeGreaterThanOrEqual(1);
    expect(stats.trend[0].count).toBe(2);
  });

  it("filters stats by domain", () => {
    const p1 = store.create({ claim: "tech", confidence: 0.8, domain: "technical" });
    const p2 = store.create({ claim: "mkt", confidence: 0.7, domain: "market" });

    store.resolve(p1.id, { resolution: "true" });
    store.resolve(p2.id, { resolution: "false" });

    const techStats = store.getStats({ domain: "technical" });
    expect(techStats.resolved_count).toBe(1);
    expect(techStats.brier_score).toBeCloseTo(0.04, 3); // (0.8-1.0)^2 = 0.04
  });

  it("partial resolution = 0.5 outcome", () => {
    const p = store.create({ claim: "partial", confidence: 0.5 });
    store.resolve(p.id, { resolution: "partial" });

    const stats = store.getStats();
    // (0.5 - 0.5)^2 = 0
    expect(stats.brier_score).toBe(0);
  });
});
