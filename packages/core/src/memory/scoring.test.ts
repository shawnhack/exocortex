import { describe, it, expect } from "vitest";
import {
  recencyScore,
  frequencyScore,
  cosineSimilarity,
  computeHybridScore,
  reciprocalRankFusion,
  goalRelevanceScore,
  qualityScore,
  usefulnessScore,
  valenceScore,
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

  describe("goalRelevanceScore", () => {
    it("should return 0 when no goal keywords", () => {
      expect(goalRelevanceScore(["foo", "bar"], new Set())).toBe(0);
    });

    it("should return 1.0 for goal-progress tag", () => {
      expect(goalRelevanceScore(["goal-progress", "other"], new Set(["memory"]))).toBe(1.0);
    });

    it("should return 0.7 for goal-progress-implicit tag", () => {
      expect(goalRelevanceScore(["goal-progress-implicit"], new Set(["memory"]))).toBe(0.7);
    });

    it("should prefer goal-progress over goal-progress-implicit", () => {
      expect(
        goalRelevanceScore(["goal-progress", "goal-progress-implicit"], new Set(["memory"]))
      ).toBe(1.0);
    });

    it("should score based on tag overlap with goal keywords", () => {
      const keywords = new Set(["memory", "hygiene", "exocortex"]);
      expect(goalRelevanceScore(["memory"], keywords)).toBeCloseTo(1 / 3);
      expect(goalRelevanceScore(["memory", "hygiene"], keywords)).toBeCloseTo(2 / 3);
      expect(goalRelevanceScore(["memory", "hygiene", "exocortex"], keywords)).toBe(1.0);
    });

    it("should return 0 when no tags match keywords", () => {
      expect(goalRelevanceScore(["unrelated"], new Set(["memory", "hygiene"]))).toBe(0);
    });

    it("should cap at 1.0 with many matching tags", () => {
      const keywords = new Set(["a", "b"]);
      // min(keywords.size, 3) = 2, so 2 matches / 2 = 1.0
      expect(goalRelevanceScore(["a", "b", "c"], keywords)).toBe(1.0);
    });

    it("should match content when tags don't match (2+ keyword hits)", () => {
      const keywords = new Set(["memory", "retrieval", "scoring"]);
      // No tag matches, but content has 2+ keyword hits
      const content = "Improved memory retrieval performance by optimizing the index";
      expect(goalRelevanceScore(["unrelated"], keywords, content)).toBeGreaterThan(0);
      expect(goalRelevanceScore(["unrelated"], keywords, content)).toBeLessThanOrEqual(0.5);
    });

    it("should return 0 for content with only 1 keyword hit", () => {
      const keywords = new Set(["memory", "retrieval", "scoring"]);
      const content = "This is about memory only";
      expect(goalRelevanceScore(["unrelated"], keywords, content)).toBe(0);
    });

    it("should prefer tag matches over content matches", () => {
      const keywords = new Set(["memory", "retrieval"]);
      // 2 tag matches / min(2, 3) = 1.0
      const tagScore = goalRelevanceScore(["memory", "retrieval"], keywords);
      // 2 content matches / min(2, 5) = 0.4, capped at 0.5
      const contentScore = goalRelevanceScore(["unrelated"], keywords, "memory retrieval system");
      expect(tagScore).toBeGreaterThan(contentScore);
    });

    it("should return 0 for content match when no content provided", () => {
      const keywords = new Set(["memory", "retrieval"]);
      expect(goalRelevanceScore(["unrelated"], keywords)).toBe(0);
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
        graph: 0,
        usefulness: 0.05,
        valence: 0.05,
        quality: 0.10,
        goalGated: 0.10,
        importance: 0.10,
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
        graph: 0,
        usefulness: 0.05,
        valence: 0.05,
        quality: 0.10,
        goalGated: 0.10,
        importance: 0.10,
      };

      const score = computeHybridScore(0, 0, 0, 0, weights);
      expect(score).toBe(0);
    });
  });

  describe("qualityScore", () => {
    it("should return a value between 0 and 1 for normal inputs", () => {
      const score = qualityScore(0.5, 3, 10, 2, 30);
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(1);
    });

    it("should weight importance at 30%", () => {
      const low = qualityScore(0, 0, 0, 0, 0);
      const high = qualityScore(1, 0, 0, 0, 0);
      expect(high - low).toBeCloseTo(0.3, 1);
    });

    it("should return 0 when NaN propagates to final score", () => {
      // NaN importance propagates through 0.30 * NaN = NaN
      expect(qualityScore(NaN, 0, 0, 0, 0)).toBe(0);
    });

    it("should survive NaN in non-propagating inputs", () => {
      // NaN usefulCount: usefulCount > 0 is false, so usefulness = 0
      // Score should still be valid (freshness 0.15 + importance 0)
      const score = qualityScore(0, NaN, 0, 0, 0);
      expect(Number.isFinite(score)).toBe(true);
    });

    it("should handle zero values gracefully", () => {
      const score = qualityScore(0, 0, 0, 0, 0);
      // Only freshness contributes: 0.15 * exp(0) = 0.15
      expect(score).toBeCloseTo(0.15, 2);
    });

    it("should increase with more useful signals", () => {
      const none = qualityScore(0.5, 0, 5, 2, 10);
      const some = qualityScore(0.5, 3, 5, 2, 10);
      const many = qualityScore(0.5, 8, 5, 2, 10);
      expect(some).toBeGreaterThan(none);
      expect(many).toBeGreaterThan(some);
    });

    it("should decrease with age (freshness decay)", () => {
      const fresh = qualityScore(0.5, 0, 0, 0, 0);
      const old = qualityScore(0.5, 0, 0, 0, 90);
      expect(fresh).toBeGreaterThan(old);
    });
  });

  describe("usefulnessScore", () => {
    it("should return 0 for zero or negative count", () => {
      expect(usefulnessScore(0)).toBe(0);
      expect(usefulnessScore(-1)).toBe(0);
    });

    it("should saturate at 1.0 around count=8", () => {
      expect(usefulnessScore(8)).toBeCloseTo(1.0, 1);
    });

    it("should increase monotonically", () => {
      const a = usefulnessScore(1);
      const b = usefulnessScore(3);
      const c = usefulnessScore(5);
      expect(b).toBeGreaterThan(a);
      expect(c).toBeGreaterThan(b);
    });
  });

  describe("valenceScore", () => {
    it("should return absolute value", () => {
      expect(valenceScore(0.8)).toBe(0.8);
      expect(valenceScore(-0.8)).toBe(0.8);
      expect(valenceScore(0)).toBe(0);
    });

    it("should treat breakthroughs and failures equally", () => {
      expect(valenceScore(1.0)).toBe(valenceScore(-1.0));
    });
  });
});
