import type { DatabaseSync } from "node:sqlite";
import { getSetting } from "../db/schema.js";

/**
 * HyDE (Hypothetical Document Embeddings) query rewriting.
 *
 * Paper: "Precise Zero-Shot Dense Retrieval without Relevance Labels"
 * https://arxiv.org/abs/2212.10496
 *
 * For vague or keyword-sparse queries, a short LLM-generated hypothetical
 * answer often has vocabulary closer to actual corpus documents than the
 * raw query does. Using the hypothetical for vector search recovers recall
 * that literal-query embedding misses.
 *
 * Trade-off: adds ~200-400ms + one Haiku call (~$0.0003 per query). Worth it
 * for ambiguous queries; wasteful for exact keyword hunts.
 *
 * Integration: the generated text is passed as `expanded_query` to the
 * existing search pipeline, which blends literal + expanded embeddings.
 */

export interface HypotheticalGenerator {
  /** Generate a 1-paragraph hypothetical answer/context for the query. */
  generate(query: string): Promise<string>;
}

const HYDE_SYSTEM_PROMPT = `You are a query expansion assistant for a personal knowledge retrieval system. Given a user's search query, produce a SHORT hypothetical paragraph (2-3 sentences, under 80 words) that might plausibly appear in a stored memory that answers the query.

Rules:
- Write in the declarative style of a notebook entry or memo — not as an answer to the user
- Use specific vocabulary the actual memory would likely use (proper nouns, jargon, version numbers)
- Do not hedge ("perhaps", "might") — write as if confidently recalling the content
- Do not add disclaimers, introductions, or meta-commentary
- If the query is already specific, just rephrase it into a declarative sentence
- Never invent facts — if unsure, generalize rather than fabricate specifics

Output only the hypothetical paragraph, nothing else.`;

export class AnthropicHydeGenerator implements HypotheticalGenerator {
  constructor(
    private apiKey: string,
    private model: string = "claude-haiku-4-5",
  ) {}

  async generate(query: string): Promise<string> {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 200,
        temperature: 0.2,
        system: HYDE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: `Query: ${query}` }],
      }),
    });

    if (!res.ok) {
      throw new Error(`HyDE API error: ${res.status}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (await res.json()) as any;
    const text = data.content?.[0]?.text;
    if (typeof text !== "string" || text.length === 0) {
      throw new Error("HyDE returned empty text");
    }
    return text.trim();
  }
}

/**
 * Check if HyDE query rewriting is enabled in settings AND an API key is available.
 */
export function isHydeEnabled(db: DatabaseSync): boolean {
  return getSetting(db, "search.hyde_enabled") === "true";
}

/**
 * Build a default HyDE generator from settings + env. Returns null if not
 * configured — callers should treat null as "HyDE unavailable" and skip it.
 */
export function getDefaultHydeGenerator(db: DatabaseSync): HypotheticalGenerator | null {
  const apiKey = getSetting(db, "ai.api_key") ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const model = getSetting(db, "search.hyde_model") ?? undefined;
  return new AnthropicHydeGenerator(apiKey, model);
}

// --- Short-circuit cache ---
// HyDE calls are expensive — cache generated hypotheticals per query for 1 hour.
// Same query coming in repeatedly (sessions re-searching) gets the cached hypothetical.

interface CacheEntry {
  text: string;
  ts: number;
}

const HYDE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const HYDE_CACHE_MAX = 500;
const cache = new Map<string, CacheEntry>();

export async function generateWithCache(
  generator: HypotheticalGenerator,
  query: string,
): Promise<string> {
  const key = query.trim().toLowerCase();
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.ts < HYDE_CACHE_TTL_MS) {
    return hit.text;
  }
  const text = await generator.generate(query);
  cache.set(key, { text, ts: now });
  // Evict oldest when over capacity
  if (cache.size > HYDE_CACHE_MAX) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  return text;
}
