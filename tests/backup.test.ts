import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getDbForTesting,
  initializeSchema,
  exportData,
  encryptBackup,
  decryptBackup,
  importData,
  backupDatabase,
  MemoryStore,
  EntityStore,
  GoalStore,
  MemoryLinkStore,
} from "@exocortex/core";
import { setEmbeddingProvider, resetEmbeddingProvider } from "@exocortex/core";
import type { DatabaseSync, BackupData } from "@exocortex/core";

// Mock embedding provider
const mockProvider = {
  embed: async () => new Float32Array(384),
  dimensions: 384,
};

let db: DatabaseSync;
let store: MemoryStore;
let entityStore: EntityStore;

beforeEach(() => {
  db = getDbForTesting();
  initializeSchema(db);
  store = new MemoryStore(db);
  entityStore = new EntityStore(db);
  setEmbeddingProvider(mockProvider);

  return () => {
    resetEmbeddingProvider();
    db.close();
  };
});

describe("Backup Export", () => {
  it("exports memories, entities, and settings", async () => {
    await store.create({ content: "Test memory one", tags: ["tag1"] });
    await store.create({ content: "Test memory two", tags: ["tag2"] });
    entityStore.create({ name: "TestEntity", type: "concept" });

    const data = exportData(db);

    expect(data.version).toBe(1);
    expect(data.exported_at).toBeTruthy();
    expect(data.memories.length).toBe(2);
    expect(data.memories[0].tags).toContain("tag1");
    expect(data.entities.length).toBeGreaterThanOrEqual(1);
    expect(Object.keys(data.settings).length).toBeGreaterThan(0);
  });

  it("excludes raw embeddings from export", async () => {
    await store.create({ content: "Memory with embedding" });
    const data = exportData(db);

    // The export query doesn't select the embedding column
    expect((data.memories[0] as any).embedding).toBeUndefined();
  });
});

describe("Encryption", () => {
  it("encrypts and decrypts backup data", () => {
    const data: BackupData = {
      version: 1,
      exported_at: new Date().toISOString(),
      memories: [
        {
          id: "test1",
          content: "Secret memory",
          content_type: "text",
          source: "manual",
          source_uri: null,
          importance: 0.5,
          access_count: 0,
          parent_id: null,
          is_active: 1,
          created_at: "2025-01-01",
          updated_at: "2025-01-01",
          tags: ["secret"],
        },
      ],
      entities: [],
      memory_entities: [],
      settings: { "test.key": "test.value" },
    };

    const password = "test-password-123";
    const encrypted = encryptBackup(data, password);

    expect(encrypted.length).toBeGreaterThan(60); // salt + iv + tag + ciphertext
    expect(encrypted).toBeInstanceOf(Buffer);

    const decrypted = decryptBackup(encrypted, password);
    expect(decrypted.version).toBe(1);
    expect(decrypted.memories[0].content).toBe("Secret memory");
    expect(decrypted.settings["test.key"]).toBe("test.value");
  });

  it("fails to decrypt with wrong password", () => {
    const data: BackupData = {
      version: 1,
      exported_at: new Date().toISOString(),
      memories: [],
      entities: [],
      memory_entities: [],
      settings: {},
    };

    const encrypted = encryptBackup(data, "correct-password");

    expect(() => {
      decryptBackup(encrypted, "wrong-password");
    }).toThrow();
  });
});

