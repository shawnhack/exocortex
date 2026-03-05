import type { BenchmarkQuestion, DimensionScores } from "./types.js";

const WEIGHTS = {
  accuracy: 0.35,
  specificity: 0.25,
  continuity: 0.20,
  hallucination: 0.20,
};

export function compositeScore(scores: DimensionScores): number {
  return (
    scores.accuracy * WEIGHTS.accuracy +
    scores.specificity * WEIGHTS.specificity +
    scores.continuity * WEIGHTS.continuity +
    scores.hallucination * WEIGHTS.hallucination
  );
}

/**
 * Build the LLM-as-judge prompt for scoring a single answer.
 */
export function buildJudgePrompt(
  question: BenchmarkQuestion,
  answer: string,
): string {
  return `You are an expert evaluator scoring an AI assistant's answer.

## Question
${question.question}

## Ground Truth
${question.ground_truth}

## Required Facts (should be present)
${question.required_facts.map((f) => `- ${f}`).join("\n")}

## Forbidden Facts (hallucination traps — should NOT be present)
${question.forbidden_facts.map((f) => `- ${f}`).join("\n")}

## Answer to Evaluate
${answer}

## Scoring Instructions
Score the answer on these 4 dimensions (0-10 each):

1. **accuracy**: How many required facts are correctly stated? 10 = all present and correct, 0 = none present.
2. **specificity**: Does the answer include concrete details (numbers, names, versions) rather than vague generalities? 10 = highly specific, 0 = completely vague.
3. **continuity**: Does the answer respect established context and past decisions rather than re-debating or contradicting them? 10 = fully consistent, 0 = contradicts everything.
4. **hallucination**: Are all stated facts accurate? 10 = no fabrication, 0 = entirely made up. Deduct heavily for any forbidden facts that appear.

Respond with ONLY a JSON object, no other text:
{"accuracy": <0-10>, "specificity": <0-10>, "continuity": <0-10>, "hallucination": <0-10>}`;
}

/**
 * Parse the judge's JSON response into dimension scores.
 * Falls back to zeros if parsing fails.
 */
export function parseJudgeResponse(response: string): DimensionScores {
  try {
    // Extract JSON from the response (in case there's extra text)
    const match = response.match(/\{[^}]+\}/);
    if (!match) return { accuracy: 0, specificity: 0, continuity: 0, hallucination: 0 };

    const parsed = JSON.parse(match[0]);
    return {
      accuracy: clamp(parsed.accuracy ?? 0),
      specificity: clamp(parsed.specificity ?? 0),
      continuity: clamp(parsed.continuity ?? 0),
      hallucination: clamp(parsed.hallucination ?? 0),
    };
  } catch {
    return { accuracy: 0, specificity: 0, continuity: 0, hallucination: 0 };
  }
}

function clamp(n: number): number {
  return Math.max(0, Math.min(10, Number(n) || 0));
}
