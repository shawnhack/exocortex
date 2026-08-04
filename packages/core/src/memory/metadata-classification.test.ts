import { describe, it, expect } from "vitest";
import { inferIsMetadata } from "./metadata-classification.js";

/**
 * These tests exist because of a self-defeating loop.
 *
 * Retrieval remediation responds to a known-failing query by writing a short
 * answer memory carrying that query verbatim. It tagged that work
 * `goal-progress`, because writing it *was* goal progress. Classification
 * treated the tag as proof the memory was bookkeeping, so search multiplied it
 * by the metadata penalty (0.35) and the query it was written to fix kept
 * failing — prompting the next run to write another one.
 *
 * Measured 2026-08-02 on "exocortex five knowledge tiers and their purpose":
 * the answer memory sat at rank 41. Correcting the flag moved it to rank 9,
 * and to rank 1–2 combined with scoring fixes. 72 active memories, 14% of the
 * corpus, were suppressed on provenance alone.
 *
 * The invariant: a tag saying WHY a memory was written must not, by itself,
 * decide WHAT it is.
 */

const METADATA_TAGS = new Set([
  "benchmark-artifact",
  "golden-queries",
  "retrieval-regression",
  "goal-progress",
  "goal-progress-implicit",
]);
const base = { metadataTags: METADATA_TAGS };

describe("inferIsMetadata — provenance tags", () => {
  it("does not classify a durable-tier memory as metadata on a goal-progress tag alone", () => {
    // The exact shape of the memory that was suppressed.
    expect(inferIsMetadata({ ...base, tags: ["goal-progress", "answer-bearing"], tier: "semantic" })).toBe(false);
    expect(inferIsMetadata({ ...base, tags: ["goal-progress-implicit"], tier: "procedural" })).toBe(false);
    expect(inferIsMetadata({ ...base, tags: ["goal-progress"], tier: "reference" })).toBe(false);
  });

  it("honours the answer-bearing marker even on a decaying tier", () => {
    expect(inferIsMetadata({ ...base, tags: ["goal-progress", "answer-bearing"], tier: "episodic" })).toBe(false);
  });

  it("still classifies an ordinary progress log", () => {
    // No content marker, no durable tier — this really is bookkeeping.
    expect(inferIsMetadata({ ...base, tags: ["goal-progress"], tier: "episodic" })).toBe(true);
    expect(inferIsMetadata({ ...base, tags: ["goal-progress-implicit"], tier: "working" })).toBe(true);
    expect(inferIsMetadata({ ...base, tags: ["goal-progress"] })).toBe(true);
  });
});

describe("inferIsMetadata — content-kind tags still classify on sight", () => {
  it("keeps benchmark and regression artifacts as metadata regardless of tier", () => {
    for (const tag of ["benchmark-artifact", "golden-queries", "retrieval-regression"]) {
      expect(inferIsMetadata({ ...base, tags: [tag], tier: "semantic" })).toBe(true);
      expect(inferIsMetadata({ ...base, tags: [tag, "answer-bearing"], tier: "procedural" })).toBe(true);
    }
  });

  it("classifies when a content-kind tag accompanies a provenance tag", () => {
    expect(
      inferIsMetadata({ ...base, tags: ["goal-progress", "retrieval-regression"], tier: "semantic" })
    ).toBe(true);
  });
});

describe("inferIsMetadata — precedence and other signals", () => {
  it("lets an explicit flag win over everything", () => {
    expect(inferIsMetadata({ ...base, explicit: true, tags: ["answer-bearing"], tier: "semantic" })).toBe(true);
    expect(inferIsMetadata({ ...base, explicit: false, tags: ["benchmark-artifact"] })).toBe(false);
  });

  it("treats the benchmark flag as decisive", () => {
    expect(inferIsMetadata({ ...base, benchmark: true, tags: [], tier: "semantic" })).toBe(true);
  });

  it("applies the same provenance rule to metadata.mode and metadata.kind", () => {
    expect(inferIsMetadata({ ...base, metadata: { mode: "progress" }, tier: "episodic" })).toBe(true);
    expect(inferIsMetadata({ ...base, metadata: { mode: "progress" }, tier: "semantic" })).toBe(false);
    expect(inferIsMetadata({ ...base, metadata: { kind: "goal-progress" }, tier: "semantic" })).toBe(false);
    expect(inferIsMetadata({ ...base, metadata: { kind: "goal-progress" }, tier: "episodic" })).toBe(true);
    // Non-provenance kinds are unaffected by tier.
    expect(inferIsMetadata({ ...base, metadata: { mode: "benchmark" }, tier: "semantic" })).toBe(true);
    expect(inferIsMetadata({ ...base, metadata: { kind: "alert" }, tier: "semantic" })).toBe(true);
  });

  it("returns false for an ordinary memory", () => {
    expect(inferIsMetadata({ ...base, tags: ["typescript", "sqlite"], tier: "semantic" })).toBe(false);
    expect(inferIsMetadata({ ...base, tags: [], tier: "episodic" })).toBe(false);
  });
});
