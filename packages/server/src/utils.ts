import type { Memory } from "@exocortex/core";

export function stripEmbedding(memory: Memory) {
  const { embedding, ...rest } = memory;
  return rest;
}
