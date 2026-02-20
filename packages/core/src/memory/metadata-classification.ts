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
  metadata?: Record<string, unknown>;
  metadataTags: Set<string>;
}): boolean {
  if (opts.explicit !== undefined) return opts.explicit;
  if (opts.benchmark) return true;

  const tags = opts.tags ?? [];
  if (tags.some((tag) => opts.metadataTags.has(tag))) {
    return true;
  }

  const metadata = opts.metadata ?? {};
  const mode = typeof metadata.mode === "string" ? metadata.mode.toLowerCase() : "";
  if (mode === "benchmark" || mode === "progress" || mode === "regression") {
    return true;
  }

  const kind = typeof metadata.kind === "string" ? metadata.kind.toLowerCase() : "";
  if (
    kind.includes("retrieval-regression") ||
    kind.includes("goal-progress") ||
    kind.includes("benchmark") ||
    kind.includes("alert")
  ) {
    return true;
  }

  return false;
}

