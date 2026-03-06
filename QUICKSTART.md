# Exocortex — Quick Start

Persistent memory for AI agents. Local-first, semantic search, knowledge graph.

## Requirements

- **Node.js 20+** (uses built-in SQLite)
- **pnpm** (`npm install -g pnpm`)

## Install

```bash
pnpm install --prod
```

First run downloads the embedding model (~80MB) to `~/.exocortex/models/`. This only happens once.

## Start the Server + Dashboard

```bash
node packages/server/dist/index.js
```

Open **http://localhost:3210** for the dashboard.

## Connect to Claude Code

```bash
claude mcp add --scope user exocortex node packages/mcp/dist/index.js
```

## Connect to Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.exocortex]
command = "node"
args = ["/path/to/exocortex/packages/mcp/dist/index.js"]
```

## Connect to Gemini CLI

Add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "exocortex": {
      "command": "node",
      "args": ["/path/to/exocortex/packages/mcp/dist/index.js"]
    }
  }
}
```

## What You Get

- **40+ MCP tools** — memory_store, memory_search, memory_context, goals, predictions, and more
- **Semantic search** — hybrid vector + full-text with reciprocal rank fusion
- **Knowledge graph** — auto-extracted entities and relationships
- **Dashboard** — search, browse, visualize your knowledge graph, analytics
- **Intelligence** — automatic consolidation, contradiction detection, importance decay
- **100% local** — no cloud APIs required, embeddings run on your machine

## Configuration

All settings available via the dashboard Settings page or `PATCH /api/settings`.

Key environment variables:
- `EXOCORTEX_DB_PATH` — database location (default: `~/.exocortex/exocortex.db`)
- `EXOCORTEX_MODEL_DIR` — embedding model cache (default: `~/.exocortex/models/`)
- `EXOCORTEX_HOST` — bind address (default: `127.0.0.1`)
- `PORT` — server port (default: `3210`)

### Embedding Model

Default: `Xenova/bge-small-en-v1.5` (384 dimensions, ~33MB download). To use a different model:

```bash
# Via dashboard Settings page, or:
curl -X PATCH http://localhost:3210/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"embedding.model": "Xenova/bge-base-en-v1.5"}'
```

Compatible models (any HuggingFace Transformers.js model):
- `Xenova/bge-small-en-v1.5` — 384d, fast, good quality (default)
- `Xenova/bge-base-en-v1.5` — 768d, better quality, slower
- `Xenova/all-MiniLM-L6-v2` — 384d, popular alternative

After changing models, re-embed existing memories via the CLI: `node packages/cli/dist/index.js maintenance --reembed-all`

## Documentation

- [README.md](README.md) — full documentation
- [ARCHITECTURE.md](ARCHITECTURE.md) — system architecture diagrams

## Support

Open an issue at the GitHub repository for bugs or feature requests.
