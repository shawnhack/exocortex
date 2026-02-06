import { describe, it, expect } from "vitest";
import {
  cosineSimilarity,
  recencyScore,
  frequencyScore,
  computeHybridScore,
} from "@exocortex/core";
import type { ScoringWeights } from "@exocortex/core";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it("returns -1 for opposite vectors", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
  });

  it("handles zero vectors", () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });
});

describe("recencyScore", () => {
  it("returns ~1 for just-created memories", () => {
    const now = new Date().toISOString().replace("T", " ").replace("Z", "");
    const score = recencyScore(now, 0.05);
    expect(score).toBeGreaterThan(0.99);
  });

  it("decays over time", () => {
    const thirtyDaysAgo = new Date(
      Date.now() - 30 * 24 * 60 * 60 * 1000
    )
      .toISOString()
      .replace("T", " ")
      .replace("Z", "");
    const score = recencyScore(thirtyDaysAgo, 0.05);
    // exp(-0.05 * 30) ≈ 0.223
    expect(score).toBeCloseTo(0.223, 1);
  });

  it("returns near-zero for very old memories", () => {
    const yearAgo = new Date(
      Date.now() - 365 * 24 * 60 * 60 * 1000
    )
      .toISOString()
      .replace("T", " ")
      .replace("Z", "");
    const score = recencyScore(yearAgo, 0.05);
    expect(score).toBeLessThan(0.01);
  });
});

describe("frequencyScore", () => {
  it("returns 0 when access count is 0", () => {
    expect(frequencyScore(0, 100)).toBe(0);
  });

  it("returns 1 when access count equals max", () => {
    expect(frequencyScore(100, 100)).toBeCloseTo(1, 5);
  });

  it("returns 0 when max is 0", () => {
    expect(frequencyScore(0, 0)).toBe(0);
  });

  it("scales logarithmically", () => {
    const low = frequencyScore(1, 100);
    const mid = frequencyScore(10, 100);
    const high = frequencyScore(50, 100);
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
  });
});

describe("computeHybridScore", () => {
  const weights: ScoringWeights = {
    vector: 0.45,
    fts: 0.25,
    recency: 0.20,
    frequency: 0.10,
    recencyDecay: 0.05,
  };

  it("computes weighted sum correctly", () => {
    const score = computeHybridScore(1, 1, 1, 1, weights);
    expect(score).toBeCloseTo(1, 5);
  });

  it("returns 0 for all-zero signals", () => {
    expect(computeHybridScore(0, 0, 0, 0, weights)).toBe(0);
  });

  it("applies weights correctly", () => {
    // Only vector signal
    const vectorOnly = computeHybridScore(1, 0, 0, 0, weights);
    expect(vectorOnly).toBeCloseTo(0.45, 5);

    // Only FTS signal
    const ftsOnly = computeHybridScore(0, 1, 0, 0, weights);
    expect(ftsOnly).toBeCloseTo(0.25, 5);
  });
});
