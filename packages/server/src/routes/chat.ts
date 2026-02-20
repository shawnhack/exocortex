import { Hono } from "hono";
import { z } from "zod";
import { getDb, MemorySearch, getAllSettings } from "@exocortex/core";
import type { Memory } from "@exocortex/core";
import { stripEmbedding } from "../utils.js";

const chat = new Hono();

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
  try {
    const results = await search.search({
      query: parsed.data.message,
      limit: 5,
    });
    sources = results.map((r) => r.memory);
  } catch {
    // Search may fail if no embeddings; continue without context
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

    if (provider === "openai") {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
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
        const err = await res.json().catch(() => ({}));
        throw new Error(
          (err as any).error?.message ?? `OpenAI API error: ${res.status}`
        );
      }
      const data = (await res.json()) as any;
      responseText = data.choices?.[0]?.message?.content ?? "No response from API";
    } else {
      // Anthropic (default)
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: settings["ai.model"] || "claude-sonnet-4-5-20250929",
          max_tokens: 1024,
          system: systemPrompt,
          messages: [
            ...priorMessages,
            { role: "user", content: parsed.data.message },
          ],
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(
          (err as any).error?.message ?? `Anthropic API error: ${res.status}`
        );
      }
      const data = (await res.json()) as any;
      responseText = data.content?.[0]?.text ?? "No response from API";
    }

    return c.json({
      response: responseText,
      sources: sources.map(stripEmbedding),
      conversation_id: parsed.data.conversation_id ?? crypto.randomUUID(),
    });
  } catch (err) {
    return c.json(
      { error: (err as Error).message },
      500
    );
  }
});

export default chat;
