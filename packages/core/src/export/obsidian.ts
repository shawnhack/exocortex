import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { exportData, type BackupData } from "../backup.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ObsidianExportOptions {
  vaultPath: string;
  fullExport?: boolean;
}

export interface ObsidianExportResult {
  memoriesExported: number;
  entitiesExported: number;
  goalsExported: number;
  contradictionsExported: number;
  dashboardUpdated: boolean;
}

interface SyncState {
  last_sync: string;
}

interface MilestoneRecord {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed";
  order: number;
  deadline: string | null;
  completed_at: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(text: string, maxLen = 60): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen);
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function dateOnly(iso: string): string {
  return iso.slice(0, 10);
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function yamlEscape(val: string): string {
  if (/[:\[\]{}&*?|>!%#@`,]/.test(val) || val.includes('"') || val.includes("'")) {
    return `"${val.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return `"${val}"`;
}

function yamlList(items: string[]): string {
  return `[${items.map(yamlEscape).join(", ")}]`;
}

/** Build a filename for a memory: `<short-id>-<slug>.md` */
function memoryFilename(id: string, content: string): string {
  const preview = content.replace(/^#+\s*/, "").slice(0, 80);
  return `${shortId(id)}-${slugify(preview)}.md`;
}

/** Build a wikilink path for a memory */
function memoryWikilink(id: string, content: string): string {
  const name = memoryFilename(id, content).replace(/\.md$/, "");
  return `[[Memories/${name}]]`;
}

/** Build a wikilink path for an entity */
function entityWikilink(type: string, name: string): string {
  const folder = capitalize(type);
  return `[[Entities/${folder}/${name}]]`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

function readState(vaultPath: string): SyncState | null {
  const statePath = path.join(vaultPath, ".obsidian-sync-state.json");
  if (!fs.existsSync(statePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf-8"));
  } catch {
    return null;
  }
}

function writeState(vaultPath: string): void {
  const statePath = path.join(vaultPath, ".obsidian-sync-state.json");
  const state: SyncState = {
    last_sync: new Date().toISOString(),
  };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Exporters
// ---------------------------------------------------------------------------

function exportMemories(
  data: BackupData,
  valenceMap: Map<string, number>,
  entityLookup: Map<string, { type: string; name: string }>,
  memoryEntityMap: Map<string, string[]>,
  memoryLinkMap: Map<string, string[]>,
  memoryContentMap: Map<string, string>,
  vaultPath: string,
  since: string | null,
): number {
  const dir = path.join(vaultPath, "Memories");
  let count = 0;

  for (const mem of data.memories) {
    // Skip metadata and archived memories
    if (mem.is_metadata) continue;
    if (!mem.is_active) continue;

    // Incremental: skip if not updated since last sync
    if (since && mem.updated_at <= since) continue;

    ensureDir(dir);

    const filename = memoryFilename(mem.id, mem.content);
    const entityIds = memoryEntityMap.get(mem.id) ?? [];
    const entityLinks = entityIds
      .map((eid) => entityLookup.get(eid))
      .filter(Boolean)
      .map((e) => entityWikilink(e!.type, e!.name));

    const linkedMemIds = memoryLinkMap.get(mem.id) ?? [];
    const linkedMemLinks = linkedMemIds
      .map((mid) => {
        const content = memoryContentMap.get(mid);
        if (!content) return null;
        return memoryWikilink(mid, content);
      })
      .filter(Boolean) as string[];

    const valence = valenceMap.get(mem.id) ?? 0;

    // Build frontmatter
    const fm: string[] = ["---"];
    fm.push(`id: ${yamlEscape(mem.id)}`);
    fm.push(`type: ${mem.content_type}`);
    fm.push(`importance: ${mem.importance}`);
    fm.push(`valence: ${valence}`);
    if (mem.tags.length > 0) fm.push(`tags: ${yamlList(mem.tags)}`);
    fm.push(`created: ${dateOnly(mem.created_at)}`);
    fm.push(`updated: ${dateOnly(mem.updated_at)}`);
    if (entityLinks.length > 0) {
      fm.push(`entities: ${yamlList(entityLinks)}`);
    }
    if (linkedMemLinks.length > 0) {
      fm.push(`linked_memories: ${yamlList(linkedMemLinks)}`);
    }
    fm.push("---");
    fm.push("");
    fm.push(mem.content);

    fs.writeFileSync(path.join(dir, filename), fm.join("\n"), "utf-8");
    count++;
  }

  return count;
}

function exportEntities(
  data: BackupData,
  entityMemoryMap: Map<string, string[]>,
  memoryContentMap: Map<string, string>,
  entityRelMap: Map<string, Array<{ relationship: string; targetId: string }>>,
  entityLookup: Map<string, { type: string; name: string }>,
  vaultPath: string,
  since: string | null,
): number {
  let count = 0;

  for (const entity of data.entities) {
    if (since && entity.updated_at <= since) continue;

    const folder = capitalize(entity.type);
    const dir = path.join(vaultPath, "Entities", folder);
    ensureDir(dir);

    const fm: string[] = ["---"];
    fm.push(`id: ${yamlEscape(entity.id)}`);
    fm.push(`type: ${entity.type}`);
    if (entity.aliases && entity.aliases.length > 0) {
      fm.push(`aliases: ${yamlList(entity.aliases)}`);
    }
    if (entity.tags && entity.tags.length > 0) {
      fm.push(`tags: ${yamlList(entity.tags)}`);
    }
    fm.push(`created: ${dateOnly(entity.created_at)}`);
    fm.push("---");
    fm.push("");

    // Relationships
    const rels = entityRelMap.get(entity.id) ?? [];
    if (rels.length > 0) {
      fm.push("## Relationships");
      for (const rel of rels) {
        const target = entityLookup.get(rel.targetId);
        if (target) {
          fm.push(`- ${rel.relationship} → ${entityWikilink(target.type, target.name)}`);
        }
      }
      fm.push("");
    }

    // Linked Memories
    const memIds = entityMemoryMap.get(entity.id) ?? [];
    if (memIds.length > 0) {
      fm.push("## Linked Memories");
      for (const mid of memIds) {
        const content = memoryContentMap.get(mid);
        if (content) {
          fm.push(`- ${memoryWikilink(mid, content)}`);
        }
      }
      fm.push("");
    }

    // Sanitize entity name for filename (some names have / or other chars)
    const safeName = entity.name.replace(/[<>:"/\\|?*]/g, "_");
    fs.writeFileSync(path.join(dir, `${safeName}.md`), fm.join("\n"), "utf-8");
    count++;
  }

  return count;
}

function exportGoals(
  data: BackupData,
  vaultPath: string,
  since: string | null,
): number {
  if (!data.goals || data.goals.length === 0) return 0;

  const dir = path.join(vaultPath, "Goals");
  let count = 0;

  for (const goal of data.goals) {
    if (since && goal.updated_at <= since) continue;

    ensureDir(dir);

    const milestones: MilestoneRecord[] =
      (goal.metadata?.milestones as MilestoneRecord[]) ?? [];

    const fm: string[] = ["---"];
    fm.push(`id: ${yamlEscape(goal.id)}`);
    fm.push(`status: ${goal.status}`);
    fm.push(`priority: ${goal.priority}`);
    if (goal.deadline) fm.push(`deadline: ${dateOnly(goal.deadline)}`);
    fm.push(`created: ${dateOnly(goal.created_at)}`);
    fm.push("---");
    fm.push("");

    if (milestones.length > 0) {
      fm.push("## Milestones");
      const sorted = [...milestones].sort((a, b) => a.order - b.order);
      for (const ms of sorted) {
        const check = ms.status === "completed" ? "x" : " ";
        fm.push(`- [${check}] ${ms.title}`);
      }
      fm.push("");
    }

    if (goal.description) {
      fm.push("## Description");
      fm.push(goal.description);
      fm.push("");
    }

    const slug = slugify(goal.title);
    fs.writeFileSync(path.join(dir, `${slug}.md`), fm.join("\n"), "utf-8");
    count++;
  }

  return count;
}

function exportContradictions(
  data: BackupData,
  memoryContentMap: Map<string, string>,
  vaultPath: string,
  since: string | null,
): number {
  if (!data.contradictions || data.contradictions.length === 0) return 0;

  const dir = path.join(vaultPath, "Contradictions");
  let count = 0;

  for (const c of data.contradictions) {
    if (since && c.updated_at <= since) continue;

    ensureDir(dir);

    const fm: string[] = ["---"];
    fm.push(`id: ${yamlEscape(c.id)}`);
    fm.push(`status: ${c.status}`);
    const memAContent = memoryContentMap.get(c.memory_a_id);
    const memBContent = memoryContentMap.get(c.memory_b_id);
    if (memAContent) {
      fm.push(`memory_a: ${yamlEscape(memoryWikilink(c.memory_a_id, memAContent))}`);
    }
    if (memBContent) {
      fm.push(`memory_b: ${yamlEscape(memoryWikilink(c.memory_b_id, memBContent))}`);
    }
    fm.push(`created: ${dateOnly(c.created_at)}`);
    fm.push("---");
    fm.push("");
    fm.push(c.description);
    if (c.resolution) {
      fm.push("");
      fm.push("## Resolution");
      fm.push(c.resolution);
    }
    fm.push("");

    fs.writeFileSync(path.join(dir, `${shortId(c.id)}.md`), fm.join("\n"), "utf-8");
    count++;
  }

  return count;
}

function writeDashboard(vaultPath: string): void {
  const content = `# Exocortex Dashboard

## Recent Memories
\`\`\`dataview
TABLE importance, type, tags
FROM "Memories"
SORT updated DESC
LIMIT 20
\`\`\`

## Active Goals
\`\`\`dataview
TABLE status, priority, deadline
FROM "Goals"
WHERE status = "active"
\`\`\`

## Entities by Type
\`\`\`dataview
TABLE type, aliases
FROM "Entities"
SORT type, file.name
\`\`\`

## Open Contradictions
\`\`\`dataview
TABLE status, memory_a, memory_b
FROM "Contradictions"
WHERE status = "pending"
SORT created DESC
\`\`\`
`;
  fs.writeFileSync(path.join(vaultPath, "_Dashboard.md"), content, "utf-8");
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function exportToObsidian(
  db: DatabaseSync,
  opts: ObsidianExportOptions,
): Promise<ObsidianExportResult> {
  const { vaultPath, fullExport } = opts;

  // Read sync state
  const state = fullExport ? null : readState(vaultPath);
  const since = state?.last_sync ?? null;

  // Ensure vault root exists
  ensureDir(vaultPath);

  // Get all data from backup module
  const data = exportData(db);

  // Query valence separately (not in BackupData)
  const valenceRows = db
    .prepare("SELECT id, valence FROM memories")
    .all() as Array<{ id: string; valence: number }>;
  const valenceMap = new Map(valenceRows.map((r) => [r.id, r.valence]));

  // Build lookup maps
  const entityLookup = new Map<string, { type: string; name: string }>();
  for (const e of data.entities) {
    entityLookup.set(e.id, { type: e.type, name: e.name });
  }

  // Memory content map (for wikilink resolution)
  const memoryContentMap = new Map<string, string>();
  for (const m of data.memories) {
    memoryContentMap.set(m.id, m.content);
  }

  // Memory → entity IDs
  const memoryEntityMap = new Map<string, string[]>();
  for (const me of data.memory_entities) {
    const arr = memoryEntityMap.get(me.memory_id) ?? [];
    arr.push(me.entity_id);
    memoryEntityMap.set(me.memory_id, arr);
  }

  // Entity → memory IDs (reverse)
  const entityMemoryMap = new Map<string, string[]>();
  for (const me of data.memory_entities) {
    const arr = entityMemoryMap.get(me.entity_id) ?? [];
    arr.push(me.memory_id);
    entityMemoryMap.set(me.entity_id, arr);
  }

  // Memory → linked memory IDs (bidirectional)
  const memoryLinkMap = new Map<string, string[]>();
  if (data.memory_links) {
    for (const link of data.memory_links) {
      const fwd = memoryLinkMap.get(link.source_id) ?? [];
      fwd.push(link.target_id);
      memoryLinkMap.set(link.source_id, fwd);

      const rev = memoryLinkMap.get(link.target_id) ?? [];
      rev.push(link.source_id);
      memoryLinkMap.set(link.target_id, rev);
    }
  }

  // Entity → outgoing relationships
  const entityRelMap = new Map<string, Array<{ relationship: string; targetId: string }>>();
  if (data.entity_relationships) {
    for (const rel of data.entity_relationships) {
      const arr = entityRelMap.get(rel.source_entity_id) ?? [];
      arr.push({ relationship: rel.relationship, targetId: rel.target_entity_id });
      entityRelMap.set(rel.source_entity_id, arr);
    }
  }

  // Export each section
  const memoriesExported = exportMemories(
    data, valenceMap, entityLookup, memoryEntityMap, memoryLinkMap,
    memoryContentMap, vaultPath, since,
  );

  const entitiesExported = exportEntities(
    data, entityMemoryMap, memoryContentMap, entityRelMap,
    entityLookup, vaultPath, since,
  );

  const goalsExported = exportGoals(data, vaultPath, since);

  const contradictionsExported = exportContradictions(
    data, memoryContentMap, vaultPath, since,
  );

  // Always regenerate dashboard
  writeDashboard(vaultPath);

  // Write sync state
  writeState(vaultPath);

  return {
    memoriesExported,
    entitiesExported,
    goalsExported,
    contradictionsExported,
    dashboardUpdated: true,
  };
}
