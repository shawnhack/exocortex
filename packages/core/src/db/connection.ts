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
  db.exec("PRAGMA busy_timeout = 5000");

  dbByPath.set(resolvedPath, db);
  return db;
}

export function closeDb(dbPath?: string): void {
  if (dbPath) {
    const resolvedPath = resolveDbPath(dbPath);
    const db = dbByPath.get(resolvedPath);
    if (db) {
      db.close();
      dbByPath.delete(resolvedPath);
    }
    return;
  }

  for (const db of dbByPath.values()) {
    db.close();
  }
  dbByPath.clear();
}

export function getDbForTesting(): DatabaseSync {
  const testDb = new DatabaseSync(":memory:");
  testDb.exec("PRAGMA foreign_keys = ON");
  return testDb;
}
