# Exocortex

Personal unified memory system — SQLite-backed, local-first, hybrid RAG retrieval.

## Stack

- Monorepo: pnpm workspaces
- Packages: `core`, `cli`, `server`, `mcp`, `dashboard`
- DB: Node built-in SQLite (`node:sqlite`)
- Embeddings: HuggingFace `all-MiniLM-L6-v2` (local, no API key)
- Scoring: Reciprocal Rank Fusion (RRF) by default, fusing vector + FTS ranked lists with recency/frequency boost. Legacy weighted-average mode available via `scoring.use_rrf=false`.
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

**Codex CLI** (`~/.codex/config.json`) / **Gemini CLI** (`~/.gemini/settings.json`):
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
- Entity relationships exposed via `GET /api/entities/:id/relationships` using `EntityStore.getRelatedEntities()`
- Full entity graph (all entities + relationships) available via `GET /api/entities/graph` — single SQL query, no N+1
- MCP server exposes tools: memory_store, memory_search, memory_forget, memory_context, memory_entities, memory_get, memory_update, memory_browse, memory_ping, memory_decay_preview, memory_maintenance, memory_ingest, memory_digest_session, memory_consolidate
- `memory_digest_session` parses a session transcript JSONL, extracts write/edit/bash actions, and stores a structured session summary as a memory with tag `session-digest`
- Memories are stored with ULID IDs, importance scores, tags, and content types
- `memory_ingest` splits markdown files by `##` headers, deduplicates by `source_uri`, supports glob patterns
- Fact-type tags (`decision`, `discovery`, `architecture`, `learning`) render with distinct colors in memory cards
- Intelligence endpoints: `POST /api/consolidate`, `POST /api/archive`, `POST /api/importance-adjust`, `POST /api/contradictions/detect`, `GET /api/contradictions`, `PATCH /api/contradictions/:id` — all support `dry_run` for preview
- Trash/archive: `GET /api/memories/archived`, `POST /api/memories/:id/restore`. Deleting from Memory Detail soft-deletes (sets `is_active = 0`); permanent delete available from Trash page
- Chat: `POST /api/chat` — RAG endpoint that searches memories for context, sends to LLM with conversation history. Requires `ai.api_key` and optionally `ai.provider` (`anthropic` or `openai`) and `ai.model` in settings
- Settings security: `GET /api/settings` masks API keys in responses; `PATCH /api/settings` skips masked values to prevent overwriting real secrets
- Shared utilities: `packages/server/src/utils.ts` (stripEmbedding), `packages/dashboard/src/utils/format.ts` (parseUTC, timeAgo)
- Dashboard is mobile-responsive (hamburger sidebar at <=768px) with a toast notification system replacing native `alert()`/`confirm()`
- Auto-start: Windows scheduled task `ExocortexServer` starts the HTTP server at logon (30s delay, hidden window). Launcher files in `~/.exocortex/`: `start-server.vbs` → `start-server.ps1`. Log output: `~/.exocortex/server.log`
- Automatic maintenance: importance adjustment + archival run on server startup (5s delay), after every 50 memory stores, and via nightly cron jobs. Database backup runs nightly at 1:30 AM (SQLite `VACUUM INTO`, rotates to `~/.exocortex/backups/`, keeps last `backup.max_count` copies, default 7). Consolidation + contradiction detection run nightly only (2:00 AM / 2:30 AM). Entity extraction runs nightly at 3:00 AM. Trash auto-purge runs nightly at 4:30 AM — permanently deletes memories in trash for more than `trash.auto_purge_days` (default 30). Set to `"0"` to disable. Superseded memories are preserved while their superseding target is still active.
- Stop hook (`packages/mcp/src/hooks/stop.js`) is available but not enabled by default. Can be added to `~/.claude/settings.json` hooks if session summary reminders are desired.
