import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  initializeSchema,
  runRetrievalRegression,
  setGoldenQueries,
} from "../packages/core/src/index.ts";

function hashContent(content) {
  const normalized = content.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex");
}

async function main() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  initializeSchema(db);

  const now = new Date().toISOString().replace("T", " ").replace("Z", "");
  const insertMemory = db.prepare(`
    INSERT INTO memories
      (id, content, content_hash, is_indexed, is_metadata, created_at, updated_at)
    VALUES (?, ?, ?, 1, 0, ?, ?)
  `);
  const insertTag = db.prepare(
    "INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)"
  );

  const fixtures = [
    {
      id: "MEM_ALPHA",
      content: "alpha routing architecture decision record",
      tags: ["project", "alpha"],
    },
    {
      id: "MEM_BETA",
      content: "beta latency budget benchmark report",
      tags: ["project", "beta"],
    },
    {
      id: "MEM_GAMMA",
      content: "gamma incident response playbook",
      tags: ["project", "gamma"],
    },
    // Friction queries — derived from actual search misses in production
    {
      id: "MEM_OBSIDIAN",
      content: "obsidian export vault pipeline generates curated markdown files with wikilinks and YAML frontmatter from memory database",
      tags: ["obsidian-export", "vault-export", "export"],
    },
    {
      id: "MEM_GARDENING",
      content: "memory gardening consolidation maintenance runs weekly to merge clusters, tune weights, prune orphans, and resolve search friction",
      tags: ["memory-gardening", "consolidation", "maintenance"],
    },
    {
      id: "MEM_SELFAUDIT",
      content: "self-audit quality check reviews consolidation output, prediction calibration, goal progress, and meta-review of sentinel job fleet health",
      tags: ["self-audit", "quality", "sentinel"],
    },
    {
      id: "MEM_WIKI",
      content: "wiki compile builds structured knowledge articles from memory clusters using entity graph and tag taxonomy for organized documentation",
      tags: ["wiki", "compile", "knowledge"],
    },
  ];

  for (const fixture of fixtures) {
    insertMemory.run(
      fixture.id,
      fixture.content,
      hashContent(fixture.content),
      now,
      now
    );
    for (const tag of fixture.tags) {
      insertTag.run(fixture.id, tag);
    }
  }

  const queries = [
    "alpha routing architecture",
    "beta latency budget",
    "gamma incident response",
    // Friction queries — these actually missed in production
    "obsidian export",
    "memory gardening consolidation maintenance",
    "self-audit quality check",
    "wiki compile",
  ];
  setGoldenQueries(db, queries);

  const upsertBaseline = db.prepare(`
    INSERT INTO retrieval_regression_baselines (query, top_ids, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(query) DO UPDATE
    SET top_ids = excluded.top_ids,
        updated_at = excluded.updated_at
  `);
  upsertBaseline.run(queries[0], JSON.stringify(["MEM_ALPHA"]), now, now);
  upsertBaseline.run(queries[1], JSON.stringify(["MEM_BETA"]), now, now);
  upsertBaseline.run(queries[2], JSON.stringify(["MEM_GAMMA"]), now, now);
  upsertBaseline.run(queries[3], JSON.stringify(["MEM_OBSIDIAN"]), now, now);
  upsertBaseline.run(queries[4], JSON.stringify(["MEM_GARDENING"]), now, now);
  upsertBaseline.run(queries[5], JSON.stringify(["MEM_SELFAUDIT"]), now, now);
  upsertBaseline.run(queries[6], JSON.stringify(["MEM_WIKI"]), now, now);

  const result = await runRetrievalRegression(db, {
    queries,
    limit: 1,
    min_overlap_at_10: 1,
    max_avg_rank_shift: 0,
    create_alert_memory: false,
  });

  console.log(
    `[retrieval-gate] run=${result.run_id ?? "n/a"} queries=${result.ran} alerts=${result.alerts}`
  );
  for (const row of result.results) {
    console.log(
      `  - ${row.query}: overlap=${(row.overlap_at_10 * 100).toFixed(1)}% avgShift=${row.avg_rank_shift.toFixed(2)} exact=${row.exact_order}`
    );
  }

  db.close();

  if (result.alerts > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(
    `[retrieval-gate] failed: ${err instanceof Error ? err.message : String(err)}`
  );
  process.exit(1);
});

