import type { DatabaseSync } from "node:sqlite";
import { getSetting } from "../db/schema.js";

export const DEFAULT_TAG_ALIAS_MAP: Record<string, string> = {
  nextjs: "next.js",
  "next-js": "next.js",
  clawworld: "claw-world",
};

function canonicalize(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[ _]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeAliasMap(
  map: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    const key = canonicalize(k);
    const value = canonicalize(v);
    if (key && value) {
      out[key] = value;
    }
  }
  return out;
}

export function parseTagAliasMap(raw?: string | null): Record<string, string> {
  if (!raw) return { ...DEFAULT_TAG_ALIAS_MAP };
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    return {
      ...DEFAULT_TAG_ALIAS_MAP,
      ...normalizeAliasMap(parsed),
    };
  } catch {
    return { ...DEFAULT_TAG_ALIAS_MAP };
  }
}

export function getTagAliasMap(db: DatabaseSync): Record<string, string> {
  return parseTagAliasMap(getSetting(db, "tags.alias_map"));
}

export function normalizeTag(
  tag: string,
  aliasMap: Record<string, string> = DEFAULT_TAG_ALIAS_MAP
): string {
  const canonical = canonicalize(tag);
  if (!canonical) return "";
  return aliasMap[canonical] ?? canonical;
}

export function normalizeTags(
  tags: string[] | undefined,
  aliasMap: Record<string, string> = DEFAULT_TAG_ALIAS_MAP
): string[] {
  if (!tags || tags.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();

  for (const tag of tags) {
    const normalized = normalizeTag(tag, aliasMap);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }

  return out;
}

