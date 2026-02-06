# Exocortex

Personal unified memory system — SQLite-backed, local-first, hybrid RAG retrieval with MCP integration.

Exocortex gives AI coding agents persistent memory across sessions. It stores memories with embeddings, scores them using Reciprocal Rank Fusion, and exposes everything through an MCP server, REST API, CLI, and React dashboard. Works with any MCP-compatible tool — Claude Code, Codex, Gemini, Copilot, and others. All data stays local — no cloud, no API keys for embeddings.

---

## Quick Start

```bash
pnpm install
pnpm build

# Start server + dashboard
npx tsx packages/cli/src/index.ts serve --port 3210

# Or use the CLI directly
npx tsx packages/cli/src/index.ts add "Remember this" --tags "test,demo" --importance 0.8
npx tsx packages/cli/src/index.ts search "remember" --verbose
```

### Connect an AI agent

The MCP server works with any tool that supports the [Model Context Protocol](https://modelcontextprotocol.io):

**Claude Code:**
```bash
claude mcp add --scope user exocortex node /path/to/exocortex/packages/mcp/dist/index.js
```

**Codex CLI** (`~/.codex/config.json`):
```json
{ "mcpServers": { "exocortex": { "command": "node", "args": ["/path/to/exocortex/packages/mcp/dist/index.js"] } } }
```

**Gemini CLI** (`~/.gemini/settings.json`):
```json
{ "mcpServers": { "exocortex": { "command": "node", "args": ["/path/to/exocortex/packages/mcp/dist/index.js"] } } }
```

**VS Code (Copilot / Cline / etc.)** (`.vscode/mcp.json`):
```json
{ "servers": { "exocortex": { "command": "node", "args": ["/path/to/exocortex/packages/mcp/dist/index.js"] } } }
```

---

## How It Works

```
User prompt → Agent reads/writes memories via MCP tools
                ↓
            MCP Server (stdio)
                ↓
          MemoryStore / MemorySearch (core)
                ↓
    ┌───────────┼───────────┐
    │           │           │
 SQLite     FTS5 Index   Vector Store
 (memories)  (full-text)  (384-dim embeddings)
                ↓
    Reciprocal Rank Fusion scoring
    + recency/frequency boost
                ↓
         Ranked results returned
```

**Key design choices:**
- **No external services** — embeddings run locally via HuggingFace transformers
- **Hybrid retrieval** — vector similarity + BM25 full-text search, fused with RRF
- **Automatic enrichment** — entity extraction, auto-tagging, and deduplication happen on every write
- **Importance decay** — unused memories lose importance over time, frequently accessed ones gain it

---

## Packages

| Package | Description |
|---------|-------------|
| `@exocortex/core` | Storage, retrieval, embedding, scoring, entity extraction, intelligence, ingestion |
| `@exocortex/mcp` | MCP server — exposes all memory tools via stdio (works with any MCP client) |
| `@exocortex/server` | Hono REST API on port 3210 + serves the React dashboard |
| `@exocortex/cli` | CLI tool (`exo`) — add, search, import, export, serve, consolidate |
| `@exocortex/dashboard` | React SPA with Neural Interface theme — search, chat, graph, timeline, trash, mobile-responsive |

---

## MCP Server

The MCP server exposes all memory tools over stdio. See [Quick Start](#connect-an-ai-agent) for setup with your preferred tool.

### Tools

| Tool | Description |
|------|-------------|
| `memory_store` | Store a new memory with tags, importance, and content type |
| `memory_search` | Hybrid search with RRF scoring, token budgets, and compact mode |
| `memory_get` | Fetch full content for specific memory IDs (use after compact search) |
| `memory_update` | Update content, tags, importance, or content type of an existing memory |
| `memory_forget` | Delete a memory by ID |
| `memory_context` | Load contextual memories for a topic (use at session start) |
| `memory_browse` | Browse memories by tags, type, or date range without semantic search |
| `memory_entities` | List tracked entities — people, projects, technologies, organizations, concepts |
| `memory_ingest` | Index markdown files — splits by `##` headers, deduplicates by `source_uri`, supports globs |
| `memory_digest_session` | Digest a coding session transcript into a structured session summary |
| `memory_maintenance` | Adjust importance scores based on access patterns and archive stale memories |
| `memory_decay_preview` | Dry-run preview of what maintenance would archive |
| `memory_ping` | Health check — memory counts, entity/tag stats, date range, uptime |

### Search workflow

Token-efficient layered retrieval:

```
1. memory_search(query, compact=true)     → IDs + previews + scores (~50 tokens/result)
2. Review results, pick relevant IDs
3. memory_get(ids=[...])                  → Full content for selected memories
```

Or use `max_tokens` to let the server pack results into a token budget:

```
memory_search(query, max_tokens=2000)     → As many full results as fit in 2000 tokens
```

### Session digestion

The `memory_digest_session` tool reads a session transcript JSONL file, extracts meaningful actions (edits, writes, bash commands, web fetches), and stores a structured summary:

```
Session 2026-02-01 (project: exocortex)
- Edit packages/core/src/memory/digest.ts
- Bash: pnpm test
- Bash: git commit -m "Add session digestion"
- Edit README.md

Files changed: 2 | Commands: 2 | Tools used: 2
```

Read-only tools (Read, Glob, Grep) and Exocortex's own MCP calls are filtered out. Consecutive edits to the same file are deduplicated. The project is auto-detected from file paths.

### Stop hook (Claude Code only, optional)

An optional stop hook can remind the agent to store a session summary before exiting substantial sessions. Not enabled by default. To enable, add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [{ "type": "command", "command": "node /path/to/exocortex/packages/mcp/src/hooks/stop.js" }]
  }
}
```

---

## CLI

```bash
exo <command> [options]
```

| Command | Description |
|---------|-------------|
| `add <content>` | Add a new memory. Options: `-t/--tags`, `-i/--importance`, `--type`, `--source` |
| `search <query>` | Hybrid retrieval search. Options: `-l/--limit`, `--after`, `--before`, `-t/--tags`, `--type`, `-v/--verbose` |
| `import <file>` | Import from file. Options: `-f/--format` (json\|markdown\|chatexport), `--dry-run`, `-d/--decrypt` |
| `stats` | Show memory statistics — counts, breakdowns by type/source, date range |
| `serve` | Start HTTP server + dashboard. Options: `-p/--port` (default 3210) |
| `mcp` | Start MCP server on stdio |
| `consolidate` | Find and merge similar memories. Options: `--dry-run`, `--similarity`, `--min-size`, `--history` |
| `entities` | List and manage entities. Options: `--type`, `--search`, `--memories` |
| `contradictions` | View and manage contradictions. Options: `--status`, `--detect`, `--resolve <id>`, `--dismiss <id>` |
| `export` | Export all data as JSON backup |

---

## REST API

### Health

```
GET  /health                    — DB connection status
```

### Memories

```
POST   /api/memories            — Create memory
GET    /api/memories/:id        — Get by ID
PATCH  /api/memories/:id        — Update (content, tags, importance, is_active)
DELETE /api/memories/:id        — Permanent delete
POST   /api/memories/search     — Hybrid search
GET    /api/memories/recent     — Recent memories
POST   /api/memories/import     — Bulk import
GET    /api/memories/archived   — List archived/trashed memories
POST   /api/memories/:id/restore — Restore an archived memory
```

### Entities

```
GET    /api/entities            — List entities (filter by type, search by name)
POST   /api/entities            — Create entity
GET    /api/entities/:id        — Get by ID
PATCH  /api/entities/:id        — Update
DELETE /api/entities/:id        — Delete
GET    /api/entities/:id/memories       — Linked memories
GET    /api/entities/:id/relationships  — Entity relationships
GET    /api/entities/graph             — All entities + relationships (single query)
```

### Chat

```
POST   /api/chat               — RAG chat (requires ai.api_key in settings)
```

Send `{ message, history?, conversation_id? }`. The server searches memories for context, sends prior conversation history + retrieved context to the configured LLM, and returns `{ response, sources, conversation_id }`. Supports Anthropic (default) and OpenAI providers via `ai.provider` setting.

### Intelligence

```
POST   /api/consolidate         — Find and consolidate memory clusters
GET    /api/consolidations      — Consolidation history
POST   /api/contradictions/detect — Scan for contradictions
GET    /api/contradictions      — List contradictions
PATCH  /api/contradictions/:id  — Update contradiction (resolve/dismiss)
POST   /api/archive             — Archive stale memories
POST   /api/importance-adjust   — Adjust importance from access patterns
GET    /api/timeline            — Memory timeline with filters
GET    /api/temporal-stats      — Temporal analysis (streaks, averages)
```

### Data

```
GET    /api/export              — Export all data as JSON
GET    /api/stats               — Memory statistics
GET    /api/settings            — Get all settings (API keys masked)
PATCH  /api/settings            — Update settings (masked values skipped)
```

---

## Scoring

### RRF mode (default)

Reciprocal Rank Fusion fuses two independent ranked lists — vector similarity and FTS5 BM25 — into a single ranking:

```
RRF_score(d) = 1/(k + rank_vector(d)) + 1/(k + rank_fts(d))
```

Where `k = 60` (configurable via `scoring.rrf_k`). Recency and frequency are applied as a multiplicative boost on top. Score range: ~0.001–0.03.

### Legacy mode

Activate with `scoring.use_rrf = false`. Uses a weighted average:

```
score = 0.45 * vector + 0.25 * fts + 0.20 * recency + 0.10 * frequency
```

All weights are configurable via the `settings` table. Score range: ~0.15–0.80.

---

## Intelligence Features

### Consolidation

Greedy agglomerative clustering of semantically similar memories (threshold: 0.75). Clusters of 3+ memories are merged into a summary that extracts key facts — dates, metrics, decisions, architecture notes. Source memories are archived and linked to the summary via `parent_id`.

### Contradiction detection

Finds memory pairs with high semantic similarity (>0.7) that contain conflicting statements — negations, value changes, or reversed positions. Detected contradictions can be resolved or dismissed.

### Automatic maintenance

Importance adjustment and memory archival run automatically — no manual intervention needed:

- **On server startup** (5-second delay)
- **After every 50 memory stores**
- **Nightly cron jobs** (importance at 3:30 AM, archival at 4:00 AM)

**Importance adjustment** tunes scores based on access patterns:
- **Boost**: Memories accessed 5+ times get importance increased (up to 0.9)
- **Decay**: Never-accessed memories older than 30 days get importance decreased (down to 0.1)
- **Pinned**: Memories with importance 1.0 are never adjusted

**Memory archival** soft-deletes stale memories (`is_active = 0`):
- Low importance (<0.3) + old (>90 days) + rarely accessed (<2 times)
- Never accessed + very old (>365 days)

Consolidation and contradiction detection run nightly only (2:00 AM / 2:30 AM) since they may need human review. Entity extraction for unprocessed memories runs nightly at 3:00 AM.

### Temporal analysis

Timeline view of memories grouped by date, with statistics: total active days, average memories per day, most active day, current and longest streaks.

---

## Automatic Enrichment

Every memory stored goes through three enrichment steps (all non-blocking — failures don't prevent storage):

### Entity extraction

Regex-based NER extracts five entity types from memory content (an optional LLM-based extractor is also available at `packages/core/src/entities/llm-extractor.ts`):

| Type | Examples | Confidence |
|------|----------|------------|
| Technology | React, TypeScript, PostgreSQL, Docker, AWS | 0.9 |
| Organization | Google, Anthropic, OpenAI + suffix patterns (Inc, LLC, Labs) | 0.85 |
| Person | Capitalized name pairs, attribution patterns ("by X", "X said") | 0.6–0.75 |
| Project | "working on X", "building X", kebab-case package names | 0.5–0.65 |
| Concept | "machine learning", "RAG", quoted terms | 0.4–0.8 |

Entities are linked to memories with relevance scores and can be queried independently.

### Auto-tagging

Up to 5 tags generated per memory by matching against:
1. **Tech keywords** — languages, frameworks, databases, tools, platforms
2. **Topic patterns** — decision, bug, architecture, lesson, config, performance, deployment, testing, refactor, security
3. **Project names** — kebab-case identifiers (filtered against a blocklist of common compounds)

### Deduplication

New memories are compared against the 50 most recent active memories of the same content type. If cosine similarity exceeds 0.85 (configurable) and tags overlap, the old memory is superseded — marked inactive with `superseded_by` pointing to the new one.

---

## Database Schema

8 tables + 1 virtual FTS5 table:

| Table | Purpose |
|-------|---------|
| `memories` | Core records — content, embeddings, importance, access tracking, parent/child links |
| `memory_tags` | Many-to-many tag associations |
| `memory_entities` | Junction table linking memories to entities with relevance scores |
| `entities` | Named entities — people, projects, technologies, organizations, concepts |
| `access_log` | Query access history for importance adjustment |
| `consolidations` | Consolidation history — which memories were merged and how |
| `contradictions` | Detected contradictions with status tracking (pending/resolved/dismissed) |
| `settings` | Key-value configuration store |
| `memories_fts` | FTS5 virtual table with auto-sync triggers on insert/update/delete |

---

## Configuration

All settings are stored in the `settings` table and can be changed via the REST API (`PATCH /api/settings`) or the dashboard.

### Scoring

| Key | Default | Description |
|-----|---------|-------------|
| `scoring.use_rrf` | `true` | Use Reciprocal Rank Fusion (false = legacy weighted average) |
| `scoring.rrf_k` | `60` | RRF smoothing constant |
| `scoring.rrf_min_score` | `0.001` | Minimum score threshold in RRF mode |
| `scoring.vector_weight` | `0.45` | Vector similarity weight (legacy mode) |
| `scoring.fts_weight` | `0.25` | Full-text search weight (legacy mode) |
| `scoring.recency_weight` | `0.20` | Recency weight (legacy mode) |
| `scoring.frequency_weight` | `0.10` | Frequency weight (legacy mode) |
| `scoring.recency_decay` | `0.05` | Recency decay rate |
| `scoring.min_score` | `0.15` | Minimum score threshold (legacy mode) |
| `scoring.tag_boost` | `0.10` | Score boost for tag matches |

### Embedding

| Key | Default | Description |
|-----|---------|-------------|
| `embedding.model` | `Xenova/all-MiniLM-L6-v2` | HuggingFace model identifier |
| `embedding.dimensions` | `384` | Embedding vector dimensions |

### Importance

| Key | Default | Description |
|-----|---------|-------------|
| `importance.auto_adjust` | `true` | Enable automatic importance adjustment |
| `importance.boost_threshold` | `5` | Access count to trigger importance boost |
| `importance.decay_age_days` | `30` | Days before unused memories start decaying |

### Deduplication

| Key | Default | Description |
|-----|---------|-------------|
| `dedup.enabled` | `true` | Enable semantic deduplication |
| `dedup.similarity_threshold` | `0.85` | Cosine similarity threshold for dedup |

### Chunking

| Key | Default | Description |
|-----|---------|-------------|
| `chunking.enabled` | `true` | Split long memories into chunks |
| `chunking.max_length` | `1500` | Character length before chunking triggers |
| `chunking.target_size` | `500` | Target chunk size in characters |

### AI / Chat

| Key | Default | Description |
|-----|---------|-------------|
| `ai.api_key` | — | API key for chat (Anthropic or OpenAI). Masked in GET responses |
| `ai.provider` | `anthropic` | LLM provider (`anthropic` or `openai`) |
| `ai.model` | `claude-sonnet-4-5-20250929` / `gpt-4o-mini` | Model to use for chat |

### Other

| Key | Default | Description |
|-----|---------|-------------|
| `server.port` | `3210` | REST API / dashboard port |
| `auto_tagging.enabled` | `true` | Auto-generate tags on memory creation |

---

## Data Directory

All data is stored in `~/.exocortex/`:

```
~/.exocortex/
  exocortex.db     # SQLite database (memories, entities, settings)
  models/          # Cached embedding model (all-MiniLM-L6-v2, ~80MB)
```

Override the model cache location with `EXOCORTEX_MODEL_DIR` environment variable.

---

## System Requirements

- **Node.js** >= 20 (uses built-in `node:sqlite`)
- **pnpm** (workspace package manager)
- No external database — SQLite is built into Node
- No API keys — embeddings run locally

---

## Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js >= 20 (built-in `node:sqlite`) |
| Language | TypeScript |
| Package manager | pnpm (workspaces) |
| Server | Hono |
| Dashboard | React 19 + Vite 7 + TanStack Query |
| Validation | Zod 4 |
| Testing | Vitest 4 |
| Embeddings | @huggingface/transformers (all-MiniLM-L6-v2, 384 dims) |
| MCP | @modelcontextprotocol/sdk |
| IDs | ULID |

---

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run all tests
pnpm test    # 178 tests across 14 files

# Type-check
pnpm lint

# Dev server with watch mode
pnpm dev
```

---

## License

MIT
