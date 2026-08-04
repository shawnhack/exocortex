import type { DatabaseSync } from "node:sqlite";
import { getSetting } from "../db/schema.js";
import { normalizeTags } from "./tag-normalization.js";

const DEFAULT_METADATA_TAGS = [
  "benchmark-artifact",
  "golden-queries",
  "retrieval-regression",
  "goal-progress",
  "goal-progress-implicit",
];

/**
 * Tags that describe WHY a memory was written rather than WHAT it contains.
 *
 * An agent working a goal tags its output `goal-progress` regardless of
 * whether that output is a bookkeeping note ("logged progress on goal X") or
 * a substantive domain fact. Treating the tag alone as proof of metadata
 * therefore penalizes real content for its provenance.
 *
 * This was not theoretical. Retrieval remediation answers a known-failing
 * query by writing a short answer memory carrying that query verbatim — and
 * tagged that work `goal-progress`, because writing it was goal progress. The
 * memory was then classed as metadata and multiplied by the metadata penalty
 * (0.35), so the query it was written to fix kept failing, and the next run
 * wrote another one. Measured 2026-08-02: the answer for "exocortex five
 * knowledge tiers and their purpose" sat at rank 41; clearing the flag alone
 * moved it to rank 9. 72 active memories — 14% of the corpus — were
 * suppressed on provenance alone.
 *
 * The other tags in DEFAULT_METADATA_TAGS describe content that really is
 * system bookkeeping, so they still classify on sight.
 */
const PROVENANCE_ONLY_TAGS = new Set(["goal-progress", "goal-progress-implicit"]);

/**
 * Tiers reserved for durable knowledge. Progress logs are filed as episodic,
 * so a permanent tier is a reliable sign the memory is substantive.
 */
const SUBSTANTIVE_TIERS = new Set(["semantic", "procedural", "reference"]);

/** Explicit marker written by retrieval remediation on purpose-built answers. */
const CONTENT_MARKER_TAGS = new Set(["answer-bearing"]);

/**
 * True when something about the memory, other than its provenance tags, says
 * it carries real content.
 */
function looksSubstantive(tags: string[], tier?: string | null): boolean {
  if (tier && SUBSTANTIVE_TIERS.has(tier)) return true;
  return tags.some((t) => CONTENT_MARKER_TAGS.has(t));
}

export function getMetadataTags(
  db: DatabaseSync,
  aliasMap: Record<string, string>
): Set<string> {
  const configured = getSetting(db, "search.metadata_tags");
  const tags = configured
    ? configured.split(",").map((t) => t.trim()).filter(Boolean)
    : DEFAULT_METADATA_TAGS;
  return new Set(normalizeTags(tags, aliasMap));
}

export function inferIsMetadata(opts: {
  explicit?: boolean;
  benchmark?: boolean;
  tags?: string[];
  tier?: string | null;
  metadata?: Record<string, unknown>;
  metadataTags: Set<string>;
}): boolean {
  if (opts.explicit !== undefined) return opts.explicit;
  if (opts.benchmark) return true;

  const tags = opts.tags ?? [];
  const substantive = looksSubstantive(tags, opts.tier);

  // A provenance tag only classifies when nothing else marks this as content.
  const matched = tags.filter((tag) => opts.metadataTags.has(tag));
  if (matched.some((tag) => !PROVENANCE_ONLY_TAGS.has(tag))) return true;
  if (matched.length > 0 && !substantive) return true;

  const metadata = opts.metadata ?? {};
  const mode = typeof metadata.mode === "string" ? metadata.mode.toLowerCase() : "";
  if (mode === "benchmark" || mode === "regression") return true;
  if (mode === "progress" && !substantive) return true;

  const kind = typeof metadata.kind === "string" ? metadata.kind.toLowerCase() : "";
  if (
    kind.includes("retrieval-regression") ||
    kind.includes("benchmark") ||
    kind.includes("alert")
  ) {
    return true;
  }
  if (kind.includes("goal-progress") && !substantive) return true;

  return false;
}

