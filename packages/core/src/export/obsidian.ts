import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ObsidianExportOptions {
  vaultPath: string;
  clean?: boolean;
}

export interface ObsidianExportResult {
  files: number;
  sections: Record<string, number>;
}

interface MemoryRow {
  id: string;
  content: string;
  created_at: string;
  importance: number;
}

interface GoalRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  deadline: string | null;
  metadata: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function slugify(text: string, maxLen = 80): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen);
}

function urlToTitle(url: string): string {
  try {
    const u = new URL(url);
    const pathParts = u.pathname.split("/").filter(Boolean);
    if (pathParts.length > 0) {
      const last = pathParts[pathParts.length - 1];
      return `${u.hostname} - ${last.replace(/[-_]/g, " ")}`;
    }
    return u.hostname;
  } catch {
    return url.slice(0, 60);
  }
}

function cleanVault(vaultPath: string): void {
  if (!fs.existsSync(vaultPath)) return;

  const entries = fs.readdirSync(vaultPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(vaultPath, entry.name);
    // Preserve Obsidian config
    if (entry.name === ".obsidian") continue;

    if (entry.isDirectory()) {
      fs.rmSync(fullPath, { recursive: true, force: true });
    } else if (entry.name.endsWith(".md") || entry.name.endsWith(".json")) {
      fs.unlinkSync(fullPath);
    }
  }
}

function writeFile(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf-8");
}

// ---------------------------------------------------------------------------
// Section exporters
// ---------------------------------------------------------------------------

function exportSoulIdentity(
  db: DatabaseSync,
  vaultPath: string,
  sections: Record<string, number>,
): void {
  for (const tag of ["soul", "identity"]) {
    const row = db
      .prepare(
        `SELECT m.content
         FROM memories m
         JOIN memory_tags mt ON m.id = mt.memory_id
         WHERE mt.tag = ? AND m.is_active = 1 AND m.parent_id IS NULL
         ORDER BY m.importance DESC, m.created_at DESC
         LIMIT 1`,
      )
      .get(tag) as { content: string } | undefined;

    if (row) {
      const filename = tag === "soul" ? "Soul.md" : "Identity.md";
      const title = tag === "soul" ? "Soul" : "Identity";
      const content = row.content.startsWith("#")
        ? row.content
        : `# ${title}\n\n${row.content}`;
      writeFile(path.join(vaultPath, filename), content);
      sections[tag] = 1;
    }
  }
}

function exportGoals(
  db: DatabaseSync,
  vaultPath: string,
  sections: Record<string, number>,
): void {
  const goals = db
    .prepare(
      `SELECT id, title, description, status, priority, deadline, metadata, created_at
       FROM goals
       WHERE status IN ('active', 'paused')
       ORDER BY
         CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
         created_at DESC`,
    )
    .all() as unknown as GoalRow[];

  if (goals.length === 0) return;

  const lines: string[] = ["# Goals\n"];

  for (const goal of goals) {
    lines.push(`## ${goal.title}`);
    lines.push(
      `**Status:** ${goal.status} | **Priority:** ${goal.priority}${goal.deadline ? ` | **Deadline:** ${goal.deadline.slice(0, 10)}` : ""}`,
    );
    lines.push("");

    if (goal.description) {
      lines.push(goal.description);
      lines.push("");
    }

    if (goal.metadata) {
      try {
        const meta = JSON.parse(goal.metadata);
        const milestones = meta.milestones as
          | Array<{ title: string; status: string; order: number }>
          | undefined;
        if (milestones && milestones.length > 0) {
          lines.push("### Milestones");
          const sorted = [...milestones].sort((a, b) => a.order - b.order);
          for (const ms of sorted) {
            const check = ms.status === "completed" ? "x" : " ";
            lines.push(`- [${check}] ${ms.title}`);
          }
          lines.push("");
        }
      } catch {
        // ignore malformed metadata
      }
    }

    lines.push("---\n");
  }

  writeFile(path.join(vaultPath, "Goals.md"), lines.join("\n"));
  sections.goals = goals.length;
}

