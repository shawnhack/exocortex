# Exocortex

Personal unified memory system — SQLite-backed, local-first, hybrid RAG retrieval.

## Stack

- Monorepo: pnpm workspaces
- Packages: `core`, `cli`, `server`, `mcp`, `dashboard`
- DB: Node built-in SQLite (`node:sqlite`)
- Embeddings: HuggingFace `all-MiniLM-L6-v2` (local, no API key)
- Scoring: Reciprocal Rank Fusion (RRF) by default, fusing vector + FTS + graph ranked lists with recency/frequency/usefulness boost. Legacy weighted-average mode available via `scoring.use_rrf=false`.
- Dashboard: React + Vite, Neural Interface theme
- Tests: Vitest

## Key Commands

- `pnpm test` — run all tests
- `pnpm build` — build all packages
- `pnpm lint` — typecheck with tsc

## MCP Setup

The MCP server works with any MCP-compatible tool (Claude Code, Codex, Gemini, Copilot, etc.). The entry point is `packages/mcp/dist/index.js`.

**Claude Code** (registered globally so memory tools are available in every session):
```bash
claude mcp add --scope user exocortex node /path/to/exocortex/packages/mcp/dist/index.js
```

**Codex CLI** (`~/.codex/config.toml`):
```toml
[mcp_servers.exocortex]
command = "node"
args = ["/path/to/exocortex/packages/mcp/dist/index.js"]
```

**Gemini CLI** (`~/.gemini/settings.json`):
```json
{ "mcpServers": { "exocortex": { "command": "node", "args": ["/path/to/exocortex/packages/mcp/dist/index.js"] } } }
```

The project-level `.mcp.json` also exists as a fallback for this repo specifically (update the path after cloning).

## Data Directory

All data stored in `~/.exocortex/` (DB + cached embedding models). Override model cache with `EXOCORTEX_MODEL_DIR` env var.

## Dashboard Pages

- **Dashboard** (`/dashboard`) — memory storage overview (stats, charts, temporal data)
- **Search** (`/`) — hybrid search with tag filtering, advanced filters (content type, date range, importance), bulk select/delete, inline new memory creation, keyboard shortcuts (`/` to focus, arrow keys to paginate, `Escape` to cancel select)
- **Timeline** (`/timeline`) — chronological memory view with keyboard shortcuts
- **Entities** (`/entities`) — entity list by type with bulk select/delete
- **Entity Detail** (`/entities/:id`) — entity info, relationship list + radial SVG graph, linked memories
- **Graph** (`/graph`) — interactive force-directed knowledge graph (canvas-based). Drag nodes, scroll to zoom, click to navigate. Simulation auto-pauses when settled
- **Memory Detail** (`/memory/:id`) — full memory view with inline edit mode (content, tags, importance), supersession diff view, soft-delete to trash
- **Trash** (`/trash`) — archived/superseded memories with restore and permanent delete
- **Chat** (`/chat`) — RAG-powered Q&A with multi-turn conversation history, sources linked to memory detail. Requires AI API key (configured in Settings under `ai.api_key`)
- **Settings** (`/settings`) — system configuration, export, and bulk import. API keys are masked in responses

## Architecture Notes

