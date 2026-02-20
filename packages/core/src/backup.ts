import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  pbkdf2Sync,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { DatabaseSync } from "node:sqlite";
import type { MemoryRow } from "./memory/types.js";
import type { Entity } from "./entities/types.js";

export interface BackupData {
  version: 1;
  exported_at: string;
  memories: Array<{
    id: string;
    content: string;
    content_type: string;
    source: string;
    source_uri: string | null;
    importance: number;
    access_count: number;
    parent_id: string | null;
    is_active: number;
    metadata?: Record<string, unknown>;
    created_at: string;
    updated_at: string;
    tags: string[];
  }>;
  entities: Array<{
    id: string;
    name: string;
    type: string;
    aliases: string[];
    metadata: Record<string, unknown>;
    tags?: string[];
    created_at: string;
    updated_at: string;
  }>;
  memory_entities: Array<{
    memory_id: string;
    entity_id: string;
    relevance: number;
  }>;
  goals?: Array<{
    id: string;
    title: string;
    description: string | null;
    status: string;
    priority: string;
    deadline: string | null;
    metadata: Record<string, unknown>;
    created_at: string;
    updated_at: string;
    completed_at: string | null;
  }>;
  memory_links?: Array<{
    source_id: string;
    target_id: string;
    link_type: string;
    strength: number;
    created_at: string;
  }>;
  entity_relationships?: Array<{
    id: string;
    source_entity_id: string;
    target_entity_id: string;
    relationship: string;
    confidence: number;
    memory_id: string | null;
    context: string | null;
    created_at: string;
  }>;
  contradictions?: Array<{
    id: string;
    memory_a_id: string;
    memory_b_id: string;
    description: string;
    status: string;
    resolution: string | null;
    created_at: string;
    updated_at: string;
  }>;
  settings: Record<string, string>;
}

/**
 * Export all data from the database as a JSON backup.
 * Excludes raw embeddings (they'll be regenerated on import).
 */
export function exportData(db: DatabaseSync): BackupData {
  const memories = db
    .prepare(
      "SELECT id, content, content_type, source, source_uri, importance, access_count, parent_id, is_active, metadata, created_at, updated_at FROM memories ORDER BY created_at ASC"
    )
    .all() as unknown as Array<{
    id: string;
    content: string;
    content_type: string;
    source: string;
    source_uri: string | null;
    importance: number;
    access_count: number;
    parent_id: string | null;
    is_active: number;
    metadata: string | null;
    created_at: string;
    updated_at: string;
  }>;

  // Fetch tags for each memory
  const tagStmt = db.prepare("SELECT tag FROM memory_tags WHERE memory_id = ?");
  const memoriesWithTags = memories.map((m) => {
    const tags = (tagStmt.all(m.id) as Array<{ tag: string }>).map((t) => t.tag);
    const { metadata: rawMeta, ...rest } = m;
    return {
      ...rest,
      metadata: rawMeta ? JSON.parse(rawMeta) as Record<string, unknown> : undefined,
      tags,
    };
  });

  const entities = db
    .prepare("SELECT * FROM entities ORDER BY name ASC")
    .all() as unknown as Array<{
    id: string;
    name: string;
    type: string;
    aliases: string;
    metadata: string;
    created_at: string;
    updated_at: string;
  }>;

  const entityTagStmt = db.prepare("SELECT tag FROM entity_tags WHERE entity_id = ?");
  const parsedEntities = entities.map((e) => ({
    ...e,
    aliases: JSON.parse(e.aliases),
    metadata: JSON.parse(e.metadata),
    tags: (entityTagStmt.all(e.id) as Array<{ tag: string }>).map((t) => t.tag),
  }));

  const memoryEntities = db
    .prepare("SELECT * FROM memory_entities")
    .all() as unknown as Array<{
    memory_id: string;
    entity_id: string;
    relevance: number;
  }>;

  const goals = db
    .prepare(
      "SELECT id, title, description, status, priority, deadline, metadata, created_at, updated_at, completed_at FROM goals ORDER BY created_at ASC"
    )
    .all() as unknown as Array<{
    id: string;
    title: string;
    description: string | null;
    status: string;
    priority: string;
    deadline: string | null;
    metadata: string;
    created_at: string;
    updated_at: string;
    completed_at: string | null;
  }>;

  const parsedGoals = goals.map((g) => ({
    ...g,
    metadata: JSON.parse(g.metadata),
  }));

  const memoryLinks = db
    .prepare(
      "SELECT source_id, target_id, link_type, strength, created_at FROM memory_links ORDER BY created_at ASC"
    )
    .all() as unknown as Array<{
    source_id: string;
    target_id: string;
    link_type: string;
    strength: number;
    created_at: string;
  }>;

  const entityRelationships = db
    .prepare(
      "SELECT id, source_entity_id, target_entity_id, relationship, confidence, memory_id, context, created_at FROM entity_relationships ORDER BY created_at ASC"
    )
    .all() as unknown as Array<{
    id: string;
    source_entity_id: string;
    target_entity_id: string;
    relationship: string;
    confidence: number;
    memory_id: string | null;
    context: string | null;
    created_at: string;
  }>;

  const contradictions = db
    .prepare(
      "SELECT id, memory_a_id, memory_b_id, description, status, resolution, created_at, updated_at FROM contradictions ORDER BY created_at ASC"
    )
    .all() as unknown as Array<{
    id: string;
    memory_a_id: string;
    memory_b_id: string;
    description: string;
    status: string;
    resolution: string | null;
    created_at: string;
    updated_at: string;
  }>;

  const settingsRows = db
    .prepare("SELECT key, value FROM settings")
    .all() as Array<{ key: string; value: string }>;
  const settings: Record<string, string> = {};
  for (const row of settingsRows) {
    settings[row.key] = row.value;
  }

  return {
    version: 1,
    exported_at: new Date().toISOString(),
    memories: memoriesWithTags,
    entities: parsedEntities,
    memory_entities: memoryEntities,
    goals: parsedGoals,
    memory_links: memoryLinks,
    entity_relationships: entityRelationships,
    contradictions,
    settings,
  };
}