describe("Backup Import", () => {
  it("restores memories and entities from backup", async () => {
    // Create data in a source db
    await store.create({ content: "Memory Alpha", tags: ["alpha"] });
    entityStore.create({ name: "Entity1", type: "technology" });

    const data = exportData(db);

    // Import into a fresh db
    const db2 = getDbForTesting();
    initializeSchema(db2);
    const result = importData(db2, data);

    expect(result.memories).toBeGreaterThanOrEqual(1);
    expect(result.entities).toBeGreaterThanOrEqual(1);

    // Verify data exists
    const memories = db2
      .prepare("SELECT COUNT(*) as count FROM memories")
      .get() as { count: number };
    expect(memories.count).toBeGreaterThanOrEqual(1);

    db2.close();
  });

  it("is idempotent (no duplicates on re-import)", async () => {
    await store.create({ content: "Idempotent test" });
    const data = exportData(db);

    // Import same data twice
    importData(db, data);
    const first = db.prepare("SELECT COUNT(*) as count FROM memories").get() as { count: number };

    importData(db, data);
    const second = db.prepare("SELECT COUNT(*) as count FROM memories").get() as { count: number };

    expect(second.count).toBe(first.count);
  });

  it("restores goals (including milestones) and memory links", async () => {
    const goalStore = new GoalStore(db);
    const goal = goalStore.create({
      title: "Ship backup parity",
      description: "Ensure backup/import restores goals",
    });
    goalStore.addMilestone(goal.id, { title: "Add backup coverage" });

    const first = await store.create({ content: "Link source" });
    const second = await store.create({ content: "Link target" });
    const linkStore = new MemoryLinkStore(db);
    linkStore.link(first.memory.id, second.memory.id, "related", 0.8);

    const data = exportData(db);
    expect(data.goals?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(data.memory_links?.length ?? 0).toBeGreaterThanOrEqual(1);

    const db2 = getDbForTesting();
    initializeSchema(db2);
    importData(db2, data);

    const goals = db2
      .prepare("SELECT COUNT(*) as count FROM goals")
      .get() as { count: number };
    const links = db2
      .prepare("SELECT COUNT(*) as count FROM memory_links")
      .get() as { count: number };
    const restoredGoal = db2
      .prepare("SELECT metadata FROM goals WHERE id = ?")
      .get(goal.id) as { metadata: string } | undefined;

    expect(goals.count).toBeGreaterThanOrEqual(1);
    expect(links.count).toBeGreaterThanOrEqual(1);
    expect(restoredGoal).toBeTruthy();
    expect(
      ((JSON.parse(restoredGoal!.metadata).milestones as Array<unknown>) ?? []).length
    ).toBe(1);

    db2.close();
  });
});

describe("Database Backup (SQLite copy)", () => {
  // backupDatabase uses VACUUM INTO which requires a real on-disk DB
  let diskDb: DatabaseSync;
  let dbPath: string;
  let backupDir: string;

  beforeEach(() => {
    // Create a temp directory for the test DB and backups
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "exo-backup-test-"));
    dbPath = path.join(tmpDir, "test.db");
    backupDir = path.join(tmpDir, "backups");

    // Need a real on-disk database — VACUUM INTO doesn't work with :memory:
    const { DatabaseSync: SqliteDb } = require("node:sqlite");
    diskDb = new SqliteDb(dbPath) as DatabaseSync;
    diskDb.exec("PRAGMA journal_mode = WAL");
    diskDb.exec("PRAGMA foreign_keys = ON");
    initializeSchema(diskDb);
  });

  afterEach(() => {
    diskDb.close();
    // Clean up temp files
    const tmpDir = path.dirname(dbPath);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a backup file", () => {
    diskDb.exec("INSERT INTO settings (key, value) VALUES ('test.key', 'test.value')");

    const result = backupDatabase(diskDb, { backupDir });

    expect(fs.existsSync(result.path)).toBe(true);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.pruned).toBe(0);
    expect(result.path).toContain("exocortex-");
    expect(result.path.endsWith(".db")).toBe(true);
  });

  it("backup contains the original data", () => {
    diskDb.exec("INSERT INTO settings (key, value) VALUES ('backup.test', 'hello')");

    const result = backupDatabase(diskDb, { backupDir });

    // Open the backup and verify data
    const { DatabaseSync: SqliteDb } = require("node:sqlite");
    const backupDb = new SqliteDb(result.path) as DatabaseSync;
    const row = backupDb.prepare("SELECT value FROM settings WHERE key = 'backup.test'").get() as { value: string };
    expect(row.value).toBe("hello");
    backupDb.close();
  });

  it("rotates old backups beyond maxBackups", () => {
    // Create 3 backups with different timestamps by manipulating filenames
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, "exocortex-2025-01-01T00-00-00.db"), "old1");
    fs.writeFileSync(path.join(backupDir, "exocortex-2025-01-02T00-00-00.db"), "old2");
    fs.writeFileSync(path.join(backupDir, "exocortex-2025-01-03T00-00-00.db"), "old3");

    const result = backupDatabase(diskDb, { backupDir, maxBackups: 2 });

    // Should have pruned 2 old ones (3 existing + 1 new = 4, keep 2)
    expect(result.pruned).toBe(2);

    const remaining = fs.readdirSync(backupDir).filter((f) => f.endsWith(".db"));
    expect(remaining.length).toBe(2);
    // Should keep the newest old one and the new backup
    expect(remaining.some((f) => f.includes("2025-01-03"))).toBe(true);
    expect(remaining.some((f) => f === path.basename(result.path))).toBe(true);
  });
});