- Entity extraction is regex-based (no ML) — see `packages/core/src/entities/extractor.ts`. Optional LLM-based extractor available at `packages/core/src/entities/llm-extractor.ts` (not integrated by default)
- Entity relationships exposed via `GET /api/entities/:id/relationships` using `EntityStore.getRelatedEntities()`. Relationships include optional `context` phrases (e.g. "uses → for real-time event streaming") extracted from memory content
- Full entity graph (all entities + relationships) available via `GET /api/entities/graph` — single SQL query, no N+1
- Community detection via label propagation algorithm — `detectCommunities()` in `packages/core/src/entities/graph.ts`. O(V+E) per iteration, converges in ~10 iterations. Exposed via `memory_graph` action `"communities"`
- Search friction tracking — zero-result queries logged to `search_misses` table. `getSearchMisses()` aggregates by query. Surfaced in `memory_maintenance` output as "Search Friction Signals"
- MCP server exposes tools: memory_store, memory_search, memory_forget, memory_context, memory_entities, memory_get, memory_update, memory_browse, memory_ping, memory_decay_preview, memory_maintenance, memory_ingest, memory_digest_session, memory_consolidate, memory_graph, memory_link, memory_timeline, memory_feedback, goal_create, goal_list, goal_update, goal_log, goal_get, goal_add_milestone, goal_update_milestone, goal_remove_milestone
- `memory_digest_session` parses a session transcript JSONL, extracts write/edit/bash actions, and stores a structured session summary as a memory with tag `session-digest`
- Goals support milestones — stored in `metadata.milestones` JSON array (no dedicated table). Milestone CRUD via `GoalStore.addMilestone/updateMilestone/removeMilestone/getMilestones`. `GoalWithProgress` includes `milestones: Milestone[]`
- Goal autonomy: metadata keys `mode` ("monitor"|"autonomous"), `approved_tools` (string[]), `max_actions_per_cycle` (number), `strategy` (string). Autonomous goals can be worked by external agent systems via MCP tools
- Goals REST endpoint: `GET /api/goals?status=active` — used by external systems for pre-flight checks
- Retrieval feedback loop: memories track `useful_count` — incremented when a memory retrieved by search is later accessed via `memory_get` within 5 minutes (implicit signal), or explicitly via `memory_feedback` tool. Usefulness factors into hybrid scoring with configurable weight (`scoring.usefulness_weight`, default 0.05). Scoring function: `min(1.0, log(1 + count) / log(6))` — saturates at 5 signals
- Store-time relation discovery: when `memory_store` creates a memory, scans 200 recent memories by embedding cosine similarity and auto-links those with similarity >= 0.75 (max 5 links, type "related", strength = similarity score)
- Temporal evolution query: `memory_timeline` supports `mode: "evolution"` with required `topic` parameter — searches memories matching the topic, sorts chronologically, enriches with supersession chains and cross-reference links to show how knowledge evolved over time
- Graph-aware retrieval: memory-link proximity boosts search results linked to top candidates (1-hop via MemoryLinkStore). Default graph weight: 0.10. Entity-graph proximity also factors in when entities are found in query
- Multi-hop context loading: `memory_search` and `memory_context` append up to 3 linked memories (1-hop) after main results in a "Linked" section. Linked memories also get implicit usefulness tracking
- Adaptive scoring weights: `tuneWeights()` in maintenance.ts analyzes useful vs not-useful memories, nudges weights (±0.02/cycle, bounds [0.02, 0.40]) based on property correlations (recency, frequency, graph links, usefulness). Exposed via `memory_maintenance` with `tune_weights: true`
- `memory_maintenance` optional flags: `reembed` (fill missing embeddings), `backfill_entities` (extract entities + relationships for unprocessed memories), `recalibrate` (normalize importance distribution), `densify_graph` (create co_occurs relationships between entities sharing memories), `build_co_retrieval_links` (build memory links from co-retrieval patterns), `tune_weights` (adaptive scoring weight adjustment). Always runs: importance adjustment, archival, health checks, search friction, dangling entity detection
- Open threads: session-orient hook surfaces recent memories tagged plan/todo/next-steps/in-progress (14 days, not superseded) as "Open threads" section
- Memories are stored with ULID IDs, importance scores, tags, and content types
- `memory_ingest` splits markdown files by `##` headers, deduplicates by `source_uri`, supports glob patterns
- Fact-type tags (`decision`, `discovery`, `architecture`, `learning`) render with distinct colors in memory cards
- Intelligence endpoints: `POST /api/consolidate`, `POST /api/archive`, `POST /api/importance-adjust`, `POST /api/contradictions/detect`, `GET /api/contradictions`, `PATCH /api/contradictions/:id` — all support `dry_run` for preview
- Consolidation always uses basic (non-LLM) summary generation. LLM-powered synthesis can be handled externally by agent systems, avoiding direct API costs in Exocortex
- Trash/archive: `GET /api/memories/archived`, `POST /api/memories/:id/restore`. Deleting from Memory Detail soft-deletes (sets `is_active = 0`); permanent delete available from Trash page
- Chat: `POST /api/chat` — RAG endpoint that searches memories for context, sends to LLM with conversation history. Requires `ai.api_key` and optionally `ai.provider` (`anthropic` or `openai`) and `ai.model` in settings
- Settings security: `GET /api/settings` masks API keys in responses; `PATCH /api/settings` skips masked values to prevent overwriting real secrets
- Shared utilities: `packages/server/src/utils.ts` (stripEmbedding), `packages/dashboard/src/utils/format.ts` (parseUTC, timeAgo)
- Dashboard is mobile-responsive (hamburger sidebar at <=768px) with a toast notification system replacing native `alert()`/`confirm()`
- Auto-start: Can be configured via OS-specific mechanisms (systemd, launchd, Windows Task Scheduler, PM2) to start the HTTP server at logon. Log output: `~/.exocortex/server.log`
- Automatic maintenance: importance adjustment + archival run on server startup (5s delay), after every 50 memory stores, and via nightly cron jobs. Database backup runs nightly (SQLite `VACUUM INTO`, rotates to `~/.exocortex/backups/`, keeps last `backup.max_count` copies, default 7). Consolidation, contradiction detection, entity extraction, and trash auto-purge also run nightly. Trash auto-purge permanently deletes memories in trash for more than `trash.auto_purge_days` (default 30). Set to `"0"` to disable. Superseded memories are preserved while their superseding target is still active.
- Session orient hook (`packages/mcp/src/hooks/session-orient.js`) — fires on SessionStart, queries SQLite directly (no HTTP dependency) for: (1) recent project memories (7 days, tag-filtered by CWD project name), (2) active goals with milestone progress, (3) recent decisions (30 days), (4) learned techniques (by importance), (5) open threads (plan/todo/in-progress memories from 14 days, not superseded). Outputs compact context via `additionalContext`. Registered in `~/.claude/settings.json` with 3s timeout.
- Stop hook (`packages/mcp/src/hooks/stop.js`) is available but not enabled by default. Can be added to `~/.claude/settings.json` hooks if session summary reminders are desired.
