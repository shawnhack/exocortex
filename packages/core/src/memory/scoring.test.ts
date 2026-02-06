import { describe, it, expect } from "vitest";
import {
  recencyScore,
  frequencyScore,
  cosineSimilarity,
  computeHybridScore,
  reciprocalRankFusion,
} from "./scoring.js";

describe("scoring", () => {
  describe("recencyScore", () => {
    it("should return ~1.0 for very recent memories", () => {
      const now = new Date().toISOString().slice(0, 19);
      const score = recencyScore(now, 0.05);
      expect(score).toBeGreaterThan(0.99);
    });

    it("should decay over time", () => {
      const thirtyDaysAgo = new Date(
        Date.now() - 30 * 24 * 60 * 60 * 1000
      ).toISOString().slice(0, 19);
      const score = recencyScore(thirtyDaysAgo, 0.05);
      expect(score).toBeLessThan(0.3);
      expect(score).toBeGreaterThan(0.1);
    });

    it("high-importance memories should decay slower", () => {
      const sixtyDaysAgo = new Date(
        Date.now() - 60 * 24 * 60 * 60 * 1000
      ).toISOString().slice(0, 19);

      const lowImportance = recencyScore(sixtyDaysAgo, 0.05, 0.0);
      const midImportance = recencyScore(sixtyDaysAgo, 0.05, 0.5);
      const highImportance = recencyScore(sixtyDaysAgo, 0.05, 1.0);

      // Higher importance → higher recency score (slower decay)
      expect(highImportance).toBeGreaterThan(midImportance);
      expect(midImportance).toBeGreaterThan(lowImportance);
    });

    it("importance=1.0 should halve the effective decay rate", () => {
      const ninetyDaysAgo = new Date(
        Date.now() - 90 * 24 * 60 * 60 * 1000
      ).toISOString().slice(0, 19);

      const noImportance = recencyScore(ninetyDaysAgo, 0.05, 0.0);
      const fullImportance = recencyScore(ninetyDaysAgo, 0.05, 1.0);

      // With importance=1.0, effective rate = 0.05 * 0.5 = 0.025
      // So fullImportance should be approximately equal to recencyScore(date, 0.025, 0)
      const halfRate = recencyScore(ninetyDaysAgo, 0.025);
      expect(Math.abs(fullImportance - halfRate)).toBeLessThan(0.001);

      // And it should be much higher than no-importance
      expect(fullImportance).toBeGreaterThan(noImportance * 1.5);
    });

    it("undefined importance should behave like importance=0", () => {
      const thirtyDaysAgo = new Date(
        Date.now() - 30 * 24 * 60 * 60 * 1000
      ).toISOString().slice(0, 19);

      const withUndefined = recencyScore(thirtyDaysAgo, 0.05);
      const withZero = recencyScore(thirtyDaysAgo, 0.05, 0.0);
      expect(withUndefined).toBeCloseTo(withZero);
    });
  });

  describe("frequencyScore", () => {
    it("should return 0 when maxAccessCount is 0", () => {
      expect(frequencyScore(5, 0)).toBe(0);
    });

    it("should return 1 when accessCount equals maxAccessCount", () => {
      expect(frequencyScore(10, 10)).toBeCloseTo(1.0);
    });

    it("should scale logarithmically", () => {
      const low = frequencyScore(1, 100);
      const mid = frequencyScore(10, 100);
      const high = frequencyScore(50, 100);
      expect(mid).toBeGreaterThan(low);
      expect(high).toBeGreaterThan(mid);
    });
  });

  describe("cosineSimilarity", () => {
    it("should return 1 for identical vectors", () => {
      const v = new Float32Array([1, 0, 0]);
      expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
    });

    it("should return 0 for orthogonal vectors", () => {
      const a = new Float32Array([1, 0]);
      const b = new Float32Array([0, 1]);
      expect(cosineSimilarity(a, b)).toBeCloseTo(0);
    });

    it("should return 0 for zero vectors", () => {
      const a = new Float32Array([0, 0, 0]);
      const b = new Float32Array([1, 2, 3]);
      expect(cosineSimilarity(a, b)).toBe(0);
    });
  });

  describe("reciprocalRankFusion", () => {
    it("should return empty map for empty lists", () => {
      const result = reciprocalRankFusion([], 60);
      expect(result.size).toBe(0);
    });

    it("should compute RRF scores with single list", () => {
      const result = reciprocalRankFusion(
        [
          {
            entries: [
              { id: "a", score: 0.9 },
              { id: "b", score: 0.5 },
            ],
            weight: 1.0,
          },
        ],
        60
      );

      // rank 1 (index 0): 1.0 / (60 + 1) = ~0.01639
      // rank 2 (index 1): 1.0 / (60 + 2) = ~0.01613
      expect(result.get("a")).toBeCloseTo(1 / 61, 5);
      expect(result.get("b")).toBeCloseTo(1 / 62, 5);
      // Higher score → better rank → higher RRF
      expect(result.get("a")!).toBeGreaterThan(result.get("b")!);
    });

    it("should fuse two lists and boost docs appearing in both", () => {
      const result = reciprocalRankFusion(
        [
          {
            entries: [
              { id: "a", score: 0.9 },
              { id: "b", score: 0.7 },
            ],
            weight: 0.45,
          },
          {
            entries: [
              { id: "b", score: 0.8 },
              { id: "c", score: 0.6 },
            ],
            weight: 0.25,
          },
        ],
        60
      );

      // "b" appears in both lists — should get contributions from both
      const aScore = result.get("a")!;
      const bScore = result.get("b")!;
      const cScore = result.get("c")!;

      // "a" only in vector list at rank 1: 0.45/61
      expect(aScore).toBeCloseTo(0.45 / 61, 5);
      // "b" in vector rank 2 + FTS rank 1: 0.45/62 + 0.25/61
      expect(bScore).toBeCloseTo(0.45 / 62 + 0.25 / 61, 5);
      // "c" only in FTS rank 2: 0.25/62
      expect(cScore).toBeCloseTo(0.25 / 62, 5);

      // "b" should beat "a" because it appears in both lists
      expect(bScore).toBeGreaterThan(aScore);
    });

    it("should respect weight parameter", () => {
      const highWeight = reciprocalRankFusion(
        [{ entries: [{ id: "a", score: 1.0 }], weight: 2.0 }],
        60
      );
      const lowWeight = reciprocalRankFusion(
        [{ entries: [{ id: "a", score: 1.0 }], weight: 0.5 }],
        60
      );

      expect(highWeight.get("a")!).toBeGreaterThan(lowWeight.get("a")!);
      expect(highWeight.get("a")! / lowWeight.get("a")!).toBeCloseTo(4.0);
    });
  });

  describe("computeHybridScore", () => {
    it("should weight scores correctly", () => {
      const weights = {
        vector: 0.45,
        fts: 0.25,
        recency: 0.20,
        frequency: 0.10,
        recencyDecay: 0.05,
      };

      const score = computeHybridScore(1.0, 1.0, 1.0, 1.0, weights);
      expect(score).toBeCloseTo(1.0);
    });

    it("should return 0 when all scores are 0", () => {
      const weights = {
        vector: 0.45,
        fts: 0.25,
        recency: 0.20,
        frequency: 0.10,
        recencyDecay: 0.05,
      };

      const score = computeHybridScore(0, 0, 0, 0, weights);
      expect(score).toBe(0);
    });
  });
});