function exportDecisions(
  db: DatabaseSync,
  vaultPath: string,
  sections: Record<string, number>,
): void {
  const decisions = db
    .prepare(
      `SELECT DISTINCT m.id, m.content, m.created_at, m.importance
       FROM memories m
       JOIN memory_tags mt ON m.id = mt.memory_id
       WHERE mt.tag = 'decision' AND m.is_active = 1
       ORDER BY m.created_at DESC`,
    )
    .all() as unknown as MemoryRow[];

  if (decisions.length === 0) return;

  const dir = path.join(vaultPath, "Decisions");

  // Group by month
  const byMonth = new Map<string, MemoryRow[]>();
  for (const d of decisions) {
    const month = d.created_at.slice(0, 7);
    const arr = byMonth.get(month) ?? [];
    arr.push(d);
    byMonth.set(month, arr);
  }

  let fileCount = 0;
  for (const [month, decs] of byMonth) {
    const lines: string[] = [`# Decisions - ${month}\n`];
    for (const d of decs) {
      const date = d.created_at.slice(0, 10);
      if (d.content.startsWith("#")) {
        lines.push(d.content);
      } else {
        lines.push(`## ${date}`);
        lines.push("");
        lines.push(d.content);
      }
      lines.push("\n---\n");
    }
    writeFile(path.join(dir, `${month}.md`), lines.join("\n"));
    fileCount++;
  }

  sections.decisions = fileCount;
}

function exportTechniques(
  db: DatabaseSync,
  vaultPath: string,
  sections: Record<string, number>,
): void {
  const techniques = db
    .prepare(
      `SELECT DISTINCT m.id, m.content, m.created_at, m.importance
       FROM memories m
       LEFT JOIN memory_tags mt ON m.id = mt.memory_id
       WHERE m.is_active = 1
         AND (m.tier = 'procedural' OR mt.tag IN ('technique', 'learning'))
       ORDER BY m.importance DESC, m.created_at DESC`,
    )
    .all() as unknown as MemoryRow[];

  if (techniques.length === 0) return;

  const lines: string[] = ["# Techniques & Learnings\n"];
  for (const t of techniques) {
    if (t.content.startsWith("#")) {
      lines.push(t.content);
    } else {
      const date = t.created_at.slice(0, 10);
      lines.push(`## ${date}`);
      lines.push("");
      lines.push(t.content);
    }
    lines.push("\n---\n");
  }

  writeFile(path.join(vaultPath, "Techniques.md"), lines.join("\n"));
  sections.techniques = techniques.length;
}

function exportKnowledge(
  db: DatabaseSync,
  vaultPath: string,
  sections: Record<string, number>,
): void {
  const semantics = db
    .prepare(
      `SELECT m.id, m.content, m.created_at, m.importance
       FROM memories m
       WHERE m.is_active = 1
         AND m.tier = 'semantic'
         AND m.parent_id IS NULL
       ORDER BY m.created_at DESC`,
    )
    .all() as unknown as MemoryRow[];

  if (semantics.length === 0) return;

  const dir = path.join(vaultPath, "Knowledge");

  // Group by topic extracted from consolidated summary header
  const byTopic = new Map<string, MemoryRow[]>();
  for (const m of semantics) {
    let topic = "general";
    const topicMatch = m.content.match(/Topics:\s*([^\]]+)\]/);
    if (topicMatch) {
      const topics = topicMatch[1].split(",").map((t) => t.trim());
      topic = topics[0] || "general";
    }
    const arr = byTopic.get(topic) ?? [];
    arr.push(m);
    byTopic.set(topic, arr);
  }

  let fileCount = 0;
  for (const [topic, memories] of byTopic) {
    const title = topic.charAt(0).toUpperCase() + topic.slice(1);
    const lines: string[] = [`# ${title}\n`];
    for (const m of memories) {
      lines.push(m.content);
      lines.push("\n---\n");
    }
    writeFile(path.join(dir, `${slugify(topic)}.md`), lines.join("\n"));
    fileCount++;
  }

  sections.knowledge = fileCount;
}

