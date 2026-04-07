/**
 * Hierarchical navigation — MemPalace-style spatial structure over flat memories.
 *
 * Maps exocortex data into a navigable hierarchy:
 *   Wing  = namespace (project)
 *   Hall  = memory category (decisions, techniques, events, etc.)
 *   Room  = entity or topic cluster within a wing
 *   Closet = compressed summary of room contents
 *
 * This structure gives agents a spatial map to narrow search scope
 * before issuing semantic queries — the same principle that gives
 * MemPalace a 34% retrieval boost from structure alone.
 */

import type { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Palace {
  wings: Wing[];
  tunnels: Tunnel[];
  stats: PalaceStats;
}

export interface Wing {
  name: string;
  memoryCount: number;
  halls: Hall[];
  rooms: Room[];
}

export interface Hall {
  name: string;
  memoryCount: number;
}

export interface Room {
  name: string;
  memoryCount: number;
  closet: string; // compressed summary
}

export interface Tunnel {
  entity: string;
  wings: string[];
}

export interface PalaceStats {
  totalMemories: number;
  totalWings: number;
  totalRooms: number;
  totalTunnels: number;
}

// ---------------------------------------------------------------------------
// Hall definitions — canonical memory categories (like MemPalace halls)
// ---------------------------------------------------------------------------

const HALL_DEFINITIONS: Record<string, { tags: string[]; keywords: string[] }> = {
  facts: {
    tags: ["decision", "architecture", "config", "schema"],
    keywords: ["decided", "chose", "switched to", "migrated"],
  },
  events: {
    tags: ["session-summary", "milestone", "deployment", "release"],
    keywords: ["deployed", "shipped", "released", "completed"],
  },
  discoveries: {
    tags: ["discovery", "research", "proactive-insight", "investigation"],
    keywords: ["found that", "discovered", "learned", "realized"],
  },
  techniques: {
    tags: ["technique", "skill", "learning", "how-to", "procedural"],
    keywords: ["SKILL:", "TRIGGER:", "PROCEDURE:"],
  },
  preferences: {
    tags: ["preference", "style", "convention"],
    keywords: ["prefer", "always use", "avoid", "convention"],
  },
};

function classifyHall(tags: string[], content: string): string {
  const tagSet = new Set(tags.map((t) => t.toLowerCase()));
  const contentLower = content.toLowerCase();

  for (const [hall, def] of Object.entries(HALL_DEFINITIONS)) {
    if (def.tags.some((t) => tagSet.has(t))) return hall;
    if (def.keywords.some((k) => contentLower.includes(k.toLowerCase()))) return hall;
  }
  return "notes";
}

// ---------------------------------------------------------------------------
// Build palace from database
// ---------------------------------------------------------------------------

export function buildPalace(db: DatabaseSync): Palace {
  // 1. Get all wings (namespaces + unscoped)
  const nsRows = db
    .prepare(
      `SELECT COALESCE(namespace, '') as ns, COUNT(*) as cnt
       FROM memories WHERE is_active = 1 AND parent_id IS NULL AND length(content) > 50
       GROUP BY ns ORDER BY cnt DESC`
    )
    .all() as unknown as Array<{ ns: string; cnt: number }>;

  // 2. Get entity→namespace mapping for tunnels
  const entityNsRows = db
    .prepare(
      `SELECT DISTINCT e.name as entity, m.namespace
       FROM entities e
       INNER JOIN memory_entities me ON e.id = me.entity_id
       INNER JOIN memories m ON me.memory_id = m.id
       WHERE m.is_active = 1 AND m.namespace IS NOT NULL AND m.namespace != ''`
    )
    .all() as unknown as Array<{ entity: string; namespace: string }>;

  const entityWings = new Map<string, Set<string>>();
  for (const r of entityNsRows) {
    const set = entityWings.get(r.entity) ?? new Set();
    set.add(r.namespace);
    entityWings.set(r.entity, set);
  }

  // 3. Build wings
  const wings: Wing[] = [];

  for (const nsRow of nsRows) {
    const wingName = nsRow.ns || "general";
    const isGeneral = !nsRow.ns;

    // Get memories for this wing
    const memories = isGeneral
      ? db.prepare(
          `SELECT m.id, m.content, m.importance,
                  COALESCE((SELECT GROUP_CONCAT(t.tag, ',') FROM memory_tags t WHERE t.memory_id = m.id), '') as tags
           FROM memories m
           WHERE (m.namespace IS NULL OR m.namespace = '') AND m.is_active = 1 AND m.parent_id IS NULL AND length(m.content) > 50
           ORDER BY m.importance DESC LIMIT 200`
        ).all() as unknown as Array<{ id: string; content: string; importance: number; tags: string }>
      : db.prepare(
          `SELECT m.id, m.content, m.importance,
                  COALESCE((SELECT GROUP_CONCAT(t.tag, ',') FROM memory_tags t WHERE t.memory_id = m.id), '') as tags
           FROM memories m
           WHERE m.namespace = ? AND m.is_active = 1 AND m.parent_id IS NULL AND length(m.content) > 50
           ORDER BY m.importance DESC LIMIT 200`
        ).all(nsRow.ns) as unknown as Array<{ id: string; content: string; importance: number; tags: string }>;

    // Classify into halls
    const hallCounts = new Map<string, number>();
    for (const m of memories) {
      const hall = classifyHall(m.tags.split(","), m.content);
      hallCounts.set(hall, (hallCounts.get(hall) ?? 0) + 1);
    }

    const halls: Hall[] = [...hallCounts.entries()]
      .map(([name, count]) => ({ name, memoryCount: count }))
      .sort((a, b) => b.memoryCount - a.memoryCount);

    // Get rooms (entities linked to this wing's memories)
    const memIds = memories.map((m) => m.id);
    const rooms: Room[] = [];
    if (memIds.length > 0) {
      const placeholders = memIds.slice(0, 100).map(() => "?").join(",");
      const entityRows = db
        .prepare(
          `SELECT e.name, COUNT(DISTINCT me.memory_id) as cnt
           FROM entities e
           INNER JOIN memory_entities me ON e.id = me.entity_id
           WHERE me.memory_id IN (${placeholders})
           GROUP BY e.name
           ORDER BY cnt DESC
           LIMIT 15`
        )
        .all(...memIds.slice(0, 100)) as unknown as Array<{ name: string; cnt: number }>;

      for (const er of entityRows) {
        // Build closet (compressed summary) from top memories mentioning this entity
        const topContent = db
          .prepare(
            `SELECT m.content FROM memories m
             INNER JOIN memory_entities me ON m.id = me.memory_id
             INNER JOIN entities e ON me.entity_id = e.id
             WHERE e.name = ? AND m.is_active = 1 AND m.parent_id IS NULL
             ORDER BY m.importance DESC LIMIT 3`
          )
          .all(er.name) as unknown as Array<{ content: string }>;

        const closet = topContent
          .map((m) => m.content.split("\n")[0].slice(0, 100))
          .join(" | ");

        rooms.push({ name: er.name, memoryCount: er.cnt, closet });
      }
    }

    wings.push({
      name: wingName,
      memoryCount: nsRow.cnt,
      halls,
      rooms,
    });
  }

  // 4. Build tunnels — entities that span multiple wings
  const tunnels: Tunnel[] = [];
  for (const [entity, wingSet] of entityWings) {
    if (wingSet.size >= 2) {
      tunnels.push({ entity, wings: [...wingSet].sort() });
    }
  }
  tunnels.sort((a, b) => b.wings.length - a.wings.length);

  return {
    wings,
    tunnels: tunnels.slice(0, 30),
    stats: {
      totalMemories: nsRows.reduce((s, r) => s + r.cnt, 0),
      totalWings: wings.length,
      totalRooms: wings.reduce((s, w) => s + w.rooms.length, 0),
      totalTunnels: tunnels.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Compact palace representation (AAAK-inspired compression)
// ---------------------------------------------------------------------------

export function compactPalace(palace: Palace): string {
  const lines: string[] = [];

  lines.push(`PALACE: ${palace.stats.totalWings}W ${palace.stats.totalRooms}R ${palace.stats.totalTunnels}T | ${palace.stats.totalMemories} memories`);
  lines.push("");

  for (const wing of palace.wings.slice(0, 15)) {
    const hallStr = wing.halls.map((h) => `${h.name}:${h.memoryCount}`).join(" ");
    lines.push(`WING:${wing.name.toUpperCase()}(${wing.memoryCount}) | ${hallStr}`);

    if (wing.rooms.length > 0) {
      const roomStr = wing.rooms
        .slice(0, 8)
        .map((r) => `${r.name}(${r.memoryCount})`)
        .join(", ");
      lines.push(`  ROOMS: ${roomStr}`);
    }
  }

  if (palace.tunnels.length > 0) {
    lines.push("");
    lines.push("TUNNELS:");
    for (const t of palace.tunnels.slice(0, 10)) {
      lines.push(`  ${t.entity} ↔ ${t.wings.join(", ")}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Compressed wake-up context (AAAK-style)
// ---------------------------------------------------------------------------

export function buildWakeUpContext(db: DatabaseSync): string {
  const lines: string[] = [];

  // L0: Identity
  const soul = db
    .prepare(
      `SELECT content FROM memories
       WHERE is_active = 1 AND content LIKE '%Core Identity%'
       AND content LIKE '%persistent%evolving%'
       ORDER BY importance DESC LIMIT 1`
    )
    .get() as { content: string } | undefined;

  if (soul) {
    // Extract key identity traits
    const traits = soul.content.match(/(?:Direct|Calm|Strategic|Self-improving)/g) ?? [];
    lines.push(`ID: persistent AI collaborator | ${traits.join(", ")}`);
  }

  // L1: Critical facts — projects, stack, goals
  const projects = db
    .prepare(
      `SELECT namespace, COUNT(*) as cnt FROM memories
       WHERE is_active = 1 AND namespace IS NOT NULL AND namespace != ''
       GROUP BY namespace ORDER BY cnt DESC LIMIT 8`
    )
    .all() as unknown as Array<{ namespace: string; cnt: number }>;

  if (projects.length > 0) {
    lines.push(`PROJ: ${projects.map((p) => `${p.namespace.toUpperCase()}(${p.cnt})`).join(" ")}`);
  }

  // Active goals
  const goals = db
    .prepare(
      `SELECT title, status, priority FROM goals
       WHERE status = 'active'
       ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END
       LIMIT 5`
    )
    .all() as unknown as Array<{ title: string; status: string; priority: string }>;

  if (goals.length > 0) {
    lines.push(`GOALS: ${goals.map((g) => `${g.title.slice(0, 40)}[${g.priority[0]}]`).join(" | ")}`);
  }

  // Recent decisions (last 14 days)
  const decisions = db
    .prepare(
      `SELECT m.content FROM memories m
       INNER JOIN memory_tags t ON t.memory_id = m.id
       WHERE t.tag = 'decision' AND m.is_active = 1
       AND m.created_at >= datetime('now', '-14 days')
       ORDER BY m.importance DESC LIMIT 3`
    )
    .all() as unknown as Array<{ content: string }>;

  if (decisions.length > 0) {
    lines.push("RECENT:");
    for (const d of decisions) {
      const summary = d.content.split("\n")[0].slice(0, 80);
      lines.push(`  ${summary}`);
    }
  }

  // Top techniques
  const techniques = db
    .prepare(
      `SELECT m.content FROM memories m
       WHERE m.is_active = 1 AND m.tier = 'procedural'
       ORDER BY m.useful_count DESC, m.importance DESC LIMIT 3`
    )
    .all() as unknown as Array<{ content: string }>;

  if (techniques.length > 0) {
    lines.push("TECHNIQUES:");
    for (const t of techniques) {
      const name = t.content.match(/SKILL:\s*(.+)/)?.[1] ?? t.content.split("\n")[0].slice(0, 60);
      lines.push(`  ${name}`);
    }
  }

  // Palace overview (abbreviated — top 5 wings only)
  const palace = buildPalace(db);
  lines.push("");
  lines.push(`PALACE: ${palace.stats.totalWings}W ${palace.stats.totalRooms}R ${palace.stats.totalTunnels}T | ${palace.stats.totalMemories} mem`);
  for (const w of palace.wings.slice(0, 5)) {
    const halls = w.halls.slice(0, 3).map((h) => `${h.name}:${h.memoryCount}`).join(" ");
    const rooms = w.rooms.slice(0, 4).map((r) => r.name).join(",");
    lines.push(`  ${w.name.toUpperCase()}(${w.memoryCount}) ${halls}${rooms ? " | " + rooms : ""}`);
  }
  if (palace.tunnels.length > 0) {
    const topTunnels = palace.tunnels.slice(0, 5).map((t) => `${t.entity}↔${t.wings.length}W`).join(" ");
    lines.push(`  TUNNELS: ${topTunnels}`);
  }

  return lines.join("\n");
}
