# Exocortex Architecture

## Module Dependency Graph

```mermaid
graph LR
  subgraph DB["Database Layer"]
    db_schema["db/schema"]
    db_connection["db/connection"]
  end

  subgraph Embedding["Embedding Layer"]
    embedding_manager["embedding/manager"]
    embedding_local["embedding/local"]
    embedding_manager --> embedding_local
  end

  subgraph Memory["Memory Core"]
    memory_store["memory/store"]
    memory_search["memory/search"]
    memory_scoring["memory/scoring"]
    memory_links["memory/links"]
    memory_facts["memory/facts"]
    memory_chunking["memory/chunking"]
    memory_ingest["memory/ingest"]
    memory_keywords["memory/keywords"]
    memory_auto_tags["memory/auto-tags"]
    memory_digest["memory/digest"]
    memory_tag_norm["memory/tag-normalization"]
    memory_metadata["memory/metadata-classification"]
    memory_content_hash["memory/content-hash"]
    memory_analytics["memory/analytics"]
  end

  subgraph Entities["Entity System"]
    entities_store["entities/store"]
    entities_extractor["entities/extractor"]
    entities_graph["entities/graph"]
    entities_profile["entities/profile"]
  end

  subgraph Intelligence["Intelligence Layer"]
    consolidation["intelligence/consolidation"]
    contradictions["intelligence/contradictions"]
    decay["intelligence/decay"]
    importance["intelligence/importance"]
    maintenance["intelligence/maintenance"]
    temporal["intelligence/temporal"]
    health["intelligence/health"]
    co_retrieval["intelligence/co-retrieval"]
    graph_densify["intelligence/graph-densify"]
    retrieval_reg["intelligence/retrieval-regression"]
    synthesis["intelligence/synthesis"]
    purge["intelligence/purge"]
  end

  subgraph Other["Supporting"]
    goals_store["goals/store"]
    predictions["predictions/store"]
    backup["backup"]
    obsidian["export/obsidian"]
    counters["observability/counters"]
  end

  %% Memory Core dependencies
  memory_store --> db_schema
  memory_store --> embedding_manager
  memory_store --> entities_extractor
  memory_store --> entities_store
  memory_store --> memory_scoring
  memory_store --> memory_links
  memory_store --> memory_chunking
  memory_store --> memory_facts
  memory_store --> memory_keywords
  memory_store --> memory_auto_tags
  memory_store --> memory_tag_norm
  memory_store --> memory_metadata
  memory_store --> memory_content_hash
  memory_store --> counters

  memory_search --> db_schema
  memory_search --> embedding_manager
  memory_search --> entities_store
  memory_search --> goals_store
  memory_search --> memory_links
  memory_search --> memory_scoring
  memory_search --> memory_tag_norm
  memory_search --> memory_metadata
  memory_search --> counters

  memory_scoring --> db_schema
  memory_ingest --> memory_store
  memory_ingest --> memory_tag_norm
  memory_analytics --> memory_scoring

  %% Intelligence dependencies
  consolidation --> entities_graph
  consolidation --> memory_scoring
  contradictions --> memory_scoring
  importance --> db_schema
  importance --> entities_graph
  importance --> memory_scoring
  maintenance --> db_schema
  maintenance --> entities_extractor
  maintenance --> entities_store
  maintenance --> memory_scoring
  maintenance --> memory_tag_norm
  maintenance --> counters
  health --> consolidation
  co_retrieval --> memory_links
  graph_densify --> entities_store
  retrieval_reg --> memory_search
  retrieval_reg --> memory_store
  synthesis --> consolidation

  %% Entity dependencies
  entities_store --> db_schema
  entities_profile --> entities_store
  entities_profile --> db_schema

  %% Other
  goals_store --> db_schema
  goals_store --> embedding_manager
  goals_store --> memory_scoring
  goals_store --> memory_store
  predictions --> db_schema
  predictions --> memory_store
  backup --> db_schema
  obsidian --> backup
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
    Store->>Store: validateStorageGate(content)
    Store->>Store: stripPrivateContent(content)
    Store->>Store: normalizeTagsAndAliases(tags)
    Store->>Store: autoTag(content)
    Store->>Store: classifyMetadata(content, tags)

    alt Content > chunking threshold
        Store->>Store: chunkContent() into segments
        Store->>Store: create parent + child memories
    end

    Store->>Embed: embed(content)
    Embed->>Embed: Local ONNX model (384-dim)
    Embed-->>Store: Float32Array embedding

    Store->>Store: INSERT into memories table
    Store->>FTS: FTS5 trigger fires (auto-indexes)
    Store->>Store: extractKeywords() → memory_keywords
    Store->>Store: extractFacts() → memory_facts

    Store->>Entity: extractEntities(content)
    Entity-->>Store: matched entities
    Store->>Store: link memory ↔ entities

    Store->>Linker: findSimilar(embedding, top 5)
    Linker->>Linker: cosine ≥ 0.75 → auto-link
    Linker-->>Store: created memory_links

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
    participant Goals as GoalStore

    Client->>Search: search({ query, limit, tags })

    par Parallel retrieval
        Search->>Embed: embed(query)
        Embed-->>Search: query embedding (384-dim)
        Search->>Search: Vector similarity scan (top 200)
    and
        Search->>Search: expandQuery(query) → entity aliases, tag aliases
        Search->>FTS: BM25 full-text search (top 200)
        FTS-->>Search: ranked FTS results
    and
        Search->>Goals: getActiveGoalKeywords()
        Goals-->>Search: goal-derived keywords
    end

    Search->>Search: Merge candidates (union of vector + FTS hits)

    Search->>Search: Compute per-candidate signals
    Note over Search: recency, frequency, usefulness,<br/>valence, quality, goal relevance

    Search->>Graph: getGraphProximityScores(top candidates)
    Graph-->>Search: graph proximity boosts

    alt RRF mode (default)
        Search->>Search: Reciprocal Rank Fusion<br/>(vector + FTS + graph ranked lists)
        Search->>Search: Post-RRF multiplicative boost
    else Legacy mode
        Search->>Search: Weighted average scoring
    end

    Search->>Search: Supersession demotion (×0.2)
    Search->>Search: Tag boost (query terms ∩ memory tags)
    Search->>Search: Metadata penalty
    Search->>Search: Quality floor + score gap filter
    Search->>Search: Sort, paginate

    Search-->>Client: SearchResult[] { memory, score, signals }
```