function exportReference(
  db: DatabaseSync,
  vaultPath: string,
  sections: Record<string, number>,
): void {
  const uris = db
    .prepare(
      `SELECT source_uri, COUNT(*) as chunk_count
       FROM memories
       WHERE is_active = 1 AND tier = 'reference' AND source_uri IS NOT NULL
       GROUP BY source_uri
       ORDER BY chunk_count DESC`,
    )
    .all() as unknown as Array<{ source_uri: string; chunk_count: number }>;

  if (uris.length === 0) return;

  const dir = path.join(vaultPath, "Reference");

  let fileCount = 0;
  for (const { source_uri } of uris) {
    const chunks = db
      .prepare(
        `SELECT content
         FROM memories
         WHERE is_active = 1 AND tier = 'reference' AND source_uri = ?
         ORDER BY created_at ASC`,
      )
      .all(source_uri) as unknown as Array<{ content: string }>;

    const title = urlToTitle(source_uri);
    const content = [`# ${title}\n`, `> Source: ${source_uri}\n`];

    for (const chunk of chunks) {
      content.push(chunk.content);
      content.push("");
    }

    writeFile(path.join(dir, `${slugify(title)}.md`), content.join("\n"));
    fileCount++;
  }

  sections.reference = fileCount;
}

function exportProjects(
  db: DatabaseSync,
  vaultPath: string,
  sections: Record<string, number>,
): void {
  const namespaces = db
    .prepare(
      `SELECT namespace, COUNT(*) as c
       FROM memories
       WHERE is_active = 1 AND namespace IS NOT NULL AND tier NOT IN ('reference', 'working')
       GROUP BY namespace
       ORDER BY c DESC`,
    )
    .all() as unknown as Array<{ namespace: string; c: number }>;

  if (namespaces.length === 0) return;

  const dir = path.join(vaultPath, "Projects");

  let fileCount = 0;
  for (const { namespace } of namespaces) {
    const memories = db
      .prepare(
        `SELECT content, created_at, importance
         FROM memories
         WHERE is_active = 1 AND namespace = ? AND tier NOT IN ('reference', 'working')
         ORDER BY importance DESC, created_at DESC
         LIMIT 100`,
      )
      .all(namespace) as unknown as Array<{
      content: string;
      created_at: string;
      importance: number;
    }>;

    const title = namespace.charAt(0).toUpperCase() + namespace.slice(1);
    const lines: string[] = [`# ${title}\n`];
    for (const m of memories) {
      if (m.content.startsWith("#")) {
        lines.push(m.content);
      } else {
        const date = m.created_at.slice(0, 10);
        lines.push(`## ${date}`);
        lines.push("");
        lines.push(m.content);
      }
      lines.push("\n---\n");
    }

    writeFile(path.join(dir, `${slugify(namespace)}.md`), lines.join("\n"));
    fileCount++;
  }

  sections.projects = fileCount;
}

function writeDashboard(vaultPath: string): void {
  const content = `# Exocortex

Personal knowledge base exported from [Exocortex](https://github.com/exocortex).

## Structure

- **Soul.md** - AI personality and behavioral directives
- **Identity.md** - User background and preferences
- **Goals.md** - Active goals with milestone tracking
- **Decisions/** - Architectural and strategic decisions by month
- **Techniques.md** - Procedural knowledge, techniques, and learnings
- **Knowledge/** - Consolidated semantic knowledge by topic
- **Reference/** - Ingested reference documents
- **Projects/** - Project-specific memories by namespace
`;
  writeFile(path.join(vaultPath, "_Index.md"), content);
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function exportToObsidian(
  db: DatabaseSync,
  opts: ObsidianExportOptions,
): Promise<ObsidianExportResult> {
  const { vaultPath, clean } = opts;

  if (clean) {
    cleanVault(vaultPath);
  }

  ensureDir(vaultPath);

  const sections: Record<string, number> = {};

  exportSoulIdentity(db, vaultPath, sections);
  exportGoals(db, vaultPath, sections);
  exportDecisions(db, vaultPath, sections);
  exportTechniques(db, vaultPath, sections);
  exportKnowledge(db, vaultPath, sections);
  exportReference(db, vaultPath, sections);
  exportProjects(db, vaultPath, sections);
  writeDashboard(vaultPath);

  const files = Object.values(sections).reduce((a, b) => a + b, 0) + 1; // +1 for _Index.md
  return { files, sections };
}
