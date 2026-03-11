import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export type { DatabaseSync };

const dbByPath = new Map<string, DatabaseSync>();

const DEFAULT_DATA_DIR = path.join(os.homedir(), ".exocortex");
const DEFAULT_DB_PATH = path.join(DEFAULT_DATA_DIR, "exocortex.db");

function resolveDbPath(dbPath?: string): string {
  return dbPath ?? process.env.EXOCORTEX_DB_PATH ?? DEFAULT_DB_PATH;
}

export function getDb(dbPath?: string): DatabaseSync {
  const resolvedPath = resolveDbPath(dbPath);
  const existing = dbByPath.get(resolvedPath);
  if (existing) return existing;

  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(resolvedPath);

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 10000");  // 10s — generous for concurrent scheduler writes
  db.exec("PRAGMA synchronous = NORMAL");  // safe with WAL, reduces fsync overhead
  db.exec("PRAGMA cache_size = -64000");   // 64MB page cache (default 2MB)
  db.exec("PRAGMA mmap_size = 268435456"); // 256MB mmap — avoids read() syscalls for DB < 256MB
  db.exec("PRAGMA temp_store = MEMORY");   // keep temp tables in memory
  db.exec("PRAGMA journal_size_limit = 33554432"); // 32MB — caps WAL file size between checkpoints
  db.exec("PRAGMA optimize(0x10002)");     // seed query planner stats on open (not just close)

  dbByPath.set(resolvedPath, db);
  return db;
}

export function closeDb(dbPath?: string): void {
  if (dbPath) {
    const resolvedPath = resolveDbPath(dbPath);
    const db = dbByPath.get(resolvedPath);
    if (db) {
      db.exec("PRAGMA optimize(0x10002)"); // update query planner statistics before close
      db.close();
      dbByPath.delete(resolvedPath);
    }
    return;
  }

  for (const db of dbByPath.values()) {
    db.exec("PRAGMA optimize(0x10002)");
    db.close();
  }
  dbByPath.clear();
}

export function getDbForTesting(): DatabaseSync {
  const testDb = new DatabaseSync(":memory:");
  testDb.exec("PRAGMA foreign_keys = ON");
  return testDb;
}
