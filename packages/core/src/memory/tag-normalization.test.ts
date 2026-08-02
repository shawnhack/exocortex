import { describe, it, expect } from "vitest";
import {
  parseCanonicalMap,
  canonicalizeTags,
  isProtectedTag,
} from "./tag-normalization.js";

/**
 * These tests exist because of a specific silent failure.
 *
 * The canonical map contained `watchlist -> operations`. The watchlist job
 * stored findings tagged ["watchlist", <topic>] exactly as its prompt
 * specified, and the daily briefing searched tags:["watchlist"] exactly as
 * its prompt specified — but canonicalizeTags rewrote the tag in between, so
 * the briefing found nothing and rendered an empty section every day. Nothing
 * errored. The symptom was noticed 2026-04-23 and root-caused 2026-08-02.
 *
 * The invariant worth protecting: a tag used as an exact-match retrieval
 * filter must never be rewritten by normalization, because doing so does not
 * degrade precision — it makes the memory unreachable by the only query that
 * would ever look for it.
 */

describe("isProtectedTag", () => {
  it("protects correlation handles", () => {
    expect(isProtectedTag("run-token:2026-08-02-gardening-a")).toBe(true);
    expect(isProtectedTag("session:abc123")).toBe(true);
    expect(isProtectedTag("source:kraken")).toBe(true);
    expect(isProtectedTag("2026-08-02")).toBe(true);
  });

  it("protects job-identity tags in both prefixed and bare form", () => {
    expect(isProtectedTag("sentinel:watchlist")).toBe(true);
    expect(isProtectedTag("watchlist")).toBe(true);
    expect(isProtectedTag("crypto-alpha")).toBe(true);
    expect(isProtectedTag("memory-gardening")).toBe(true);
    expect(isProtectedTag("research-briefing")).toBe(true);
  });

  it("leaves ordinary topic tags unprotected", () => {
    for (const t of ["typescript", "sqlite", "bugfix", "monitoring", "rag"]) {
      expect(isProtectedTag(t)).toBe(false);
    }
  });
});

describe("parseCanonicalMap", () => {
  it("drops entries that would rewrite a protected tag", () => {
    // The exact rule that caused the outage, plus its siblings.
    const map = parseCanonicalMap(
      JSON.stringify({
        watchlist: "operations",
        "health-check": "operations",
        "crypto-alpha": "operations",
        "sentinel:metrics": "operations",
      }),
    );
    expect(map).toEqual({});
  });

  it("keeps genuine topic synonyms", () => {
    const map = parseCanonicalMap(
      JSON.stringify({ bugfix: "bug-fix", monitoring: "operations", setup: "config" }),
    );
    expect(map).toEqual({ bugfix: "bug-fix", monitoring: "operations", setup: "config" });
  });

  it("filters protected keys out of a mixed map without disturbing the rest", () => {
    const map = parseCanonicalMap(
      JSON.stringify({ watchlist: "operations", bugfix: "bug-fix" }),
    );
    expect(map).toEqual({ bugfix: "bug-fix" });
  });

  it("lowercases and survives malformed input", () => {
    expect(parseCanonicalMap(JSON.stringify({ BugFix: "Bug-Fix" }))).toEqual({ bugfix: "bug-fix" });
    expect(parseCanonicalMap("not json")).toEqual({});
    expect(parseCanonicalMap(JSON.stringify(["a"]))).toEqual({});
    expect(parseCanonicalMap(null)).toEqual({});
  });
});

describe("canonicalizeTags", () => {
  it("preserves a job-identity tag even when the map tries to rewrite it", () => {
    // End-to-end reproduction of the original bug.
    const map = parseCanonicalMap(JSON.stringify({ watchlist: "operations" }));
    const { tags } = canonicalizeTags(["watchlist", "typescript"], map);
    expect(tags).toContain("watchlist");
    expect(tags).not.toContain("operations");
  });

  it("still applies genuine synonym mappings", () => {
    const map = parseCanonicalMap(JSON.stringify({ bugfix: "bug-fix" }));
    expect(canonicalizeTags(["bugfix"], map).tags).toEqual(["bug-fix"]);
  });

  it("deduplicates after mapping", () => {
    const map = parseCanonicalMap(JSON.stringify({ bugfix: "bug-fix", fix: "bug-fix" }));
    expect(canonicalizeTags(["bugfix", "fix"], map).tags).toEqual(["bug-fix"]);
  });

  it("reports unmapped tags", () => {
    const map = parseCanonicalMap(JSON.stringify({ bugfix: "bug-fix" }));
    const { unmapped } = canonicalizeTags(["bugfix", "typescript"], map);
    expect(unmapped).toEqual(["typescript"]);
  });
});
