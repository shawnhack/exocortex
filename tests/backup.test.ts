import { describe, it, expect, beforeEach } from "vitest";
import {
  getDbForTesting,
  initializeSchema,
  exportData,
  encryptBackup,
  decryptBackup,
  importData,
  MemoryStore,
  EntityStore,
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
});
