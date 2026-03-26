---
description: Rules for benchmark suite code
globs: packages/core/src/benchmark/**
---

# Benchmark Code Standards

- Never modify baseline files without documenting why in the commit message
- Include comparison to previous run results when changing baselines
- Benchmarks must be runnable with `pnpm benchmark` (requires ANTHROPIC_API_KEY)
- Test queries should cover: semantic search, keyword search, graph traversal, tier filtering
- Record both precision and recall metrics
