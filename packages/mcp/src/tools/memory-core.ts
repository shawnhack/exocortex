import { z } from "zod";
import { MemoryStore, MemorySearch, MemoryLinkStore, GoalStore, EntityStore, cosineSimilarity, getRRFConfig, searchFacts, getCachedProfiles, stripPrivateContent, validateStorageGate, deepContext, sanitizeContent, validateContent, redactSensitiveData, classifyTrust, detectInfluence, detectTemporalExpiry } from "@exocortex/core";
import type { SearchResult } from "@exocortex/core";
import { estimateTokens, packByTokenBudget, smartPreview } from "../utils.js";
import { expandViaLinks, buildFactsSection, buildEntityProfileSection } from "./helpers.js";
import type { ToolRegistrationContext } from "./types.js";

export function registerMemoryCoreTools(ctx: ToolRegistrationContext): void {
  const { server, db, defaultAttribution: DEFAULT_ATTRIBUTION, recordSearchResults, checkAndSignalUsefulness } = ctx;

  // memory_store
  server.tool(
    "memory_store",
    "Store a new memory. Set provider/model_id/agent for attribution, namespace for project scope, deduplicate: true for facts that may already exist.",
    {
      content: z.string().describe("The content to remember"),
      tags: z.array(z.string()).optional().describe("Tags for categorization"),
      importance: z.number().min(0).max(1).optional().describe("Importance 0-1 (default 0.5, use 0.8+ for critical info)"),
      valence: z.number().min(-1).max(1).optional().describe("Emotional significance (-1=failure/warning, 0=neutral, 1=breakthrough/success)"),
      content_type: z.enum(["text", "conversation", "note", "summary"]).optional().describe("Content type (default 'text')"),
      provider: z.string().optional().describe("Model provider — always set this (e.g. 'anthropic', 'openai')"),
      model_id: z.string().optional().describe("Canonical model identifier — always set this (e.g. 'claude-opus-4-6', 'gpt-5-codex')"),
      model_name: z.string().optional().describe("Human-readable model name — always set this (e.g. 'Claude Opus 4.6', 'GPT-5.3-Codex')"),
      agent: z.string().optional().describe("Agent/runtime identifier — always set this (e.g. 'claude-code', 'codex', 'gemini-cli')"),
      session_id: z.string().optional().describe("Optional agent session/thread identifier"),
      conversation_id: z.string().optional().describe("Optional conversation identifier"),
      metadata: z.record(z.string(), z.any()).optional().describe("Arbitrary JSON metadata (e.g. { model: 'claude-opus-4-6' })"),
      is_metadata: z.boolean().optional().describe("Explicitly mark this memory as metadata/system artifact"),
      benchmark: z.boolean().optional().describe("Store as benchmark artifact (low default importance, reduced indexing/chunking)"),
      expires_at: z.string().optional().describe("ISO timestamp when this memory should auto-expire (e.g. '2026-03-01T00:00:00Z')"),
      namespace: z.string().optional().describe("Project namespace — set to the current project name (e.g. 'exocortex', 'myapp'). Enables scoped retrieval so memories from different projects don't collide."),
      deduplicate: z.boolean().optional().describe("Set true when storing facts or knowledge that might already exist — prevents duplicates. Checks for >85% semantic similarity + >60% word overlap."),
      tier: z.enum(["working", "episodic", "semantic", "procedural", "reference"]).optional().describe("Knowledge tier: working (24h scratch), episodic (default, events), semantic (permanent facts), procedural (permanent techniques), reference (permanent docs)"),
    },
    async (args) => {
      try {
        const stripped = stripPrivateContent(args.content);
        validateStorageGate(stripped, {
          content_type: args.content_type,
          is_metadata: args.is_metadata,
          benchmark: args.benchmark,
          tags: args.tags,
        });

        // Security: sanitize content for prompt injection
        const sanitized = sanitizeContent(stripped);
        const contentToStore = sanitized.modified ? sanitized.content : stripped;

        // Security: validate for sensitive data leaks
        const validation = validateContent(contentToStore);
        const finalContent = validation.safe ? contentToStore : redactSensitiveData(contentToStore);

        // Security: classify trust level
        const trustLevel = classifyTrust(
          "mcp",
          (args.metadata as Record<string, unknown>)?.source_url as string | undefined
        );

        const store = new MemoryStore(db);

        // Auto-set expires_at for transient memories (unless caller provides one)
        let expiresAt = args.expires_at;
        if (!expiresAt && args.tags && args.tags.length > 0) {
          const TRANSIENT_TAGS = new Set(["run-summary", "digest", "sentinel", "operations", "session-digest", "auto-digested"]);
          const hasTransientTag = args.tags.some((t) => TRANSIENT_TAGS.has(t));
          if (hasTransientTag) {
            expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
          }
        }

        // Auto-detect temporal language and set expiry (Supermemory-inspired)
        if (!expiresAt) {
          const detected = detectTemporalExpiry(contentToStore);
          if (detected) expiresAt = detected;
        }

        // Security: detect behavioral influence
        const influence = detectInfluence(contentToStore);

        // Merge security metadata into user-provided metadata
        const securityMeta: Record<string, unknown> = {
          ...(args.metadata ?? {}),
          trust_level: trustLevel,
        };
        if (sanitized.threats.length > 0) {
          securityMeta.threats_detected = sanitized.threats.length;
          securityMeta.threat_types = [...new Set(sanitized.threats.map((t) => t.type))];
        }
        if (!validation.safe) {
          securityMeta.redacted = true;
        }
        if (influence.score > 0.1) {
          securityMeta.influence_score = influence.score;
          securityMeta.influence_verdict = influence.verdict;
        }

        const result = await store.create({
          content: finalContent,
          content_type: args.content_type ?? "text",
          source: "mcp",
          importance: args.importance,
          valence: args.valence,
          tags: args.tags,
          provider: args.provider || DEFAULT_ATTRIBUTION.provider,
          model_id: args.model_id || DEFAULT_ATTRIBUTION.model_id,
          model_name: args.model_name || DEFAULT_ATTRIBUTION.model_name,
          agent: args.agent || DEFAULT_ATTRIBUTION.agent,
          session_id: args.session_id,
          conversation_id: args.conversation_id,
          metadata: securityMeta,
          is_metadata: args.is_metadata,
          benchmark: args.benchmark,
          tier: args.tier,
          expires_at: expiresAt,
          namespace: args.namespace,
          deduplicate: args.deduplicate,
        });

        const meta: string[] = [`id: ${result.memory.id}`];
        if (sanitized.threats.length > 0) meta.push(`⚠ ${sanitized.threats.length} threat(s) sanitized: ${[...new Set(sanitized.threats.map((t) => t.type))].join(", ")}`);
        if (!validation.safe) meta.push(`⚠ sensitive data redacted`);
        if (influence.verdict === "high") meta.push(`⚠ high behavioral influence score (${influence.score})`);
        else if (influence.verdict === "moderate") meta.push(`⚠ moderate influence score (${influence.score})`);
        if (args.tags?.length) meta.push(`tags: ${args.tags.join(", ")}`);
        if (args.importance !== undefined) meta.push(`importance: ${args.importance}`);
        if (result.superseded_id) {
          const pct = Math.round((result.dedup_similarity ?? 0) * 100);
          if (result.dedup_action === "skipped") {
            meta.push(`dedup reused ${result.superseded_id} — ${pct}% similar`);
          } else if (result.dedup_action === "merged") {
            meta.push(`merged into ${result.superseded_id} — ${pct}% similar`);
          } else if (result.dedup_action === "near_duplicate") {
            meta.push(`near-duplicate of ${result.superseded_id} — ${pct}% similar (not stored)`);
          } else {
            meta.push(`superseded ${result.superseded_id} — ${pct}% similar`);
          }
        }

        // Auto-detect goal progress
        if (!args.benchmark && result.dedup_action !== "skipped") {
          try {
            const goalStore = new GoalStore(db);
            const linkedGoalIds = await goalStore.autoLinkProgress(result.memory.id, args.content, result.memory.embedding);
            if (linkedGoalIds.length > 0) {
              const goal = goalStore.getById(linkedGoalIds[0]);
              if (goal) {
                meta.push(`goal: "${goal.title}"`);
              }
            }
          } catch {
            // Non-critical
          }
        }

        // Store-time relation discovery: auto-link similar existing memories
        try {
          if (!args.benchmark && result.dedup_action !== "skipped" && result.memory.embedding) {
            const linkStore = new MemoryLinkStore(db);
            const candidates = db
              .prepare(
                `SELECT id, embedding FROM memories
                 WHERE id != ? AND is_active = 1 AND embedding IS NOT NULL AND parent_id IS NULL
                 ORDER BY created_at DESC LIMIT 200`
              )
              .all(result.memory.id) as unknown as Array<{ id: string; embedding: Uint8Array }>;

            const linked: string[] = [];
            for (const c of candidates) {
              if (linked.length >= 5) break;
              const bytes = c.embedding as unknown as Uint8Array;
              const cEmb = new Float32Array(new Uint8Array(bytes).buffer);
              const sim = cosineSimilarity(result.memory.embedding, cEmb);
              if (sim >= 0.75) {
                linkStore.link(result.memory.id, c.id, "related", Math.round(sim * 100) / 100);
                linked.push(c.id);
              }
            }
            if (linked.length > 0) {
              meta.push(`linked: ${linked.length} related`);

              // Memory evolution: refresh keywords of linked memories
              // so they become easier to find via the new memory's context
              try {
                const { generateKeywords } = await import("@exocortex/core");
                for (const linkedId of linked) {
                  const linkedMem = db
                    .prepare("SELECT content FROM memories WHERE id = ?")
                    .get(linkedId) as { content: string } | undefined;
                  if (!linkedMem) continue;

                  const linkedTags = (db
                    .prepare("SELECT tag FROM memory_tags WHERE memory_id = ?")
                    .all(linkedId) as Array<{ tag: string }>).map((t) => t.tag);
                  const linkedEntities = (db
                    .prepare(
                      "SELECT e.name FROM entities e INNER JOIN memory_entities me ON e.id = me.entity_id WHERE me.memory_id = ?"
                    )
                    .all(linkedId) as Array<{ name: string }>).map((e) => e.name);

                  const newKeywords = generateKeywords(linkedMem.content, linkedTags, linkedEntities);
                  if (newKeywords.length > 0) {
                    db.prepare("UPDATE memories SET keywords = ? WHERE id = ?").run(newKeywords, linkedId);
                  }
                }
              } catch {
                // Keyword refresh is non-critical
              }
            }
          }
        } catch {
          // Relation discovery is non-critical
        }

        // Temporal auto-linking: narratives and epochs link to high-importance episodes
        try {
          const tags = args.tags ?? [];
          const isNarrative = tags.includes("narrative") && tags.includes("weekly-summary");
          const isEpoch = tags.includes("epoch");

          if ((isNarrative || isEpoch) && result.dedup_action !== "skipped") {
            const linkStore = new MemoryLinkStore(db);
            const memDate = new Date(result.memory.created_at);
            const windowDays = isEpoch ? 31 : 7;
            const windowStart = new Date(memDate.getTime() - windowDays * 24 * 60 * 60 * 1000);
            const cap = isEpoch ? 30 : 15;

            const episodes = db
              .prepare(
                `SELECT id FROM memories
                 WHERE is_active = 1 AND importance >= 0.5 AND is_metadata = 0
                   AND created_at >= ? AND created_at < ?
                   AND id != ?
                   AND id NOT IN (SELECT memory_id FROM memory_tags WHERE tag = 'epoch')
                   AND id NOT IN (SELECT memory_id FROM memory_tags WHERE tag = 'narrative')
                 ORDER BY importance DESC
                 LIMIT ?`
              )
              .all(
                windowStart.toISOString().replace("T", " ").slice(0, 19),
                result.memory.created_at,
                result.memory.id,
                cap
              ) as unknown as Array<{ id: string }>;

            let linkedCount = 0;
            for (const ep of episodes) {
              linkStore.link(result.memory.id, ep.id, "elaborates", 0.6);
              linkedCount++;
            }

            // Epochs also link to narratives in the same month
            if (isEpoch) {
              const monthStr = result.memory.created_at.slice(0, 7);
              const narratives = db
                .prepare(
                  `SELECT m.id FROM memories m
                   JOIN memory_tags mt ON mt.memory_id = m.id AND mt.tag = 'narrative'
                   WHERE m.is_active = 1
                     AND strftime('%Y-%m', m.created_at) = ?
                     AND m.id != ?
                   ORDER BY m.created_at DESC`
                )
                .all(monthStr, result.memory.id) as unknown as Array<{ id: string }>;

              for (const n of narratives) {
                linkStore.link(result.memory.id, n.id, "elaborates", 0.8);
                linkedCount++;
              }
            }

            if (linkedCount > 0) {
              meta.push(`hierarchy: ${linkedCount} elaborates links`);
            }
          }
        } catch {
          // Temporal auto-linking is non-critical
        }

        return { content: [{ type: "text", text: `Stored memory (${meta.join(" | ")})` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // memory_search
  server.tool(
    "memory_search",
    "Hybrid search (semantic + keyword + graph). Use compact: true for previews, expanded_query for better recall, max_tokens for budget-packed results.",
    {
      query: z.string().describe("Natural language search query"),
      expanded_query: z.string().optional().describe("2-3 rephrasings with different vocabulary to improve recall"),
      limit: z.number().min(1).max(50).optional().describe("Max results (default 10)"),
      tags: z.array(z.string()).optional().describe("Filter by tags"),
      after: z.string().optional().describe("Only after this date (YYYY-MM-DD)"),
      before: z.string().optional().describe("Only before this date (YYYY-MM-DD)"),
      content_type: z.enum(["text", "conversation", "note", "summary"]).optional().describe("Filter by content type"),
      min_score: z.number().min(0).optional().describe("Minimum score threshold. RRF scoring range is ~0.001-0.03; legacy range is ~0.15-0.80. Default auto-detected from scoring mode."),
      include_metadata: z.boolean().optional().describe("Include benchmark/progress/regression metadata memories (default false)"),
      compact: z.boolean().optional().describe("Return compact results (ID + preview + score) to save tokens. Use memory_get to fetch full content."),
      max_tokens: z.number().min(100).max(100000).optional().describe("Token budget — pack results by relevance until budget exhausted. Overrides limit."),
      namespace: z.string().optional().describe("Filter to a specific project's memories (set to project name)"),
      tier: z.enum(["working", "episodic", "semantic", "procedural", "reference"]).optional().describe("Filter by knowledge tier (e.g. 'semantic' for facts, 'procedural' for techniques)"),
      session_id: z.string().optional().describe("Session ID — includes working-tier memories from this session"),
    },
    async (args) => {
      try {
        const search = new MemorySearch(db);
        const store = new MemoryStore(db);

        const fetchLimit = args.max_tokens ? 50 : (args.limit ?? 10);

        const results = await search.search({
          query: args.query,
          expanded_query: args.expanded_query,
          limit: fetchLimit,
          tags: args.tags,
          after: args.after,
          before: args.before,
          content_type: args.content_type,
          min_score: args.min_score,
          include_metadata: args.include_metadata,
          namespace: args.namespace,
          tier: args.tier,
          session_id: args.session_id,
        });

        if (results.length === 0) {
          return { content: [{ type: "text", text: "No memories found matching the query." }] };
        }

        recordSearchResults(results.map((r) => r.memory.id));

        const scoringMode = getRRFConfig(db).enabled ? "rrf" : "legacy";
        const modeLabel = scoringMode;

        if (args.compact) {
          const formatCompact = (r: typeof results[number]) => {
            const m = r.memory;
            const preview = smartPreview(m.content, args.query);
            const tagStr = m.tags?.length ? ` | tags: ${m.tags.join(", ")}` : "";
            return `[${m.id}] ${preview} (score: ${r.score.toFixed(3)}${tagStr})`;
          };

          if (args.max_tokens) {
            const { formatted, totalTokens } = packByTokenBudget(results, args.max_tokens, formatCompact);
            return {
              content: [{ type: "text", text: `Found ${formatted.length} memories (~${totalTokens} tokens, compact, ${modeLabel}):\n\n${formatted.join("\n")}` }],
            };
          }

          const lines = results.map(formatCompact);
          return {
            content: [{ type: "text", text: `Found ${results.length} memories (compact, ${modeLabel}):\n\n${lines.join("\n")}` }],
          };
        }

        const formatFull = (r: typeof results[number]) => {
          const m = r.memory;
          const meta: string[] = [];
          if (m.tags?.length) meta.push(`tags: ${m.tags.join(", ")}`);
          meta.push(`score: ${r.score.toFixed(3)}`);
          meta.push(`created: ${m.created_at}`);
          if (m.importance !== 0.5) meta.push(`importance: ${m.importance}`);
          if (m.valence !== 0) meta.push(`valence: ${m.valence}`);
          return `[${m.id}] ${m.content}\n  (${meta.join(" | ")})`;
        };

        if (args.max_tokens) {
          const { packed, formatted, totalTokens } = packByTokenBudget(results, args.max_tokens, formatFull);
          for (const r of packed) {
            await store.recordAccess(r.memory.id, args.query);
          }
          return {
            content: [{ type: "text", text: `Found ${formatted.length} memories (~${totalTokens} tokens, ${modeLabel}):\n\n${formatted.join("\n\n")}` }],
          };
        }

        for (const r of results) {
          await store.recordAccess(r.memory.id, args.query);
        }

        const lines = results.map(formatFull);

        const resultIds = results.map((r) => r.memory.id);
        const linked = expandViaLinks(db, resultIds, 3);
        let linkSection = "";
        if (linked.length > 0) {
          recordSearchResults(linked.map((l) => l.id));
          const linkLines = linked.map((l) => {
            const tagStr = l.tags.length ? ` | tags: ${l.tags.join(", ")}` : "";
            return `[${l.id}] ${l.content.substring(0, 200)}${l.content.length > 200 ? "..." : ""}\n  (via ${l.link_type} link, strength: ${l.strength}${tagStr})`;
          });
          linkSection = `\n\n--- Linked (1-hop) ---\n\n${linkLines.join("\n\n")}`;
        }

        const entityProfileSection = buildEntityProfileSection(db, resultIds);
        const factsSection = buildFactsSection(db, args.query);

        return {
          content: [{ type: "text", text: `Found ${results.length} memories (${modeLabel}):\n\n${lines.join("\n\n")}${linkSection}${entityProfileSection}${factsSection}` }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // memory_forget
  server.tool(
    "memory_forget",
    "Delete a memory from Exocortex by ID. Use when information is outdated or incorrect.",
    {
      id: z.string().describe("The memory ID to delete (ULID)"),
    },
    async (args) => {
      try {
        const store = new MemoryStore(db);

        const existing = await store.getById(args.id);
        if (!existing) {
          return { content: [{ type: "text", text: `Memory ${args.id} not found.` }] };
        }

        await store.delete(args.id);
        const preview = existing.content.substring(0, 80) + (existing.content.length > 80 ? "..." : "");
        return { content: [{ type: "text", text: `Deleted memory ${args.id}: "${preview}"` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // memory_context
  server.tool(
    "memory_context",
    "Load broad context about a topic for session start or subject switching. Returns memories ranked by relevance + recency + importance.\n" +
    "Prefer this over memory_search when you need general background rather than a specific answer. For targeted queries mid-conversation, use memory_search instead.\n" +
    "Set deep=true for complex topics — uses LLM to identify gaps and run follow-up queries iteratively (adds ~10-15s, costs ~3 Haiku calls).",
    {
      topic: z.string().describe("Topic to load context for"),
      limit: z.number().min(1).max(30).optional().describe("Max memories (default 15)"),
      compact: z.boolean().optional().describe("Return compact results (ID + preview + score) to save tokens. Use memory_get to fetch full content."),
      max_tokens: z.number().min(100).max(100000).optional().describe("Token budget — pack results by relevance until budget exhausted. Overrides limit."),
      namespace: z.string().optional().describe("Filter to a specific project's memories (set to project name)"),
      deep: z.boolean().optional().describe("Enable iterative deep retrieval — LLM identifies gaps in retrieved memories and generates follow-up queries until converged (max 3 rounds). Requires ai.api_key in settings."),
    },
    async (args) => {
      try {
        const store = new MemoryStore(db);
        const fetchLimit = args.max_tokens ? 50 : (args.limit ?? 15);

        let results: SearchResult[];
        let deepMeta: { iterations: number; queries: string[]; gaps: string[] } | null = null;

        if (args.deep) {
          const deep = await deepContext(db, {
            topic: args.topic,
            limit: fetchLimit,
            namespace: args.namespace,
          });
          results = deep.results;
          deepMeta = { iterations: deep.iterations, queries: deep.queries, gaps: deep.gaps };
        } else {
          const search = new MemorySearch(db);
          results = await search.search({
            query: args.topic,
            limit: fetchLimit,
            namespace: args.namespace,
          });
        }

        if (results.length === 0) {
          return { content: [{ type: "text", text: `No context found for "${args.topic}".` }] };
        }

        recordSearchResults(results.map((r) => r.memory.id));

        if (args.compact) {
          const formatCompact = (r: typeof results[number]) => {
            const m = r.memory;
            const preview = smartPreview(m.content, args.topic);
            const tagStr = m.tags?.length ? ` [${m.tags.join(", ")}]` : "";
            return `- [${m.id}] ${preview}${tagStr} (${m.created_at})`;
          };

          let compactDeepSection = "";
          if (deepMeta && deepMeta.iterations > 0 && deepMeta.queries.length > 1) {
            const queryLines = deepMeta.queries.slice(1).map((q) => `- ${q}`).join("\n");
            compactDeepSection = `\n\n--- Deep retrieval (${deepMeta.iterations} rounds, ${deepMeta.queries.length} queries) ---\nFollow-up queries:\n${queryLines}`;
            if (deepMeta.gaps.length > 0) {
              compactDeepSection += `\nRemaining gaps:\n${deepMeta.gaps.map((g) => `- ${g}`).join("\n")}`;
            }
          }

          if (args.max_tokens) {
            const { formatted, totalTokens } = packByTokenBudget(results, args.max_tokens, formatCompact);
            return {
              content: [{ type: "text", text: `Context for "${args.topic}" (~${totalTokens} tokens, ${formatted.length} memories, compact${deepMeta ? ", deep" : ""}):\n\n${formatted.join("\n")}${compactDeepSection}` }],
            };
          }

          const lines = results.map(formatCompact);
          return {
            content: [{ type: "text", text: `Context for "${args.topic}" (${results.length} memories, compact${deepMeta ? ", deep" : ""}):\n\n${lines.join("\n")}${compactDeepSection}` }],
          };
        }

        const formatFull = (r: typeof results[number]) => {
          const m = r.memory;
          const tagStr = m.tags?.length ? ` [${m.tags.join(", ")}]` : "";
          return `- ${m.content}${tagStr} (${m.created_at})`;
        };

        if (args.max_tokens) {
          const { packed, formatted, totalTokens } = packByTokenBudget(results, args.max_tokens, formatFull);
          for (const r of packed) {
            await store.recordAccess(r.memory.id, `context:${args.topic}`);
          }
          return {
            content: [{ type: "text", text: `Context for "${args.topic}" (~${totalTokens} tokens, ${formatted.length} memories):\n\n${formatted.join("\n")}` }],
          };
        }

        for (const r of results) {
          await store.recordAccess(r.memory.id, `context:${args.topic}`);
        }

        const lines = results.map(formatFull);

        const resultIds = results.map((r) => r.memory.id);
        const linked = expandViaLinks(db, resultIds, 3);
        let linkSection = "";
        if (linked.length > 0) {
          recordSearchResults(linked.map((l) => l.id));
          const linkLines = linked.map((l) => {
            const tagStr = l.tags.length ? ` [${l.tags.join(", ")}]` : "";
            return `- ${l.content.substring(0, 200)}${l.content.length > 200 ? "..." : ""}${tagStr} (via ${l.link_type})`;
          });
          linkSection = `\n\n--- Linked ---\n${linkLines.join("\n")}`;
        }

        const entityProfileSection = buildEntityProfileSection(db, resultIds);
        const factsSection = buildFactsSection(db, args.topic);

        // Surface related goals
        let goalsSection = "";
        try {
          const goalStore = new GoalStore(db);
          const relevantGoals = await goalStore.detectRelevantGoals(args.topic);
          const topGoals = relevantGoals.slice(0, 3);
          if (topGoals.length > 0) {
            const goalLines = topGoals.map((g) => {
              let line = `- ${g.title}`;
              if (g.priority !== "medium") line += ` [${g.priority}]`;
              if (g.deadline) line += ` (due: ${g.deadline})`;
              return line;
            });
            goalsSection = `\n\n--- Related goals ---\n${goalLines.join("\n")}`;
          }
        } catch { /* non-critical */ }

        // Deep retrieval metadata section
        let deepSection = "";
        if (deepMeta && deepMeta.iterations > 0) {
          const queryLines = deepMeta.queries.slice(1).map((q) => `- ${q}`).join("\n");
          deepSection = `\n\n--- Deep retrieval (${deepMeta.iterations} rounds, ${deepMeta.queries.length} queries) ---\nFollow-up queries:\n${queryLines}`;
          if (deepMeta.gaps.length > 0) {
            deepSection += `\nRemaining gaps:\n${deepMeta.gaps.map((g) => `- ${g}`).join("\n")}`;
          }
        }

        return {
          content: [{ type: "text", text: `Context for "${args.topic}" (${results.length} memories${deepMeta ? ", deep" : ""}):\n\n${lines.join("\n")}${linkSection}${entityProfileSection}${factsSection}${goalsSection}${deepSection}` }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // memory_get
  server.tool(
    "memory_get",
    "Fetch full content for specific memory IDs. Implicitly signals usefulness for future ranking.",
    {
      ids: z.array(z.string()).min(1).max(10).describe("Memory IDs to fetch (max 10)"),
    },
    async (args) => {
      try {
        const store = new MemoryStore(db);
        const results: string[] = [];

        checkAndSignalUsefulness(args.ids, db);

        for (const id of args.ids) {
          const memory = await store.getById(id);
          if (!memory) {
            results.push(`[${id}] Not found`);
            continue;
          }

          await store.recordAccess(id);

          const meta: string[] = [];
          meta.push(`source: ${memory.source}`);
          if (memory.source_uri) meta.push(`source_uri: ${memory.source_uri}`);
          if (memory.provider) meta.push(`provider: ${memory.provider}`);
          if (memory.model_id) meta.push(`model_id: ${memory.model_id}`);
          if (memory.model_name) meta.push(`model_name: ${memory.model_name}`);
          if (memory.agent) meta.push(`agent: ${memory.agent}`);
          if (memory.session_id) meta.push(`session_id: ${memory.session_id}`);
          if (memory.conversation_id) meta.push(`conversation_id: ${memory.conversation_id}`);
          if (memory.tags?.length) meta.push(`tags: ${memory.tags.join(", ")}`);
          if (memory.metadata && Object.keys(memory.metadata).length > 0) {
            meta.push(`metadata: ${JSON.stringify(memory.metadata)}`);
          }
          meta.push(`created: ${memory.created_at}`);
          if (memory.importance !== 0.5) meta.push(`importance: ${memory.importance}`);
          if (memory.valence !== 0) meta.push(`valence: ${memory.valence}`);
          results.push(`[${memory.id}] ${memory.content}\n  (${meta.join(" | ")})`);
        }

        return { content: [{ type: "text", text: results.join("\n\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // memory_facts
  server.tool(
    "memory_facts",
    "Query structured subject-predicate-object facts. Use for precise lookups: ports, versions, config values, dependencies.",
    {
      subject: z.string().optional().describe("Filter by subject (LIKE match)"),
      predicate: z.string().optional().describe("Filter by predicate (exact: port, uses, replaced, path, default, version, is)"),
      object: z.string().optional().describe("Filter by object (LIKE match)"),
      memory_id: z.string().optional().describe("Filter by source memory ID"),
      limit: z.number().min(1).max(100).optional().describe("Max results (default 20)"),
    },
    async (args) => {
      try {
        const facts = searchFacts(db, {
          subject: args.subject,
          predicate: args.predicate,
          object: args.object,
          memory_id: args.memory_id,
          limit: args.limit,
        });

        if (facts.length === 0) {
          return { content: [{ type: "text", text: "No facts found matching the query." }] };
        }

        const lines = facts.map((f) =>
          `(${f.subject}) --[${f.predicate}]--> (${f.object})  [confidence: ${f.confidence}, memory: ${f.memory_id}]`
        );

        return {
          content: [{ type: "text", text: `Found ${facts.length} facts:\n\n${lines.join("\n")}` }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // memory_entities
  server.tool(
    "memory_entities",
    "List tracked entities (people, projects, technologies) with linked memory counts.",
    {
      type: z.enum(["person", "project", "technology", "organization", "concept"]).optional().describe("Filter by entity type (deprecated — prefer tags)"),
      tags: z.array(z.string()).optional().describe("Filter entities by tags"),
      query: z.string().optional().describe("Search entity names"),
    },
    async (args) => {
      try {
        let sql = `
          SELECT e.id, e.name, e.type, e.aliases,
                 COUNT(DISTINCT me.memory_id) as memory_count
          FROM entities e
          LEFT JOIN memory_entities me ON e.id = me.entity_id
        `;
        const joins: string[] = [];
        const conditions: string[] = [];
        const params: string[] = [];

        if (args.tags && args.tags.length > 0) {
          joins.push("INNER JOIN entity_tags et ON e.id = et.entity_id");
          conditions.push(`et.tag IN (${args.tags.map(() => "?").join(", ")})`);
          params.push(...args.tags);
        }
        if (args.type) {
          conditions.push("e.type = ?");
          params.push(args.type);
        }
        if (args.query) {
          conditions.push("(e.name LIKE ? OR e.aliases LIKE ?)");
          params.push(`%${args.query}%`, `%${args.query}%`);
        }
        if (joins.length > 0) {
          sql += ` ${joins.join(" ")}`;
        }
        if (conditions.length > 0) {
          sql += ` WHERE ${conditions.join(" AND ")}`;
        }
        sql += " GROUP BY e.id HAVING COUNT(me.memory_id) > 0 ORDER BY memory_count DESC, e.name ASC LIMIT 50";

        const rows = db.prepare(sql).all(...params) as unknown as Array<{
          id: string;
          name: string;
          type: string;
          aliases: string;
          memory_count: number;
        }>;

        if (rows.length === 0) {
          const msg = args.tags
            ? `No entities with tags [${args.tags.join(", ")}] found.`
            : args.type
              ? `No entities of type "${args.type}" found.`
              : "No entities found yet.";
          return { content: [{ type: "text", text: msg }] };
        }

        const entityStore = new EntityStore(db);
        const tagStmt = db.prepare("SELECT tag FROM entity_tags WHERE entity_id = ?");

        const lines = rows.map((r) => {
          let aliases: string[] = [];
          try { aliases = JSON.parse(r.aliases); } catch { /* malformed aliases JSON */ }
          const aliasStr = aliases.length > 0 ? ` (aka: ${aliases.join(", ")})` : "";
          const entityTags = (tagStmt.all(r.id) as Array<{ tag: string }>).map((t) => t.tag);
          const tagsStr = entityTags.length > 0 ? ` [${entityTags.join(", ")}]` : "";
          let line = `- ${r.name}${aliasStr}${tagsStr} — ${r.memory_count} memories`;

          const related = entityStore.getRelatedEntities(r.id);
          if (related.length > 0) {
            const relStrs = related.slice(0, 5).map((rel) => {
              const ctxStr = rel.context ? ` (${rel.context})` : "";
              if (rel.direction === "outgoing") {
                return `${rel.relationship} → ${rel.entity.name}${ctxStr}`;
              }
              return `${rel.relationship} ← ${rel.entity.name}${ctxStr}`;
            });
            line += `\n    Relationships: ${relStrs.join(", ")}`;
            if (related.length > 5) {
              line += ` (+${related.length - 5} more)`;
            }
          }

          return line;
        });

        return {
          content: [{ type: "text", text: `Entities (${rows.length}):\n\n${lines.join("\n")}` }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // memory_graph
  server.tool(
    "memory_graph",
    "Analyze the entity relationship graph — centrality metrics, bridge entities, knowledge domain connections.",
    {
      action: z.enum(["stats", "centrality", "bridges", "communities", "community_summaries"]).describe("Analysis type: 'stats' for overview, 'centrality' for top entities by betweenness, 'bridges' for bridge entities, 'communities' for dense subgraphs, 'community_summaries' for communities with context"),
      limit: z.number().min(1).max(50).optional().describe("Max results for centrality/bridges (default 10)"),
    },
    async (args) => {
      try {
        const { computeGraphStats, computeCentrality, getTopBridgeEntities, detectCommunities, getCommunitySummaries } = await import("@exocortex/core");

        const limit = args.limit ?? 10;

        if (args.action === "stats") {
          const stats = computeGraphStats(db);
          const lines = [
            `Nodes: ${stats.nodeCount}`,
            `Edges: ${stats.edgeCount}`,
            `Components: ${stats.components}`,
            `Avg degree: ${stats.avgDegree}`,
          ];
          return { content: [{ type: "text", text: `Graph stats:\n${lines.join("\n")}` }] };
        }

        if (args.action === "centrality") {
          const centrality = computeCentrality(db);
          if (centrality.length === 0) {
            return { content: [{ type: "text", text: "No entities found in the graph." }] };
          }
          const top = centrality.slice(0, limit);
          const lines = top.map((c, i) =>
            `${i + 1}. ${c.entityName} — degree: ${c.degree}, betweenness: ${c.betweenness.toFixed(4)}, memories: ${c.memoryCount}`
          );
          return { content: [{ type: "text", text: `Top ${top.length} entities by centrality:\n\n${lines.join("\n")}` }] };
        }

        if (args.action === "communities") {
          const communities = detectCommunities(db);
          if (communities.length === 0) {
            return { content: [{ type: "text", text: "No communities detected (need at least 2 connected entities)." }] };
          }
          const top = communities.slice(0, limit);
          const lines = top.map((c) => {
            const members = c.members.map((m) => m.entityName).join(", ");
            return `${c.id + 1}. [${c.size} members, ${c.internalEdges} edges] ${members}`;
          });
          return { content: [{ type: "text", text: `Detected ${communities.length} communities:\n\n${lines.join("\n")}` }] };
        }

        if (args.action === "community_summaries") {
          const summaries = getCommunitySummaries(db, limit);
          if (summaries.length === 0) {
            return { content: [{ type: "text", text: "No communities detected." }] };
          }
          const lines = summaries.map((c) => {
            return `### Community ${c.id + 1} (${c.size} entities, ${c.internalEdges} edges)\n${c.summary}`;
          });
          return { content: [{ type: "text", text: `${summaries.length} communities with summaries:\n\n${lines.join("\n\n")}` }] };
        }

        // bridges
        const bridges = getTopBridgeEntities(db, limit);
        if (bridges.length === 0) {
          return { content: [{ type: "text", text: "No bridge entities found." }] };
        }

        const entityStore = new EntityStore(db);
        const lines = bridges.map((b, i) => {
          const related = entityStore.getRelatedEntities(b.entityId);
          const domains = related.slice(0, 5).map((r) => {
            const ctxStr = r.context ? ` (${r.context})` : "";
            return r.direction === "outgoing" ? `${r.relationship} → ${r.entity.name}${ctxStr}` : `${r.relationship} ← ${r.entity.name}${ctxStr}`;
          });
          const domainStr = domains.length > 0 ? `\n    Connected: ${domains.join(", ")}` : "";
          return `${i + 1}. ${b.entityName} — betweenness: ${b.betweenness.toFixed(4)}, degree: ${b.degree}, memories: ${b.memoryCount}${domainStr}`;
        });
        return { content: [{ type: "text", text: `Top ${bridges.length} bridge entities:\n\n${lines.join("\n")}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // memory_update
  server.tool(
    "memory_update",
    "Update an existing memory's content, tags, importance, or content type. Use when information needs correction or enrichment.",
    {
      id: z.string().describe("The memory ID to update (ULID)"),
      content: z.string().optional().describe("New content (will re-embed)"),
      content_type: z.enum(["text", "conversation", "note", "summary"]).optional().describe("New content type"),
      source_uri: z.string().nullable().optional().describe("Set/clear source URI"),
      provider: z.string().nullable().optional().describe("Set/clear model provider"),
      model_id: z.string().nullable().optional().describe("Set/clear canonical model identifier"),
      model_name: z.string().nullable().optional().describe("Set/clear human-readable model name"),
      agent: z.string().nullable().optional().describe("Set/clear agent/runtime identifier"),
      session_id: z.string().nullable().optional().describe("Set/clear session identifier"),
      conversation_id: z.string().nullable().optional().describe("Set/clear conversation identifier"),
      importance: z.number().min(0).max(1).optional().describe("New importance score"),
      valence: z.number().min(-1).max(1).optional().describe("New valence score (-1 to 1)"),
      is_metadata: z.boolean().optional().describe("Explicitly set metadata/system classification"),
      tags: z.array(z.string()).optional().describe("Replace all tags with these"),
      metadata: z.record(z.string(), z.any()).optional().describe("Merge metadata keys (set value to null to delete a key)"),
      expires_at: z.string().nullable().optional().describe("Set/clear expiry timestamp (ISO format)"),
      namespace: z.string().nullable().optional().describe("Set/clear project namespace"),
      tier: z.enum(["working", "episodic", "semantic", "procedural", "reference"]).optional().describe("Move memory to a different knowledge tier"),
    },
    async (args) => {
      try {
        const { id, ...updates } = args;

        if (
          !updates.content &&
          !updates.content_type &&
          updates.source_uri === undefined &&
          updates.provider === undefined &&
          updates.model_id === undefined &&
          updates.model_name === undefined &&
          updates.agent === undefined &&
          updates.session_id === undefined &&
          updates.conversation_id === undefined &&
          updates.importance === undefined &&
          updates.valence === undefined &&
          updates.is_metadata === undefined &&
          updates.expires_at === undefined &&
          updates.namespace === undefined &&
          updates.tier === undefined &&
          !updates.tags &&
          !updates.metadata
        ) {
          return {
            content: [{
              type: "text",
              text: "No update fields provided. Specify at least one of: content, content_type, source_uri, provider, model_id, model_name, agent, session_id, conversation_id, importance, valence, is_metadata, expires_at, namespace, tier, tags, metadata.",
            }],
          };
        }

        const store = new MemoryStore(db);
        const updated = await store.update(id, updates);

        if (!updated) {
          return { content: [{ type: "text", text: `Memory ${id} not found.` }] };
        }

        const preview = updated.content.substring(0, 80) + (updated.content.length > 80 ? "..." : "");
        const meta: string[] = [];
        if (updated.tags?.length) meta.push(`tags: ${updated.tags.join(", ")}`);
        meta.push(`importance: ${updated.importance}`);
        return { content: [{ type: "text", text: `Updated memory ${id}: "${preview}" (${meta.join(" | ")})` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // memory_browse
  server.tool(
    "memory_browse",
    "Browse memories without semantic search. Filter by tags, content type, or date range. Returns most recent first.",
    {
      tags: z.array(z.string()).optional().describe("Filter by tags (any match)"),
      content_type: z.enum(["text", "conversation", "note", "summary"]).optional().describe("Filter by content type"),
      after: z.string().optional().describe("Only after this date (YYYY-MM-DD)"),
      before: z.string().optional().describe("Only before this date (YYYY-MM-DD)"),
      limit: z.number().min(1).max(50).optional().describe("Max results (default 20)"),
      compact: z.boolean().optional().describe("Return compact results (ID + preview) to save tokens"),
      namespace: z.string().optional().describe("Filter to a specific project's memories (set to project name)"),
      tier: z.enum(["working", "episodic", "semantic", "procedural", "reference"]).optional().describe("Filter by knowledge tier (e.g. 'semantic' for facts, 'procedural' for techniques)"),
    },
    async (args) => {
      try {
        const limit = args.limit ?? 20;
        const conditions: string[] = ["m.is_active = 1", "m.parent_id IS NULL"];
        const params: (string | number)[] = [];

        if (args.namespace) {
          conditions.push("m.namespace = ?");
          params.push(args.namespace);
        }

        if (args.tier) {
          conditions.push("m.tier = ?");
          params.push(args.tier);
        }

        let tagJoin = "";
        if (args.tags && args.tags.length > 0) {
          const placeholders = args.tags.map(() => "?").join(", ");
          tagJoin = ` INNER JOIN memory_tags mt ON m.id = mt.memory_id AND mt.tag IN (${placeholders})`;
          params.push(...args.tags.map((t) => t.toLowerCase().trim()));
        }

        if (args.content_type) {
          conditions.push("m.content_type = ?");
          params.push(args.content_type);
        }
        if (args.after) {
          conditions.push("m.created_at >= ?");
          params.push(args.after);
        }
        if (args.before) {
          conditions.push("m.created_at <= ?");
          params.push(args.before);
        }

        const sql = `
          SELECT DISTINCT m.id, m.content, m.content_type, m.importance, m.valence, m.created_at
          FROM memories m${tagJoin}
          WHERE ${conditions.join(" AND ")}
          ORDER BY m.created_at DESC
          LIMIT ?
        `;
        params.push(limit);

        const rows = db.prepare(sql).all(...params) as unknown as Array<{
          id: string;
          content: string;
          content_type: string;
          importance: number;
          valence: number;
          created_at: string;
        }>;

        if (rows.length === 0) {
          return { content: [{ type: "text", text: "No memories found matching the filters." }] };
        }

        const ids = rows.map((r) => r.id);
        const tagPlaceholders = ids.map(() => "?").join(", ");
        const tagRows = db
          .prepare(`SELECT memory_id, tag FROM memory_tags WHERE memory_id IN (${tagPlaceholders})`)
          .all(...ids) as unknown as Array<{ memory_id: string; tag: string }>;

        const tagMap = new Map<string, string[]>();
        for (const tr of tagRows) {
          const existing = tagMap.get(tr.memory_id) ?? [];
          existing.push(tr.tag);
          tagMap.set(tr.memory_id, existing);
        }

        if (args.compact) {
          const lines = rows.map((r) => {
            const preview = r.content.substring(0, 200) + (r.content.length > 200 ? "..." : "");
            const tags = tagMap.get(r.id);
            const tagStr = tags?.length ? ` [${tags.join(", ")}]` : "";
            return `[${r.id}] ${preview}${tagStr}`;
          });
          return {
            content: [{ type: "text", text: `Browsing ${rows.length} memories (compact):\n\n${lines.join("\n")}` }],
          };
        }

        const lines = rows.map((r) => {
          const tags = tagMap.get(r.id);
          const meta: string[] = [];
          if (tags?.length) meta.push(`tags: ${tags.join(", ")}`);
          meta.push(`type: ${r.content_type}`);
          meta.push(`created: ${r.created_at}`);
          if (r.importance !== 0.5) meta.push(`importance: ${r.importance}`);
          if (r.valence !== 0) meta.push(`valence: ${r.valence}`);
          return `[${r.id}] ${r.content}\n  (${meta.join(" | ")})`;
        });

        return {
          content: [{ type: "text", text: `Browsing ${rows.length} memories:\n\n${lines.join("\n\n")}` }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );
}
