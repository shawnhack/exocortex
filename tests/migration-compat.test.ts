import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  initializeSchema,
  importData,
  MemorySearch,
  resetEmbeddingProvider,
  setEmbeddingProvider,
} from "@exocortex/core";
import type { BackupData } from "@exocortex/core";

const mockProvider = {
  embed: async (text: string) => {
    const arr = new Float32Array(16);
    for (let i = 0; i < text.length; i++) {
      arr[text.charCodeAt(i) % arr.length] += 1;
    }
    return arr;
  },
  dimensions: 16,
};

afterEach(() => {
  resetEmbeddingProvider();
});

describe("migration and backward compatibility", () => {
  it("migrates a legacy memories table and preserves existing rows", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");

    db.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'text',
        source TEXT NOT NULL DEFAULT 'manual',
        source_uri TEXT,
        embedding BLOB,
        content_hash TEXT,
        is_indexed INTEGER NOT NULL DEFAULT 1,
        is_metadata INTEGER NOT NULL DEFAULT 0,
        importance REAL NOT NULL DEFAULT 0.5,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TEXT,
        parent_id TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE memory_tags (
        memory_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        PRIMARY KEY (memory_id, tag)
      );
    `);

    db.prepare(`
      INSERT INTO memories
      (id, content, content_type, source, source_uri, embedding, content_hash, is_indexed, is_metadata, importance, access_count, last_accessed_at, parent_id, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-1",
      "Legacy migration memory content",
      "text",
      "import",
      null,
      null,
      "legacy-hash",
      1,
      0,
      0.6,
      0,
      null,
      null,
      1,
      "2026-01-01 00:00:00",
      "2026-01-01 00:00:00"
    );
    db.prepare("INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)").run(
      "legacy-1",
      "legacy"
    );

    initializeSchema(db);

    const columns = new Set(
      (
        db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>
      ).map((c) => c.name)
    );

    expect(columns.has("content_hash")).toBe(true);
    expect(columns.has("is_indexed")).toBe(true);
    expect(columns.has("keywords")).toBe(true);
    expect(columns.has("useful_count")).toBe(true);

    const row = db
      .prepare("SELECT content_hash, is_indexed, content FROM memories WHERE id = ?")
      .get("legacy-1") as
      | { content_hash: string | null; is_indexed: number; content: string }
      | undefined;
    expect(row).toBeTruthy();
    expect(row!.content).toContain("Legacy migration memory content");
    expect(row!.content_hash).toBeTruthy();
    expect(row!.is_indexed).toBe(1);

    setEmbeddingProvider(mockProvider);
    const search = new MemorySearch(db);
    const results = await search.search({ query: "legacy migration content", limit: 5 });
    expect(results.some((r) => r.memory.id === "legacy-1")).toBe(true);

    db.close();
  });

  it("imports legacy backup payloads missing new optional fields", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    initializeSchema(db);

    const legacyBackup: BackupData = {
      version: 1,
      exported_at: "2026-02-20T00:00:00.000Z",
      memories: [
        {
          id: "legacy-backup-1",
          content: "Legacy backup memory entry",
          content_type: "text",
          source: "import",
          source_uri: null,
          importance: 0.5,
          access_count: 0,
          parent_id: null,
          is_active: 1,
          created_at: "2026-02-19 10:00:00",
          updated_at: "2026-02-19 10:00:00",
          tags: ["legacy", "backup"],
        },
      ],
      entities: [],
      memory_entities: [],
      settings: {},
    };

    const imported = importData(db, legacyBackup);
    expect(imported.memories).toBe(1);

    const row = db
      .prepare("SELECT id, content, is_indexed FROM memories WHERE id = ?")
      .get("legacy-backup-1") as
      | { id: string; content: string; is_indexed: number }
      | undefined;
    expect(row).toBeTruthy();
    expect(row!.content).toContain("Legacy backup memory entry");
    expect(row!.is_indexed).toBe(1);

    setEmbeddingProvider(mockProvider);
    const search = new MemorySearch(db);
    const results = await search.search({ query: "legacy backup", limit: 5 });
    expect(results.some((r) => r.memory.id === "legacy-backup-1")).toBe(true);

    db.close();
  });

  it("backfills first-class attribution columns from legacy metadata keys", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");

    db.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'text',
        source TEXT NOT NULL DEFAULT 'manual',
        source_uri TEXT,
        embedding BLOB,
        content_hash TEXT,
        is_indexed INTEGER NOT NULL DEFAULT 1,
        is_metadata INTEGER NOT NULL DEFAULT 0,
        importance REAL NOT NULL DEFAULT 0.5,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TEXT,
        parent_id TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        metadata TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE memory_tags (
        memory_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        PRIMARY KEY (memory_id, tag)
      );
    `);

    db.prepare(`
      INSERT INTO memories
      (id, content, content_type, source, source_uri, embedding, content_hash, is_indexed, is_metadata, importance, access_count, last_accessed_at, parent_id, is_active, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-meta-1",
      "Legacy metadata attribution row",
      "text",
      "mcp",
      null,
      null,
      null,
      1,
      0,
      0.5,
      0,
      null,
      null,
      1,
      JSON.stringify({
        model: "GPT-5.3-Codex",
        model_id: "gpt-5-codex",
        provider: "openai",
        agent: "codex",
        session_id: "session-legacy",
        conversation_id: "conversation-legacy",
      }),
      "2026-02-01 00:00:00",
      "2026-02-01 00:00:00"
    );

    initializeSchema(db);

    const row = db
      .prepare(
        "SELECT provider, model_id, model_name, agent, session_id, conversation_id FROM memories WHERE id = ?"
      )
      .get("legacy-meta-1") as
      | {
          provider: string | null;
          model_id: string | null;
          model_name: string | null;
          agent: string | null;
          session_id: string | null;
          conversation_id: string | null;
        }
      | undefined;

    expect(row).toBeTruthy();
    expect(row!.provider).toBe("openai");
    expect(row!.model_id).toBe("gpt-5-codex");
    expect(row!.model_name).toBe("GPT-5.3-Codex");
    expect(row!.agent).toBe("codex");
    expect(row!.session_id).toBe("session-legacy");
    expect(row!.conversation_id).toBe("conversation-legacy");

    db.close();
  });
});
