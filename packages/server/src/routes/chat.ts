import { Hono } from "hono";
import { z } from "zod";
import { getDb, MemorySearch, getAllSettings } from "@exocortex/core";
import type { Memory } from "@exocortex/core";
import { stripEmbedding } from "../utils.js";

interface ApiErrorResponse {
  error?: { message?: string };
}

interface OpenAIResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

interface AnthropicResponse {
  content?: Array<{ text?: string }>;
}

const chat = new Hono();

// Per-IP sliding window rate limiter (20 req/min)
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;
const requestTimestamps = new Map<string, number[]>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const timestamps = requestTimestamps.get(ip) ?? [];
  const recent = timestamps.filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) return false;
  recent.push(now);
  requestTimestamps.set(ip, recent);
  return true;
}

const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

const chatSchema = z.object({
  message: z.string().min(1),
  history: z.array(chatMessageSchema).optional(),
  conversation_id: z.string().optional(),
});

// POST /api/chat — RAG chat endpoint
chat.post("/api/chat", async (c) => {
  const ip = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "unknown";
  if (!checkRateLimit(ip)) {
    return c.json({ error: "Too many requests. Try again later." }, 429);
  }

  const body = await c.req.json();
  const parsed = chatSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const db = getDb();
  const settings = getAllSettings(db);

  const apiKey = settings["ai.api_key"] || settings["ai.apiKey"];
  const provider = settings["ai.provider"] || "anthropic";

  if (!apiKey) {
    return c.json(
      { error: "No AI API key configured. Set ai.api_key in Settings." },
      400
    );
  }

  // Search for relevant memories
  const search = new MemorySearch(db);
  let sources: Memory[] = [];
  let contextWarning: string | undefined;
  try {
    const results = await search.search({
      query: parsed.data.message,
      limit: 5,
    });
    sources = results.map((r) => r.memory);
  } catch {
    // Search may fail if no embeddings; continue without context
    contextWarning = "Memory search failed; response is not based on your stored knowledge.";
  }

  // Build context from sources
  const context = sources
    .map(
      (m, i) =>
        `[Memory ${i + 1}] (${m.content_type}, importance: ${m.importance})\n${m.content}`
    )
    .join("\n\n---\n\n");

  const systemPrompt = `You are a helpful assistant with access to the user's memory system. Answer questions using the retrieved memories as context. Be concise and accurate. If the memories don't contain relevant information, say so.

Retrieved memories:
${context || "(No relevant memories found)"}`;

  try {
    let responseText: string;

    // Build message history for multi-turn context
    const priorMessages = (parsed.data.history ?? []).map((m) => ({
      role: m.role,
      content: m.content,
    }));

    // 30s timeout on external API calls to prevent indefinite hangs
    const apiTimeout = AbortSignal.timeout(30_000);

    if (provider === "openai") {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        signal: apiTimeout,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: settings["ai.model"] || "gpt-4o-mini",
          messages: [
            { role: "system", content: systemPrompt },
            ...priorMessages,
            { role: "user", content: parsed.data.message },
          ],
          max_tokens: 1024,
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as ApiErrorResponse;
        throw new Error(
          err.error?.message ?? `OpenAI API error: ${res.status}`
        );
      }
      const data = (await res.json()) as OpenAIResponse;
      responseText = data.choices?.[0]?.message?.content ?? "No response from API";
    } else {
      // Anthropic (default)
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: apiTimeout,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: settings["ai.model"] || "claude-sonnet-4-6",
          max_tokens: 1024,
          system: systemPrompt,
          messages: [
            ...priorMessages,
            { role: "user", content: parsed.data.message },
          ],
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as ApiErrorResponse;
        throw new Error(
          err.error?.message ?? `Anthropic API error: ${res.status}`
        );
      }
      const data = (await res.json()) as AnthropicResponse;
      responseText = data.content?.[0]?.text ?? "No response from API";
    }

    return c.json({
      response: responseText,
      sources: sources.map(stripEmbedding),
      conversation_id: parsed.data.conversation_id ?? crypto.randomUUID(),
      ...(contextWarning ? { warning: contextWarning } : {}),
    });
  } catch (err) {
    return c.json(
      { error: (err as Error).message },
      500
    );
  }
});

export default chat;
