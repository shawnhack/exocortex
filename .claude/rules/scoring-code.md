---
description: Rules for memory scoring and search code
globs: packages/core/src/memory/scoring*,packages/core/src/memory/search*
---

# Scoring Code Standards

- NaN guards on ALL parseFloat calls — use `|| 0` or explicit fallback
- Maintain ScoringWeights interface — adding/removing fields requires updating all consumers
- RRF scoring range: 0.001-0.03. Legacy weighted-average range: 0.15-0.80. Never mix ranges.
- Post-RRF multiplicative boosts (tier, quality, usefulness) can flip rankings — verify ordering in tests
- Use deterministic ID-based tie-breakers for stable sort order
- All scoring functions must handle undefined/null inputs gracefully
- Run `pnpm benchmark` after any scoring changes to verify retrieval quality
