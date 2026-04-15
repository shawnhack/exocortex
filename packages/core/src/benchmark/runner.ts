import { DatabaseSync } from "node:sqlite";
import { initializeSchema } from "../db/schema.js";
import { MemoryStore } from "../memory/store.js";
import { MemorySearch } from "../memory/search.js";
import { EntityStore } from "../entities/store.js";
import { GoalStore } from "../goals/store.js";
import type { Memory } from "../memory/types.js";
import type {
  BenchmarkDataset,
  BenchmarkQuestion,
  BenchmarkOptions,
  QuestionResult,
} from "./types.js";
import {
  buildJudgePrompt,
  parseJudgeResponse,
  compositeScore,
} from "./judge.js";

interface AnthropicResponse {
  content: Array<{ type: string; text: string }>;
  usage: { input_tokens: number; output_tokens: number };
}

/**
 * Call the Anthropic Messages API.
 */
async function callAnthropic(
  apiKey: string,
  model: string,
  system: string,
  userMessage: string,
  temperature = 0,
): Promise<{ text: string; tokens: { input: number; output: number }; latency_ms: number }> {
  const start = Date.now();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      temperature,
      system,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as any;
    throw new Error(err.error?.message ?? `Anthropic API error: ${res.status}`);
  }

  const data = (await res.json()) as AnthropicResponse;
  return {
    text: data.content?.[0]?.text ?? "",
    tokens: {
      input: data.usage?.input_tokens ?? 0,
      output: data.usage?.output_tokens ?? 0,
    },
    latency_ms: Date.now() - start,
  };
}

/**
 * Seed the in-memory SQLite database with the benchmark dataset.
 */
async function seedDatabase(
  db: DatabaseSync,
  dataset: BenchmarkDataset,
): Promise<void> {
  const store = new MemoryStore(db);
  const entityStore = new EntityStore(db);
  const goalStore = new GoalStore(db);

  // Seed entities
  for (const entity of dataset.entities) {
    entityStore.create({
      name: entity.name,
      type: entity.type,
      aliases: entity.aliases,
    });
  }

  // Seed goals
  for (const goal of dataset.goals) {
    const created = goalStore.create({
      title: goal.title,
      description: goal.description,
      priority: goal.priority,
    });
    for (const ms of goal.milestones) {
      const milestone = goalStore.addMilestone(created.id, { title: ms.title });
      if (ms.status !== "pending") {
        goalStore.updateMilestone(created.id, milestone.id, { status: ms.status });
      }
    }
  }

  // Seed memories
  for (const mem of dataset.memories) {
    await store.create({
      content: mem.content,
      content_type: mem.content_type,
      importance: mem.importance,
      tags: mem.tags,
      source: "api",
    });
  }
}

/**
 * Format retrieved memories as context (matches chat.ts pattern).
 */
function formatContext(memories: Memory[]): string {
  return memories
    .map(
      (m, i) =>
        `[Memory ${i + 1}] (${m.content_type}, importance: ${m.importance})\n${m.content}`,
    )
    .join("\n\n---\n\n");
}

const SYSTEM_WITH_MEMORY = `You are a helpful assistant with access to the user's persistent memory system. Answer questions using the retrieved memories as context. Be concise, specific, and accurate. Include concrete details (numbers, dates, names) when available in the context.

Retrieved memories:
`;

const SYSTEM_WITHOUT_MEMORY = `You are a helpful assistant. Answer the question to the best of your ability. Be concise and specific. If you don't know specific details, say so rather than guessing.`;

/**
 * Run all benchmark questions with and without memory, then judge each answer.
 */
export async function runQuestions(
  dataset: BenchmarkDataset,
  options: BenchmarkOptions,
): Promise<QuestionResult[]> {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY required");

  const model = options.model ?? "claude-sonnet-4-6";

  // Set up in-memory database
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  initializeSchema(db);
  await seedDatabase(db, dataset);

  const search = new MemorySearch(db);
  const results: QuestionResult[] = [];

  for (const question of dataset.questions) {
    if (options.verbose) {
      process.stderr.write(`  [${question.id}] ${question.question.slice(0, 60)}...\n`);
    }

    // --- With memory ---
    let memoryContext = "";
    try {
      const searchResults = await search.search({
        query: question.question,
        limit: 5,
        min_score: 0,
      });
      memoryContext = formatContext(searchResults.map((r) => r.memory));
    } catch {
      // Continue without context on search failure
    }

    const withMemory = await callAnthropic(
      apiKey,
      model,
      SYSTEM_WITH_MEMORY + (memoryContext || "(No relevant memories found)"),
      question.question,
    );

    // --- Without memory ---
    const withoutMemory = await callAnthropic(
      apiKey,
      model,
      SYSTEM_WITHOUT_MEMORY,
      question.question,
    );

    // --- Judge both answers ---
    const judgeWithPrompt = buildJudgePrompt(question, withMemory.text);
    const judgeWithRes = await callAnthropic(
      apiKey,
      model,
      "You are an impartial evaluator. Score answers accurately.",
      judgeWithPrompt,
    );
    const withScores = parseJudgeResponse(judgeWithRes.text);

    const judgeWithoutPrompt = buildJudgePrompt(question, withoutMemory.text);
    const judgeWithoutRes = await callAnthropic(
      apiKey,
      model,
      "You are an impartial evaluator. Score answers accurately.",
      judgeWithoutPrompt,
    );
    const withoutScores = parseJudgeResponse(judgeWithoutRes.text);

    if (!withScores || !withoutScores) {
      console.warn(`[benchmark] Judge parse failed for question ${question.id}, skipping`);
      continue;
    }

    results.push({
      question,
      with_memory: {
        answer: withMemory.text,
        scores: withScores,
        composite: compositeScore(withScores),
        latency_ms: withMemory.latency_ms,
        tokens: withMemory.tokens,
      },
      without_memory: {
        answer: withoutMemory.text,
        scores: withoutScores,
        composite: compositeScore(withoutScores),
        latency_ms: withoutMemory.latency_ms,
        tokens: withoutMemory.tokens,
      },
    });
  }

  db.close();
  return results;
}