### 3. Intelligence Pipeline (Overnight)

What the sentinel jobs do while you sleep:

```mermaid
flowchart TB
    subgraph Scheduled["Sentinel Scheduler (Cortex)"]
        cron["Cron triggers"]
    end

    subgraph Memory_Maintenance["Memory Maintenance"]
        importance["importance adjustment<br/>boost accessed, decay stale"]
        decay["forgetting curve<br/>archive: stale/abandoned/neglected/forgotten"]
        consolidation["consolidation<br/>cluster similar → merge into summaries"]
        contradictions["contradiction detection<br/>cosine similarity + negation patterns"]
    end

    subgraph Entity_Maintenance["Entity Maintenance"]
        entity_extract["backfill entities<br/>re-extract from unlinked memories"]
        graph_densify["graph densification<br/>co-occurrence → entity relationships"]
        profiles["entity profiles<br/>recompute from linked memories"]
        prune["orphan pruning<br/>remove entities with < 2 links"]
    end

    subgraph Quality["Quality Assurance"]
        health["health checks<br/>8 checks: embedding gaps, tag sparsity,<br/>retrieval deserts, importance collapse..."]
        retrieval_reg["retrieval regression gate<br/>run saved queries, compare scores"]
        weight_tuning["adaptive weight tuning<br/>nudge scoring weights ±0.02 from feedback"]
    end

    subgraph Self_Improvement["Self-Improvement"]
        gardening["memory gardening<br/>tag cleanup, link repair"]
        insights["proactive insights<br/>surface missed patterns"]
        metrics["weekly metrics scorecard<br/>health, knowledge, reliability trends"]
    end

    cron --> importance --> decay --> consolidation --> contradictions
    cron --> entity_extract --> graph_densify --> profiles --> prune
    cron --> health --> retrieval_reg --> weight_tuning
    cron --> gardening
    cron --> insights
    cron --> metrics
```

### 4. Scoring Pipeline Detail

How a single memory gets scored during search:

```mermaid
flowchart LR
    subgraph Signals["Raw Signals (0-1 each)"]
        vec["Vector similarity<br/>(cosine vs query)"]
        fts["FTS BM25 rank<br/>(normalized)"]
        rec["Recency<br/>(exp decay, quality-dampened)"]
        freq["Frequency<br/>(log access count)"]
        useful["Usefulness<br/>(confirmed retrievals)"]
        val["Valence<br/>(|emotional significance|)"]
        qual["Quality<br/>(composite: importance,<br/>usefulness, access, links, freshness)"]
        goal["Goal relevance<br/>(tag/content overlap<br/>with active goals)"]
        graphProx["Graph proximity<br/>(linked to top results)"]
    end

    subgraph RRF["RRF Fusion"]
        rank_vec["Vector ranked list<br/>weight: 0.45"]
        rank_fts["FTS ranked list<br/>weight: 0.25"]
        rank_graph["Graph ranked list<br/>weight: 0.10"]
        fusion["1/(k + rank + 1)<br/>sum across lists"]
    end

    subgraph Boosts["Post-RRF Adjustments"]
        mult["× (1 + recency + freq +<br/>usefulness + valence +<br/>quality + goal)"]
        supersede["× 0.2 if superseded"]
        tag_boost["+ tag boost if query ∩ tags"]
        meta_pen["× metadata penalty"]
    end

    subgraph Filters["Output Filters"]
        floor["Quality floor ≥ 0.08"]
        gap["Score gap ratio ≥ 15%<br/>of top score"]
        limit["Offset + limit"]
    end

    vec --> rank_vec --> fusion
    fts --> rank_fts --> fusion
    graphProx --> rank_graph --> fusion
    fusion --> mult
    rec --> mult
    freq --> mult
    useful --> mult
    val --> mult
    qual --> mult
    goal --> mult
    mult --> supersede --> tag_boost --> meta_pen
    meta_pen --> floor --> gap --> limit
```
