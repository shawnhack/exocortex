import type { Memory } from "@exocortex/core";

export function stripEmbedding(memory: Memory) {
  const { embedding, ...rest } = memory;
  return rest;
}

/** Parse an integer query parameter with bounds clamping and fallback. */
export function parseIntQuery(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