/**
 * Encrypt backup data with AES-256-GCM using a password-derived key.
 * Format: salt(32) + iv(12) + authTag(16) + ciphertext
 */
export function encryptBackup(data: BackupData, password: string): Buffer {
  const json = JSON.stringify(data);
  const salt = randomBytes(32);
  const key = pbkdf2Sync(password, salt, 100_000, 32, "sha256");
  const iv = randomBytes(12);

  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(json, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([salt, iv, authTag, encrypted]);
}

/**
 * Decrypt backup data encrypted with encryptBackup.
 */
export function decryptBackup(encrypted: Buffer, password: string): BackupData {
  const salt = encrypted.subarray(0, 32);
  const iv = encrypted.subarray(32, 44);
  const authTag = encrypted.subarray(44, 60);
  const ciphertext = encrypted.subarray(60);

  const key = pbkdf2Sync(password, salt, 100_000, 32, "sha256");

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return JSON.parse(decrypted.toString("utf8"));
}

/**
 * Import backup data into the database.
 * Uses INSERT OR IGNORE to avoid duplicates (idempotent).
 */
export function importData(db: DatabaseSync, data: BackupData): {
  memories: number;
  entities: number;
  links: number;
} {
  let memoriesImported = 0;
  let entitiesImported = 0;
  let linksImported = 0;

  db.exec("BEGIN");
  try {
    // Import memories (without embeddings — they'll be regenerated)
    const insertMemory = db.prepare(
      `INSERT OR IGNORE INTO memories
       (id, content, content_type, source, source_uri, importance, access_count, parent_id, is_active, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertTag = db.prepare(
      "INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)"
    );

    for (const m of data.memories) {
      const result = insertMemory.run(
        m.id, m.content, m.content_type, m.source, m.source_uri,
        m.importance, m.access_count, m.parent_id, m.is_active,
        m.metadata ? JSON.stringify(m.metadata) : null,
        m.created_at, m.updated_at
      );
      if ((result as { changes: number }).changes > 0) {
        memoriesImported++;
        for (const tag of m.tags) {
          insertTag.run(m.id, tag);
        }
      }
    }

    // Import entities
    const insertEntity = db.prepare(
      `INSERT OR IGNORE INTO entities
       (id, name, type, aliases, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const insertEntityTag = db.prepare(
      "INSERT OR IGNORE INTO entity_tags (entity_id, tag) VALUES (?, ?)"
    );

    for (const e of data.entities) {
      const result = insertEntity.run(
        e.id, e.name, e.type,
        JSON.stringify(e.aliases), JSON.stringify(e.metadata),
        e.created_at, e.updated_at
      );
      if ((result as { changes: number }).changes > 0) {
        entitiesImported++;
        if (e.tags) {
          for (const tag of e.tags) {
            insertEntityTag.run(e.id, tag);
          }
        }
      }
    }

    // Import memory-entity links
    const insertLink = db.prepare(
      "INSERT OR IGNORE INTO memory_entities (memory_id, entity_id, relevance) VALUES (?, ?, ?)"
    );

    for (const link of data.memory_entities) {
      const result = insertLink.run(link.memory_id, link.entity_id, link.relevance);
      if ((result as { changes: number }).changes > 0) {
        linksImported++;
      }
    }

    // Import goals
    if (data.goals && data.goals.length > 0) {
      const insertGoal = db.prepare(
        `INSERT OR IGNORE INTO goals
         (id, title, description, status, priority, deadline, metadata, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const goal of data.goals) {
        insertGoal.run(
          goal.id,
          goal.title,
          goal.description,
          goal.status,
          goal.priority,
          goal.deadline,
          JSON.stringify(goal.metadata ?? {}),
          goal.created_at,
          goal.updated_at,
          goal.completed_at
        );
      }
    }

    // Import memory links
    if (data.memory_links && data.memory_links.length > 0) {
      const insertMemoryLink = db.prepare(
        `INSERT OR IGNORE INTO memory_links
         (source_id, target_id, link_type, strength, created_at)
         VALUES (?, ?, ?, ?, ?)`
      );
      for (const link of data.memory_links) {
        insertMemoryLink.run(
          link.source_id,
          link.target_id,
          link.link_type,
          link.strength,
          link.created_at
        );
      }
    }

    // Import entity relationships
    if (data.entity_relationships && data.entity_relationships.length > 0) {
      const insertEntityRel = db.prepare(
        `INSERT OR IGNORE INTO entity_relationships
         (id, source_entity_id, target_entity_id, relationship, confidence, memory_id, context, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const rel of data.entity_relationships) {
        insertEntityRel.run(
          rel.id,
          rel.source_entity_id,
          rel.target_entity_id,
          rel.relationship,
          rel.confidence,
          rel.memory_id,
          rel.context,
          rel.created_at
        );
      }
    }

    // Import contradictions
    if (data.contradictions && data.contradictions.length > 0) {
      const insertContradiction = db.prepare(
        `INSERT OR IGNORE INTO contradictions
         (id, memory_a_id, memory_b_id, description, status, resolution, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const contradiction of data.contradictions) {
        insertContradiction.run(
          contradiction.id,
          contradiction.memory_a_id,
          contradiction.memory_b_id,
          contradiction.description,
          contradiction.status,
          contradiction.resolution,
          contradiction.created_at,
          contradiction.updated_at
        );
      }
    }

    // Import settings (don't overwrite existing)
    const insertSetting = db.prepare(
      "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)"
    );
    for (const [key, value] of Object.entries(data.settings)) {
      insertSetting.run(key, value);
    }

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return { memories: memoriesImported, entities: entitiesImported, links: linksImported };
}

export interface BackupDatabaseOptions {
  backupDir?: string;
  maxBackups?: number;
}

export interface BackupDatabaseResult {
  path: string;
  sizeBytes: number;
  pruned: number;
}

/**
 * Create a SQLite backup using VACUUM INTO (atomic, compact copy).
 * Rotates old backups, keeping the most recent `maxBackups` files.
 */
export function backupDatabase(
  db: DatabaseSync,
  options?: BackupDatabaseOptions
): BackupDatabaseResult {
  const backupDir =
    options?.backupDir ??
    path.join(os.homedir(), ".exocortex", "backups");
  const maxBackups = options?.maxBackups ?? 7;

  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  const backupPath = path.join(backupDir, `exocortex-${timestamp}.db`);

  // VACUUM INTO creates an atomic, compact copy of the database.
  // Use forward slashes — SQLite handles them on all platforms.
  const sqlPath = backupPath.replace(/\\/g, "/").replace(/'/g, "''");
  db.exec(`VACUUM INTO '${sqlPath}'`);

  const sizeBytes = fs.statSync(backupPath).size;

  // Rotate: remove oldest backups beyond the limit
  let pruned = 0;
  if (maxBackups > 0) {
    const backups = fs
      .readdirSync(backupDir)
      .filter((f) => f.startsWith("exocortex-") && f.endsWith(".db"))
      .sort(); // ISO timestamps sort lexicographically

    while (backups.length > maxBackups) {
      const oldest = backups.shift()!;
      fs.unlinkSync(path.join(backupDir, oldest));
      pruned++;
    }
  }

  return { path: backupPath, sizeBytes, pruned };
}
