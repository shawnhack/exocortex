import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getSetting } from "../db/schema.js";

export function normalizeContentForHash(
  content: string,
  normalizeWhitespace: boolean
): string {
  if (normalizeWhitespace) {
    return content.toLowerCase().replace(/\s+/g, " ").trim();
  }
  return content.trim();
}

export function computeContentHash(
  content: string,
  normalizeWhitespace: boolean
): string {
  const normalized = normalizeContentForHash(content, normalizeWhitespace);
  return createHash("sha256").update(normalized).digest("hex");
}

export function computeContentHashForDb(
  db: DatabaseSync,
  content: string
): string {
  const normalizeWhitespace = getSetting(db, "dedup.hash_normalize_whitespace") !== "false";
  return computeContentHash(content, normalizeWhitespace);
}

