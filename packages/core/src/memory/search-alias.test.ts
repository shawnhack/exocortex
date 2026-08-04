import { describe, it, expect } from "vitest";
import { hasExactRetrievalAlias } from "./search.js";

/**
 * Background.
 *
 * Retrieval remediation runs respond to a known-failing query by writing a
 * short, purpose-built answer memory that carries the failing query verbatim
 * on an "Exact retrieval aliases:" line. That convention was worthless until
 * now: a freshly written memory has no access history, so frequency,
 * usefulness and quality all scored ~0, and it lost to whatever incumbent
 * blob had accumulated a read history — the rich-get-richer trap. Measured
 * 2026-08-02 on "exocortex five knowledge tiers and their purpose": the
 * purpose-built answer scored a 1.63 boost against the incumbent's 2.24 and
 * never surfaced.
 *
 * These tests pin the matching rule, because the alias boost is large enough
 * (ALIAS_EXACT_BOOST = 1.0) that a false positive would let an unrelated
 * memory jump the ranking.
 */

const ANSWER = [
  "Exocortex has five knowledge tiers: working, episodic, semantic,",
  "procedural, reference.",
  "",
  "Exact retrieval aliases: exocortex five knowledge tiers and their purpose; what are the exocortex tiers",
  "",
  "Stored by retrieval-remediation.",
].join("\n");

describe("hasExactRetrievalAlias", () => {
  it("matches an alias declared on the alias line", () => {
    expect(hasExactRetrievalAlias(ANSWER, "exocortex five knowledge tiers and their purpose")).toBe(true);
    expect(hasExactRetrievalAlias(ANSWER, "what are the exocortex tiers")).toBe(true);
  });

  it("ignores case and punctuation", () => {
    expect(hasExactRetrievalAlias(ANSWER, "What Are The Exocortex Tiers?")).toBe(true);
    expect(hasExactRetrievalAlias(ANSWER, "  what are  the exocortex   tiers  ")).toBe(true);
  });

  it("accepts the singular marker spelling", () => {
    expect(hasExactRetrievalAlias("x\nExact retrieval alias: pm2 dump file", "pm2 dump file")).toBe(true);
  });

  it("accepts pipe as a separator", () => {
    expect(hasExactRetrievalAlias("Exact retrieval aliases: alpha | beta", "beta")).toBe(true);
  });

  it("requires the whole alias, not a substring", () => {
    // The boost is large; partial credit would let broad queries hijack it.
    expect(hasExactRetrievalAlias(ANSWER, "exocortex")).toBe(false);
    expect(hasExactRetrievalAlias(ANSWER, "knowledge tiers")).toBe(false);
    expect(hasExactRetrievalAlias(ANSWER, "exocortex five knowledge tiers and their purpose in detail")).toBe(false);
  });

  it("only reads the alias line, not the rest of the memory", () => {
    const content = "Exact retrieval aliases: alpha\nsome other line about beta";
    expect(hasExactRetrievalAlias(content, "beta")).toBe(false);
  });

  it("returns false when the memory declares no aliases", () => {
    expect(hasExactRetrievalAlias("A memory with no marker at all.", "anything")).toBe(false);
  });

  it("returns false for an empty or whitespace query", () => {
    expect(hasExactRetrievalAlias(ANSWER, "")).toBe(false);
    expect(hasExactRetrievalAlias(ANSWER, "   ")).toBe(false);
  });

  it("does not match an empty alias slot", () => {
    // Trailing separators must not produce a wildcard.
    expect(hasExactRetrievalAlias("Exact retrieval aliases: alpha;;", "")).toBe(false);
  });
});
