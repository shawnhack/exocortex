import type { DatabaseSync } from "node:sqlite";
import { generateBasicSummary } from "./consolidation.js";

export interface SynthesisOptions {
  apiKey?: string;
  provider?: "anthropic" | "openai";
  model?: string;
}

/**
 * Generate a synthesis of cluster members.
 * Always delegates to generateBasicSummary — LLM synthesis is handled
 * externally via Cortex's sentinel gardening job.
 */
export async function generateSynthesis(
  db: DatabaseSync,
  memberIds: string[],
  _options?: SynthesisOptions
): Promise<string> {
  return generateBasicSummary(db, memberIds);
}
