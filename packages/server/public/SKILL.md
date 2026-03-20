# exocortex

> Persistent long-term memory for AI agents. Store, search, and reason over knowledge that persists across sessions. Semantic search, knowledge graphs, temporal reasoning, and self-improving retrieval.

## Tools

### Core
- `memory_store` — Store knowledge with content, tags, importance (0-1), tier, namespace
- `memory_search` — Hybrid search (vector + FTS + graph). Use expanded_query for better recall, compact for token efficiency
- `memory_get` — Fetch full memory content by ID
- `memory_context` — Load broad context for a topic. Use deep=true for LLM-driven iterative retrieval
- `memory_update` — Update memory content, tags, importance, or metadata
- `memory_forget` — Soft-delete a memory

### Intelligence
- `memory_project_snapshot` — Project context: goals, decisions, threads, techniques
- `memory_contradictions` — Find contradictory facts in stored knowledge
- `memory_timeline` — Track topic evolution over time
- `memory_diff` — Compare memory state between time periods

### Knowledge Graph
- `memory_entities` — Browse extracted entities (people, projects, tech)
- `memory_graph` — Entity relationship graph with centrality scores
- `memory_link` — Create explicit connections between memories

### Ingestion
- `memory_ingest` — Ingest documents/URLs with automatic chunking
- `memory_research` — Web research with automatic knowledge storage

### Goals & Predictions
- `goal` — Track goals with milestones and progress
- `prediction` — Make and resolve predictions for calibration

## Usage Pattern

Session start:
1. `memory_context` with topic → load relevant background
2. `memory_project_snapshot` → goals, decisions, open threads

During work:
3. `memory_search` for specific knowledge retrieval
4. `memory_store` to persist decisions, discoveries, techniques

Session end:
5. Store session summary and key learnings

## Authentication
Set `auth.token` in DB settings. Pass via `Authorization: Bearer <token>` or `X-Exocortex-Token`.

## Links
- REST: http://localhost:4010
- MCP: stdio transport
- Dashboard: http://localhost:4010 (web UI)
