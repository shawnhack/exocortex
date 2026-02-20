import type { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 3;

const CREATE_TABLES = `
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'text'
      CHECK(content_type IN ('text', 'conversation', 'note', 'summary')),
    source TEXT NOT NULL DEFAULT 'manual'
      CHECK(source IN ('manual', 'cli', 'api', 'mcp', 'browser', 'import', 'consolidation')),
    source_uri TEXT,
    embedding BLOB,
    content_hash TEXT,
    is_indexed INTEGER NOT NULL DEFAULT 1,
    is_metadata INTEGER NOT NULL DEFAULT 0,
    importance REAL NOT NULL DEFAULT 0.5
      CHECK(importance >= 0 AND importance <= 1),
    access_count INTEGER NOT NULL DEFAULT 0,
    last_accessed_at TEXT,
    parent_id TEXT REFERENCES memories(id) ON DELETE CASCADE,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'concept'
      CHECK(type IN ('person', 'project', 'technology', 'organization', 'concept')),
    aliases TEXT NOT NULL DEFAULT '[]',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS memory_entities (
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    relevance REAL NOT NULL DEFAULT 1.0,
    PRIMARY KEY (memory_id, entity_id)
  );

  CREATE TABLE IF NOT EXISTS memory_tags (
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (memory_id, tag)
  );

  CREATE TABLE IF NOT EXISTS consolidations (
    id TEXT PRIMARY KEY,
    summary_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    source_ids TEXT NOT NULL DEFAULT '[]',
    strategy TEXT NOT NULL,
    memories_merged INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS contradictions (
    id TEXT PRIMARY KEY,
    memory_a_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    memory_b_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending', 'resolved', 'dismissed')),
    resolution TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS access_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    query TEXT,
    accessed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_memories_content_type ON memories(content_type);
  CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source);
  CREATE INDEX IF NOT EXISTS idx_memories_is_active ON memories(is_active);
  CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);
  CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
  CREATE INDEX IF NOT EXISTS idx_memory_tags_tag ON memory_tags(tag);
  CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
  CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
  CREATE INDEX IF NOT EXISTS idx_access_log_memory ON access_log(memory_id);
  CREATE INDEX IF NOT EXISTS idx_contradictions_status ON contradictions(status);

  CREATE TABLE IF NOT EXISTS entity_relationships (
    id TEXT PRIMARY KEY,
    source_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    target_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    relationship TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.7,
    memory_id TEXT REFERENCES memories(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_entity_rel_source ON entity_relationships(source_entity_id);
  CREATE INDEX IF NOT EXISTS idx_entity_rel_target ON entity_relationships(target_entity_id);
`;

const CREATE_FTS = `
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content,
    content='memories',
    content_rowid='rowid'
  );
`;

const CREATE_FTS_TRIGGERS = `
  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories
  WHEN new.is_indexed = 1
  BEGIN
    INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories
  WHEN old.is_indexed = 1
  BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content, is_indexed ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content)
    SELECT 'delete', old.rowid, old.content WHERE old.is_indexed = 1;
    INSERT INTO memories_fts(rowid, content)
    SELECT new.rowid, new.content WHERE new.is_indexed = 1;
  END;
`;

// FTS5 with keywords column — used after migration adds keywords column
const CREATE_FTS_WITH_KEYWORDS = `
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content,
    keywords,
    content='memories',
    content_rowid='rowid'
  );
`;

const CREATE_FTS_TRIGGERS_WITH_KEYWORDS = `
  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories
  WHEN new.is_indexed = 1
  BEGIN
    INSERT INTO memories_fts(rowid, content, keywords) VALUES (new.rowid, new.content, new.keywords);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories
  WHEN old.is_indexed = 1
  BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, keywords) VALUES('delete', old.rowid, old.content, old.keywords);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content, keywords, is_indexed ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, keywords)
    SELECT 'delete', old.rowid, old.content, old.keywords WHERE old.is_indexed = 1;
    INSERT INTO memories_fts(rowid, content, keywords)
    SELECT new.rowid, new.content, new.keywords WHERE new.is_indexed = 1;
  END;
`;

const DEFAULT_SETTINGS: Record<string, string> = {
  "scoring.vector_weight": "0.45",
  "scoring.fts_weight": "0.25",
  "scoring.recency_weight": "0.20",
  "scoring.frequency_weight": "0.10",
  "scoring.recency_decay": "0.05",
  "scoring.min_score": "0.15",
  "scoring.tag_boost": "0.10",
  "embedding.model": "Xenova/all-MiniLM-L6-v2",
  "embedding.dimensions": "384",
  "server.port": "3210",
  "importance.auto_adjust": "true",
  "importance.boost_threshold": "5",
  "importance.decay_age_days": "30",
  "dedup.enabled": "true",
  "dedup.hash_enabled": "true",
  "dedup.similarity_threshold": "0.85",
  "dedup.candidate_pool": "200",
  "dedup.skip_insert_on_match": "true",
  "dedup.hash_normalize_whitespace": "true",
  "chunking.enabled": "true",
  "chunking.max_length": "1500",
  "chunking.target_size": "500",
  "scoring.use_rrf": "true",
  "scoring.rrf_k": "60",
  "scoring.rrf_min_score": "0.001",
  "auto_tagging.enabled": "true",
  "trash.auto_purge_days": "30",
  "search.query_expansion": "false",
  "search.metadata_mode": "penalize",
  "search.metadata_penalty": "0.35",
  "search.metadata_tags": "benchmark-artifact,golden-queries,retrieval-regression,goal-progress,goal-progress-implicit",
  "tags.alias_map": "{\"nextjs\":\"next.js\",\"next-js\":\"next.js\",\"clawworld\":\"claw-world\"}",
  "benchmark.default_importance": "0.15",
  "benchmark.indexed": "false",
  "benchmark.chunking": "false",
  "retrieval_regression.enabled": "true",
  "retrieval_regression.schedule": "15 6 * * *",
  "retrieval_regression.queries": "[]",
  "retrieval_regression.limit": "10",
  "retrieval_regression.min_overlap_at_10": "0.80",
  "retrieval_regression.max_avg_rank_shift": "3",
  "retrieval_regression.create_alert_memory": "true",
  "observability.log_events": "false",
  "scoring.graph_weight": "0.10",
  "scoring.usefulness_weight": "0.05",
};

const initializedDbs = new WeakSet<DatabaseSync>();

export function initializeSchema(db: DatabaseSync): void {
  if (initializedDbs.has(db)) return;

  let needsFtsRebuild = false;

  db.exec(CREATE_TABLES);
  db.exec(CREATE_FTS);

  const upsertSetting = db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)"
  );

  db.exec("BEGIN");
  try {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      upsertSetting.run(key, value);
    }
    db.prepare(
      "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)"
    ).run("schema_version", String(SCHEMA_VERSION));
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  // Migrations: add new columns if missing (safe ALTER TABLE ADD COLUMN)
  const columns = db
    .prepare("PRAGMA table_info(memories)")
    .all() as Array<{ name: string }>;
  const colNames = new Set(columns.map((c) => c.name));

  if (!colNames.has("superseded_by")) {
    db.exec("ALTER TABLE memories ADD COLUMN superseded_by TEXT");
  }
  if (!colNames.has("chunk_index")) {
    db.exec("ALTER TABLE memories ADD COLUMN chunk_index INTEGER");
  }
  if (!colNames.has("metadata")) {
    db.exec("ALTER TABLE memories ADD COLUMN metadata TEXT");
  }
  if (!colNames.has("content_hash")) {
    db.exec("ALTER TABLE memories ADD COLUMN content_hash TEXT");
    db.exec("UPDATE memories SET content_hash = lower(trim(content)) WHERE content_hash IS NULL");
  }
  if (!colNames.has("is_indexed")) {
    db.exec("ALTER TABLE memories ADD COLUMN is_indexed INTEGER NOT NULL DEFAULT 1");
  }
  if (!colNames.has("is_metadata")) {
    db.exec("ALTER TABLE memories ADD COLUMN is_metadata INTEGER NOT NULL DEFAULT 0");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_memories_is_metadata ON memories(is_metadata)");

  // Backfill metadata flag for known system/benchmark classes.
  const metadataTagList = (
    getSetting(db, "search.metadata_tags") ??
    DEFAULT_SETTINGS["search.metadata_tags"]
  )
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (metadataTagList.length > 0) {
    const placeholders = metadataTagList.map(() => "?").join(", ");
    db.prepare(
      `UPDATE memories
       SET is_metadata = 1
       WHERE is_metadata = 0
         AND id IN (
           SELECT memory_id FROM memory_tags WHERE tag IN (${placeholders})
         )`
    ).run(...metadataTagList);
  }
  db.exec(
    `UPDATE memories
     SET is_metadata = 1
     WHERE is_metadata = 0
       AND metadata IS NOT NULL
       AND (
         metadata LIKE '%"mode":"benchmark"%'
         OR metadata LIKE '%retrieval-regression%'
         OR metadata LIKE '%goal-progress%'
         OR metadata LIKE '%benchmark%'
       )`
  );

  // Canonicalize active hash duplicates before enabling uniqueness.
  db.exec(`
    WITH ranked AS (
      SELECT
        id,
        first_value(id) OVER (
          PARTITION BY content_type, content_hash
          ORDER BY created_at DESC, id DESC
        ) AS keep_id,
        row_number() OVER (
          PARTITION BY content_type, content_hash
          ORDER BY created_at DESC, id DESC
        ) AS rn
      FROM memories
      WHERE is_active = 1
        AND parent_id IS NULL
        AND content_hash IS NOT NULL
    )
    UPDATE memories
    SET
      is_active = 0,
      superseded_by = (SELECT keep_id FROM ranked WHERE ranked.id = memories.id),
      updated_at = datetime('now')
    WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_memories_active_root_hash_type
      ON memories(content_type, content_hash)
      WHERE is_active = 1
        AND parent_id IS NULL
        AND content_hash IS NOT NULL
  `);
  // Search friction signal tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_misses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      result_count INTEGER NOT NULL DEFAULT 0,
      max_score REAL,
      filters TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_search_misses_created ON search_misses(created_at);
  `);

  // Lightweight event counters for operational observability.
  db.exec(`
    CREATE TABLE IF NOT EXISTS observability_counters (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Memory-to-memory links
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_links (
      source_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      link_type TEXT NOT NULL DEFAULT 'related',
      strength REAL NOT NULL DEFAULT 0.5,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (source_id, target_id)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_links_target ON memory_links(target_id);
  `);

  // Goals table
  db.exec(`
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active', 'completed', 'stalled', 'abandoned')),
      priority TEXT NOT NULL DEFAULT 'medium'
        CHECK(priority IN ('low', 'medium', 'high', 'critical')),
      deadline TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      embedding BLOB
    );
    CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);
  `);

  // Goals embedding column (migration for existing databases)
  const goalColumns = db
    .prepare("PRAGMA table_info(goals)")
    .all() as Array<{ name: string }>;
  const goalColNames = new Set(goalColumns.map((c) => c.name));
  if (!goalColNames.has("embedding")) {
    db.exec("ALTER TABLE goals ADD COLUMN embedding BLOB");
  }

  // Co-retrieval tracking for link building
  db.exec(`
    CREATE TABLE IF NOT EXISTS co_retrievals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query_hash TEXT NOT NULL,
      memory_ids TEXT NOT NULL,
      result_count INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_co_retrievals_created ON co_retrievals(created_at);
  `);

  // Golden-query retrieval regression tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS retrieval_regression_baselines (
      query TEXT PRIMARY KEY,
      top_ids TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS retrieval_regression_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_group_id TEXT NOT NULL DEFAULT '',
      query TEXT NOT NULL,
      baseline_ids TEXT NOT NULL DEFAULT '[]',
      current_ids TEXT NOT NULL DEFAULT '[]',
      overlap_at_10 REAL NOT NULL DEFAULT 0,
      avg_rank_shift REAL NOT NULL DEFAULT 0,
      exact_order INTEGER NOT NULL DEFAULT 0,
      alert INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_retrieval_regression_runs_query_created
      ON retrieval_regression_runs(query, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_retrieval_regression_runs_group
      ON retrieval_regression_runs(run_group_id, created_at DESC);
  `);
  const regressionRunColumns = db
    .prepare("PRAGMA table_info(retrieval_regression_runs)")
    .all() as Array<{ name: string }>;
  const regressionRunColNames = new Set(regressionRunColumns.map((c) => c.name));
  if (!regressionRunColNames.has("run_group_id")) {
    db.exec(
      "ALTER TABLE retrieval_regression_runs ADD COLUMN run_group_id TEXT NOT NULL DEFAULT ''"
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_retrieval_regression_runs_group ON retrieval_regression_runs(run_group_id, created_at DESC)"
    );
  }

  // Entity tags (multi-label classification)
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_tags (
      entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY (entity_id, tag)
    );
    CREATE INDEX IF NOT EXISTS idx_entity_tags_tag ON entity_tags(tag);
  `);

  // Context phrases on entity relationships
  const relColumns = db
    .prepare("PRAGMA table_info(entity_relationships)")
    .all() as Array<{ name: string }>;
  const relColNames = new Set(relColumns.map((c) => c.name));
  if (!relColNames.has("context")) {
    db.exec("ALTER TABLE entity_relationships ADD COLUMN context TEXT");
  }

  if (!colNames.has("useful_count")) {
    db.exec("ALTER TABLE memories ADD COLUMN useful_count INTEGER NOT NULL DEFAULT 0");
  }

  if (!colNames.has("keywords")) {
    db.exec("ALTER TABLE memories ADD COLUMN keywords TEXT");
    // Rebuild FTS to include keywords column
    needsFtsRebuild = true;
  }

  // Rebuild FTS5 to include keywords if needed
  if (needsFtsRebuild) {
    // Drop existing FTS table and triggers, recreate with keywords
    db.exec("DROP TRIGGER IF EXISTS memories_ai");
    db.exec("DROP TRIGGER IF EXISTS memories_ad");
    db.exec("DROP TRIGGER IF EXISTS memories_au");
    db.exec("DROP TABLE IF EXISTS memories_fts");
    db.exec(CREATE_FTS_WITH_KEYWORDS);
    db.exec(CREATE_FTS_TRIGGERS_WITH_KEYWORDS);
    db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
  }

  // Always refresh triggers to ensure `is_indexed` conditional indexing is active.
  db.exec("DROP TRIGGER IF EXISTS memories_ai");
  db.exec("DROP TRIGGER IF EXISTS memories_ad");
  db.exec("DROP TRIGGER IF EXISTS memories_au");
  if (colNames.has("keywords") || needsFtsRebuild) {
    db.exec(CREATE_FTS_TRIGGERS_WITH_KEYWORDS);
  } else {
    db.exec(CREATE_FTS_TRIGGERS);
  }

  // Legacy cleanup: older schemas used ON DELETE SET NULL for parent_id, which
  // could leave orphaned chunk rows (chunk_index set, parent_id null) after
  // parent deletion. Remove those stale rows once at startup.
  db.prepare(
    "DELETE FROM memories WHERE chunk_index IS NOT NULL AND parent_id IS NULL"
  ).run();

  initializedDbs.add(db);
}

export function getSetting(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

export function getAllSettings(db: DatabaseSync): Record<string, string> {
  const rows = db.prepare("SELECT key, value FROM settings").all() as Array<{
    key: string;
    value: string;
  }>;
  const settings: Record<string, string> = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  return settings;
}
