# Exocortex Architecture

## System Overview

```
┌─────────────────────────────────────────────────────┐
│                    MCP / REST API                    │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌────────────┐  │
│  │   Memory     │  │  Entities   │  │   Goals    │  │
│  │  store       │  │  extractor  │  │  predict   │  │
│  │  search      │  │  graph      │  │  track     │  │
│  │  ingest      │  │  profiles   │  │            │  │
│  └──────┬───────┘  └──────┬──────┘  └─────┬──────┘  │
│         │                 │               │         │
│  ┌──────▼─────────────────▼───────────────▼──────┐  │
│  │            Intelligence Layer                  │  │
│  │  consolidation · contradictions · decay        │  │
│  │  importance · maintenance · scoring            │  │
│  │  graph-densify · co-retrieval · synthesis      │  │
│  └──────────────────────┬────────────────────────┘  │
│                         │                           │
│  ┌──────────────────────▼────────────────────────┐  │
│  │              Foundation                        │  │
│  │  SQLite + FTS5  ·  ONNX embeddings (384-dim)  │  │
│  └───────────────────────────────────────────────┘  │
│                                                     │
└─────────────────────────────────────────────────────┘
```

## Key Flows

### 1. Memory Storage

What happens when you call `memory_store`:

```mermaid
sequenceDiagram
    participant Client as MCP Client
    participant Store as MemoryStore
    participant Embed as EmbeddingManager
    participant Entity as EntityExtractor
    participant FTS as SQLite FTS5
    participant Linker as MemoryLinkStore

    Client->>Store: create({ content, tags, importance })
    Store->>Store: validate, strip PII, normalize tags, auto-tag, classify

    alt Content > chunking threshold
        Store->>Store: chunk into parent + children
    end

    Store->>Embed: embed(content)
    Embed-->>Store: Float32Array (384-dim)

    Store->>Store: INSERT memory + keywords + facts
    Store->>FTS: auto-indexed via trigger

    Store->>Entity: extractEntities(content)
    Store->>Store: link memory ↔ entities

    Store->>Linker: findSimilar(embedding, cosine ≥ 0.75)
    Linker-->>Store: auto-linked related memories

    Store-->>Client: Memory { id, content, ... }
```

### 2. Memory Search (RAG Retrieval)

What happens when you call `memory_search`:

```mermaid
sequenceDiagram
    participant Client as MCP Client
    participant Search as MemorySearch
    participant Embed as EmbeddingManager
    participant FTS as SQLite FTS5
    participant Graph as MemoryLinks

    Client->>Search: search({ query, limit, tags })

    par Parallel retrieval
        Search->>Embed: embed(query)
        Search->>Search: vector similarity scan (top 200)
    and
        Search->>FTS: BM25 full-text search (top 200)
    and
        Search->>Search: expand query via entity/tag aliases
    end

    Search->>Search: merge candidates (union)
    Search->>Search: compute signals (recency, frequency, usefulness, valence, quality, goal relevance)
    Search->>Graph: graph proximity boosts

    Search->>Search: Reciprocal Rank Fusion (vector + FTS + graph)
    Search->>Search: post-RRF boosts, supersession demotion, tag boost
    Search->>Search: quality floor + score gap filter

    Search-->>Client: SearchResult[] { memory, score, signals }
```

### 3. Intelligence Pipeline (Overnight)

What the sentinel jobs do while you sleep:

```
┌─────────────────────────────────────────────────────────┐
│                  Sentinel Scheduler                      │
└────────┬──────────┬──────────────┬──────────────────────┘
         │          │              │
    ┌────▼────┐ ┌───▼──────┐ ┌────▼─────────┐
    │ Memory  │ │ Entities │ │   Quality    │
    ├─────────┤ ├──────────┤ ├──────────────┤
    │boost/   │ │backfill  │ │8 health      │
    │ decay   │ │ entities │ │ checks       │
    │consoli- │ │densify   │ │retrieval     │
    │ date    │ │ graph    │ │ regression   │
    │contra-  │ │recompute │ │adaptive      │
    │ dictions│ │ profiles │ │ weight tuning│
    └─────────┘ │prune     │ └──────────────┘
                │ orphans  │
                └──────────┘
         │          │              │
    ┌────▼──────────▼──────────────▼──────────┐
    │           Self-Improvement               │
    │  gardening · insights · weekly scorecard │
    └──────────────────────────────────────────┘
```

### 4. Scoring Pipeline Detail

How a single memory gets scored during search:

```
  Raw Signals (0–1 each)          RRF Fusion              Post-RRF              Output
 ─────────────────────     ─────────────────────    ──────────────────    ─────────────
  vector similarity ────► vector rank  (w: 0.45) ─┐
                                                   ├─► 1/(k+rank+1) ─► × signal boosts
  FTS BM25 rank ────────► FTS rank     (w: 0.25) ─┤   sum across      (recency, freq,
                                                   │   ranked lists     usefulness,
  graph proximity ──────► graph rank   (w: 0.10) ─┘                    valence, quality,
                                                                        goal relevance)
  recency ──────────────────────────────────────────────────────┐
  frequency ────────────────────────────────────────────────────┤
  usefulness ───────────────────────────────────────────────────┼──► × supersede (0.2)
  valence ──────────────────────────────────────────────────────┤    + tag boost
  quality ──────────────────────────────────────────────────────┤    × metadata penalty
  goal relevance ───────────────────────────────────────────────┘
                                                                    ──► quality floor ≥ 0.08
                                                                    ──► score gap ≥ 15%
                                                                    ──► offset + limit
```
