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

