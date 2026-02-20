import type { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 1;

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
    importance REAL NOT NULL DEFAULT 0.5
      CHECK(importance >= 0 AND importance <= 1),
    access_count INTEGER NOT NULL DEFAULT 0,
    last_accessed_at TEXT,
    parent_id TEXT REFERENCES memories(id) ON DELETE SET NULL,
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
  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
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
  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content, keywords) VALUES (new.rowid, new.content, new.keywords);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, keywords) VALUES('delete', old.rowid, old.content, old.keywords);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content, keywords ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, keywords) VALUES('delete', old.rowid, old.content, old.keywords);
    INSERT INTO memories_fts(rowid, content, keywords) VALUES (new.rowid, new.content, new.keywords);
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
  "dedup.similarity_threshold": "0.85",
  "dedup.candidate_pool": "200",
  "chunking.enabled": "true",
  "chunking.max_length": "1500",
  "chunking.target_size": "500",
  "scoring.use_rrf": "true",
  "scoring.rrf_k": "60",
  "scoring.rrf_min_score": "0.001",
  "auto_tagging.enabled": "true",
  "trash.auto_purge_days": "30",
  "search.query_expansion": "false",
  "scoring.graph_weight": "0.10",
  "scoring.usefulness_weight": "0.05",
};

const initializedDbs = new WeakSet<DatabaseSync>();

export function initializeSchema(db: DatabaseSync): void {
  if (initializedDbs.has(db)) return;

  let needsFtsRebuild = false;

  db.exec(CREATE_TABLES);
  db.exec(CREATE_FTS);
  db.exec(CREATE_FTS_TRIGGERS);

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
