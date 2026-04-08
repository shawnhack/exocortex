import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getSetting, setSetting } from "../db/schema.js";

export interface SyncOptions {
  vaultPath: string;
  dryRun?: boolean;
}

export interface SyncResult {
  newMemories: number;
  updatedFiles: number;
  deletedFiles: number;
  lastSyncAt: string;
}

interface ChangedMemory {
  id: string;
  content: string;
  namespace: string | null;
  tier: string;
  created_at: string;
  updated_at: string;
}

const SETTINGS_KEY = "obsidian.last_sync_at";

/**
 * Incrementally sync Exocortex memories to an Obsidian vault.
 * Only processes memories created or updated since the last sync.
 *
 * Creates/updates one .md file per memory in a folder structure:
 *   vault/exocortex/{namespace}/{tier}/{slug}.md
 *
 * This is intentionally simpler than the full obsidian export (which
 * generates curated, cross-linked sections). This sync keeps individual
 * memories as individual files, making Obsidian's built-in graph and
 * search work natively.
 */
export function syncToObsidian(db: DatabaseSync, options: SyncOptions): SyncResult {
  const { vaultPath, dryRun = false } = options;
  const lastSync = getSetting(db, SETTINGS_KEY) ?? "2000-01-01";
  const now = new Date().toISOString().replace("T", " ").replace("Z", "");

  // Find memories changed since last sync
  const changed = db
    .prepare(
      `SELECT m.id, m.content, m.namespace, m.tier, m.created_at, m.updated_at
       FROM memories m
       WHERE m.is_active = 1 AND m.parent_id IS NULL
         AND m.updated_at > ?
         AND length(m.content) > 30
       ORDER BY m.updated_at ASC`
    )
    .all(lastSync) as unknown as ChangedMemory[];

  if (changed.length === 0) {
    return { newMemories: 0, updatedFiles: 0, deletedFiles: 0, lastSyncAt: lastSync };
  }

  // Validate vault path exists before writing
  if (!dryRun && !fs.existsSync(vaultPath)) {
    throw new Error(`Vault path does not exist: ${vaultPath}. Create it or set OBSIDIAN_VAULT.`);
  }

  // Find deactivated memories since last sync (for cleanup)
  const deactivated = db
    .prepare(
      `SELECT m.id, m.namespace, m.tier FROM memories m
       WHERE m.is_active = 0 AND m.parent_id IS NULL
         AND m.updated_at > ?`
    )
    .all(lastSync) as unknown as Array<{ id: string; namespace: string | null; tier: string }>;

  const exoDir = path.join(vaultPath, "exocortex");

  // Batch-fetch tags for all changed memories
  const tagMap = new Map<string, string[]>();
  if (changed.length > 0) {
    const batchSize = 200;
    for (let i = 0; i < changed.length; i += batchSize) {
      const batch = changed.slice(i, i + batchSize);
      const placeholders = batch.map(() => "?").join(",");
      const rows = db
        .prepare(`SELECT memory_id, tag FROM memory_tags WHERE memory_id IN (${placeholders})`)
        .all(...batch.map(m => m.id)) as Array<{ memory_id: string; tag: string }>;
      for (const r of rows) {
        const arr = tagMap.get(r.memory_id) ?? [];
        arr.push(r.tag);
        tagMap.set(r.memory_id, arr);
      }
    }
  }

  let updatedFiles = 0;
  let deletedFiles = 0;

  if (!dryRun) {
    // Write/update files for changed memories
    for (const mem of changed) {
      const ns = (mem.namespace && mem.namespace.trim()) ? mem.namespace : "general";
      const dir = path.join(exoDir, slugify(ns), mem.tier);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const slug = mem.id.slice(0, 16);
      const filePath = path.join(dir, `${slug}.md`);
      const tags = tagMap.get(mem.id) ?? [];

      // Build frontmatter
      const lines = [
        "---",
        `id: ${mem.id}`,
        `created: ${mem.created_at.slice(0, 10)}`,
        `tier: ${mem.tier}`,
      ];
      if (mem.namespace) lines.push(`namespace: ${mem.namespace}`);
      if (tags.length > 0) lines.push(`tags: [${tags.join(", ")}]`);
      lines.push("---\n");

      // Add content with wikilink-style entity mentions
      lines.push(mem.content);

      fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
      updatedFiles++;
    }

    // Delete files for deactivated memories
    for (const mem of deactivated) {
      const ns = (mem.namespace && mem.namespace.trim()) ? mem.namespace : "general";
      const slug = mem.id.slice(0, 16);
      const filePath = path.join(exoDir, slugify(ns), mem.tier, `${slug}.md`);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        deletedFiles++;
      }
    }

    // Update last sync timestamp
    setSetting(db, SETTINGS_KEY, now);
  }

  return {
    newMemories: changed.length,
    updatedFiles,
    deletedFiles,
    lastSyncAt: dryRun ? lastSync : now,
  };
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}
