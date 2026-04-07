# Exocortex Retrieval Benchmarks

Reproducible retrieval benchmarks measuring Recall@K and NDCG@K across three standard datasets.

## Results (2026-04-07)

### Summary

| Benchmark | Questions | R@1 | R@5 | R@10 | NDCG@5 |
|-----------|-----------|-----|-----|------|--------|
| **LongMemEval** | 470 | 83.4% | **97.0%** | 98.9% | 85.5% |
| **LoCoMo** | 1,986 | 60.5% | **89.9%** | 95.7% | 73.0% |
| **MemBench** | 300 | 77.0% | **97.3%** | 99.7% | 76.6% |

Search method: Two-pass FTS5 (AND + OR with stopword removal) + Reciprocal Rank Fusion.
No external API calls. Fully local.

### LongMemEval (ICLR 2025)

500 questions testing 5 long-term memory abilities over scalable chat histories.

| Category | R@5 | R@10 | Questions |
|----------|-----|------|-----------|
| knowledge-update | 100.0% | 100.0% | 72 |
| single-session-user | 100.0% | 100.0% | 64 |
| multi-session | 97.5% | 98.3% | 121 |
| temporal-reasoning | 96.9% | 98.4% | 127 |
| single-session-assistant | 89.3% | 91.1% | 56 |
| single-session-preference | 86.7% | 90.0% | 30 |

30 abstention questions excluded (no ground truth retrieval target).

Source: [xiaowu0162/LongMemEval](https://github.com/xiaowu0162/LongMemEval) (MIT)

### LoCoMo (ACL 2024)

1,986 QA pairs across 10 long conversations testing multi-hop and temporal reasoning.

| Category | R@5 | R@10 | Questions |
|----------|-----|------|-----------|
| adversarial | 92.8% | 97.1% | 446 |
| multi-hop | 91.4% | 97.7% | 841 |
| temporal | 86.9% | 93.5% | 321 |
| single-hop | 80.5% | 95.4% | 282 |
| open-domain | 60.4% | 75.0% | 96 |

Source: [snap-research/locomo](https://github.com/snap-research/locomo) (CC BY-NC 4.0)

### MemBench (ACL 2025)

300 questions across 7 memory categories with multi-turn conversations.

| Category | R@5 | R@10 | Questions |
|----------|-----|------|-----------|
| simple | 100.0% | 100.0% | 50 |
| knowledge_update | 100.0% | 100.0% | 50 |
| aggregative | 100.0% | 100.0% | 50 |
| comparative | 100.0% | 100.0% | 50 |
| noisy | 94.0% | 100.0% | 50 |
| conditional | 96.0% | 100.0% | 50 |

Source: [import-myself/Membench](https://github.com/import-myself/Membench) (MIT)

## Running Benchmarks

```bash
# Prerequisites: download datasets
curl -L -o benchmarks/longmemeval/longmemeval_s.json \
  "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json"
curl -L -o benchmarks/longmemeval/locomo10.json \
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json"
# MemBench: download from github.com/import-myself/Membench/MemData/FirstAgent/

# Full suite (FTS-only, ~6 min)
node benchmarks/run-all.mjs --no-embed

# With neural embeddings (~30 min)
node benchmarks/run-all.mjs

# Quick sample with embeddings (~10 min)
node benchmarks/run-all.mjs --limit 100

# Single benchmark
node benchmarks/run-all.mjs --bench longmemeval
node benchmarks/run-all.mjs --bench locomo
node benchmarks/run-all.mjs --bench membench
```

## Comparison

| System | LongMemEval R@5 | Method | Cost |
|--------|----------------|--------|------|
| **Exocortex** | **97.0%** | Two-pass FTS (local) | $0 |
| MemPalace v4 raw | 96.6% | ChromaDB + all-MiniLM (local) | $0 |
| MemPalace v4 hybrid | 100% | ChromaDB + Haiku rerank | ~$0.01/query |

## Methodology

Each question is evaluated independently:
1. Fresh SQLite database created
2. Conversation sessions ingested with FTS5 indexing
3. Question used as search query
4. Retrieved session IDs compared against ground truth
5. Recall@K and NDCG@K computed

No training, no tuning on test data, no LLM calls during retrieval.
