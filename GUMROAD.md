# Gumroad Product Listing

## Product Name
Exocortex — Persistent Memory for AI Agents

## Price
$39

## Thumbnail Text
"Your AI forgets everything. Fix that."

## Short Description (for Gumroad card)
Local-first memory system for AI agents. 40+ MCP tools, semantic search, knowledge graph, and a web dashboard. Works with Claude Code, Codex, Gemini, Copilot, and any MCP client.

## Full Description

### Your AI starts every session from scratch. Exocortex gives it a brain.

Every time you start a new conversation, your AI has no idea what you discussed yesterday. Your architecture decisions, debugging breakthroughs, project context — gone.

Exocortex is a persistent memory server that plugs into any MCP-compatible AI tool. Store memories, search them with hybrid semantic + keyword retrieval, and let your AI build a knowledge graph of your projects, people, and decisions — automatically.

**This is not a prompt template or a MEMORY.md file.** It's a full system with a database, embeddings engine, web dashboard, and 40+ tools your AI can use autonomously.

---

### What You Get

**MCP Memory Server** — 40+ tools your AI uses directly:
- `memory_store` / `memory_search` / `memory_context` — persistent storage with hybrid retrieval
- `memory_entities` / `memory_graph` — auto-extracted knowledge graph
- `goal_create` / `goal_update` / `goal_log` — persistent objective tracking
- `prediction_create` / `prediction_resolve` — forecasting with calibration stats
- `memory_consolidate` / `memory_contradictions` — self-maintaining intelligence

**Web Dashboard** (http://localhost:3210):
- Search and browse all memories
- Interactive force-directed knowledge graph
- Entity browser with relationship mapping
- Timeline view with temporal hierarchy
- Analytics — memory stats, quality distribution, retrieval health
- Goal tracker with milestones
- RAG chat interface
- Settings UI for all configuration

**Hybrid Retrieval Engine:**
- Vector embeddings (local, no API key) + full-text search
- Reciprocal Rank Fusion scoring
- Entity graph proximity boosting
- Recency, frequency, usefulness, and importance weighting
- Adaptive scoring — weights auto-tune based on what you actually use

**Self-Maintaining Intelligence:**
- Automatic consolidation merges duplicate memories
- Importance decay archives stale knowledge
- Contradiction detection flags conflicting information
- Entity extraction builds your knowledge graph over time
- Nightly maintenance keeps everything clean

---

### Benchmarked: +109% Better Answers

We tested 15 questions across 5 categories with and without memory context:

| Category | Improvement |
|----------|------------|
| Decision continuity | **+187%** |
| Context awareness | **+147%** |
| Factual recall | **+122%** |
| Cross-reference | **+67%** |
| Technique application | **+50%** |

Without memory, your AI says "I don't have that information." With Exocortex, it gives precise answers with specific details.

---

### Setup in 5 Minutes

```
1. Unzip
2. pnpm install --prod
3. node packages/server/dist/index.js
4. claude mcp add --scope user exocortex node packages/mcp/dist/index.js
```

Works with **Claude Code**, **Codex CLI**, **Gemini CLI**, **GitHub Copilot**, and any MCP-compatible client.

---

### 100% Local

- SQLite database on your machine
- Embeddings run locally (no OpenAI/Anthropic API needed)
- Binds to localhost by default
- Your data never leaves your computer
- MIT licensed — modify, extend, build on it

---

### Requirements

- Node.js 20+
- pnpm
- Any MCP-compatible AI tool

---

### What's Inside the Download

- Pre-built server, MCP server, CLI, and dashboard
- Full TypeScript source code
- QUICKSTART.md — get running in minutes
- Architecture documentation with system diagrams
- 533 passing tests
- MIT license — use it however you want

---

### Why Not Just Use MEMORY.md?

| | MEMORY.md | Exocortex |
|---|---|---|
| Storage | Single flat file | SQLite with full-text index |
| Search | Ctrl+F | Hybrid semantic + keyword + graph |
| Capacity | ~200 lines before truncation | Unlimited |
| Structure | Manual | Auto-extracted entities & relationships |
| Maintenance | You manage it | Self-consolidating, self-archiving |
| Retrieval | Load everything or nothing | Ranked results by relevance |
| Dashboard | None | Full web UI with graph visualization |
| Goals | None | Milestone tracking with progress logs |

---

## Tags
mcp, ai-memory, developer-tools, claude, ai-agents, knowledge-graph, sqlite, local-first, semantic-search

## Content Rating
Everyone

## Category
Software Development
