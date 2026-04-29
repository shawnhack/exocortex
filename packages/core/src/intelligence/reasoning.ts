/**
 * Memory reasoning — assemble a structured evidence package from retrieved
 * memories so the calling agent can synthesize an answer.
 *
 * Architectural choice: this tool does NOT call its own LLM. The calling
 * agent (Claude Code, codex, sentinel, etc.) is already an LLM and is the
 * reasoner. Adding a nested LLM call would be:
 *   - Wasteful (extra tokens, latency, API-key dependency)
 *   - Lower quality (the calling agent is usually as smart or smarter)
 *   - Architecturally redundant (synthesis intelligence already in the room)
 *
 * Instead, this tool:
 *   1. Retrieves the most relevant memories using existing search infrastructure
 *   2. Packages them as structured evidence with metadata + citation hints
 *   3. Returns a synthesis brief the calling agent uses to reason
 *
 * Distinct from `memory_search` (returns ranked candidates with previews) and
 * `memory_context` (returns formatted context for free-form use). This tool
 * is specifically optimized for the "synthesize an answer to a question"
 * reasoning operation.
 *
 * Use cases (questions to ask the calling agent, who then uses this tool):
 *   - "What's my current best understanding of X?"
 *   - "Given everything I know about Y, what should I do next?"
 *   - "What's the pattern across my decisions about Z?"
 *   - "Are there contradictions in my thinking about W?"
 */
import type { DatabaseSync } from "node:sqlite";
import { MemorySearch } from "../memory/search.js";
import type { RerankerProvider } from "../memory/reranker.js";

export interface MemoryReasonOptions {
  /** Number of memories to retrieve as evidence (default: 15) */
  retrievalLimit?: number;
  /** Filter retrieval by tags */
  tags?: string[];
  /** Filter retrieval by date */
  after?: string;
  before?: string;
  /** Filter retrieval by knowledge tier */
  tier?: "working" | "episodic" | "semantic" | "procedural" | "reference";
  /** Filter retrieval by namespace */
  namespace?: string;
  /** Optional reranker for higher-quality retrieval */
  reranker?: RerankerProvider;
  /** Custom expanded query for vector search (e.g. user-supplied HyDE-style hint) */
  expanded_query?: string;
  /** Truncate long memory content to this many chars (default: 800) */
  contentTruncate?: number;
}

export interface MemoryEvidence {
  id: string;
  rank: number;
  score: number;
  created_at: string;
  tier: string;
  importance: number;
  tags: string[];
  content: string;
}

export interface MemoryReasonBrief {
  /** The question being reasoned about */
  question: string;
  /** Number of memories retrieved as evidence */
  evidenceCount: number;
  /** Structured evidence: ranked memories with metadata, ready to reason over */
  evidence: MemoryEvidence[];
  /** Synthesis rubric the calling agent should follow */
  rubric: string;
  /** Time taken for retrieval (ms) */
  retrieval_ms: number;
}

const SYNTHESIS_RUBRIC = `Synthesis rubric (apply this when reasoning over the evidence above):

1. **Lead with the answer.** Direct prose, no preamble.

2. **Ground every claim in cited memories.** Use [<memory-id>] inline citations whenever you reference a specific fact. The user verifies claims against source memories.

3. **Distinguish epistemic levels:**
   - "the corpus shows" — directly stated in 2+ memories
   - "memories suggest" — implied by 1-2 memories
   - "inferring across these" — your synthesis, not in any single memory
   Don't blur these.

4. **Surface conflicts.** If two memories disagree, name the conflict explicitly rather than picking one. Conflict awareness is more valuable than smoothed-over false certainty.

5. **Name corpus gaps.** If the question requires evidence the corpus doesn't have, say so. Don't fabricate to fill gaps.

6. **Calibrate confidence.** End with one of:
   - HIGH CONFIDENCE: corpus directly answers with multiple consistent memories
   - MEDIUM CONFIDENCE: corpus answers with strong but not unanimous evidence
   - LOW CONFIDENCE: corpus has relevant context but doesn't really answer; significant inference required
   - INSUFFICIENT EVIDENCE: corpus has minimal relevant material; answer would be mostly speculation

7. **Default skepticism over confidence inflation.** Low-confidence with honest gaps is more useful than confident hallucination.`;

/**
 * Build a reasoning brief from retrieved memories.
 *
 * The calling agent uses the returned brief to synthesize an answer.
 * This function does no LLM calls and has no external dependencies
 * beyond the existing search infrastructure.
 */
export async function buildReasoningBrief(
  db: DatabaseSync,
  question: string,
  options: MemoryReasonOptions = {},
): Promise<MemoryReasonBrief> {
  const t0 = Date.now();
  const retrievalLimit = options.retrievalLimit ?? 15;
  const truncate = options.contentTruncate ?? 800;

  const search = new MemorySearch(db);
  const results = await search.search(
    {
      query: question,
      limit: retrievalLimit,
      tags: options.tags,
      after: options.after,
      before: options.before,
      tier: options.tier,
      namespace: options.namespace,
      expanded_query: options.expanded_query,
    },
    options.reranker,
  );

  const evidence: MemoryEvidence[] = results.map((r, i) => {
    const content = r.memory.content;
    const truncated =
      content.length > truncate
        ? content.slice(0, truncate) + "...[truncated]"
        : content;
    return {
      id: r.memory.id,
      rank: i + 1,
      score: r.score,
      created_at: r.memory.created_at ?? "?",
      tier: r.memory.tier ?? "?",
      importance: r.memory.importance ?? 0.5,
      tags: r.memory.tags ?? [],
      content: truncated,
    };
  });

  return {
    question,
    evidenceCount: evidence.length,
    evidence,
    rubric: SYNTHESIS_RUBRIC,
    retrieval_ms: Date.now() - t0,
  };
}

/**
 * Format a reasoning brief as a single string ready to inject into an agent's
 * context window. Useful when the caller wants the brief as a flat prompt
 * rather than structured fields.
 */
export function formatReasoningBrief(brief: MemoryReasonBrief): string {
  if (brief.evidenceCount === 0) {
    return `Question: ${brief.question}

No relevant memories found in the corpus to answer this question. Acknowledge the gap explicitly rather than fabricating.`;
  }

  const evidenceLines = brief.evidence.map((e) => {
    const tagStr = e.tags.slice(0, 6).join(", ") || "(no tags)";
    return [
      `[${e.rank}] id=${e.id} | created=${e.created_at.slice(0, 10)} | tier=${e.tier} | importance=${e.importance} | rank-score=${e.score.toFixed(4)}`,
      `tags: ${tagStr}`,
      e.content,
    ].join("\n");
  });

  return `Question: ${brief.question}

Relevant memories from the corpus (${brief.evidenceCount} retrieved, ranked by relevance):

${evidenceLines.join("\n\n---\n\n")}

${brief.rubric}`;
}
