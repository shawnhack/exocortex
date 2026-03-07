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

// Tracks all generated files for cross-linking
interface FileRegistry {
  // slug -> display title (e.g. "alpha-trade" -> "Alpha-trade")
  projects: Map<string, string>;
  knowledge: Map<string, string>;
  reference: Map<string, string>;
  decisions: Map<string, string>;
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

/** Build YAML frontmatter block */
function frontmatter(fields: Record<string, string | string[]>): string {
  const lines = ["---"];
  for (const [key, val] of Object.entries(fields)) {
    if (Array.isArray(val)) {
      if (val.length > 0) lines.push(`${key}: [${val.map((v) => `"${v}"`).join(", ")}]`);
    } else {
      lines.push(`${key}: "${val}"`);
    }
  }
  lines.push("---\n");
  return lines.join("\n");
}

/** Stitch chunks by detecting and removing overlapping text at boundaries */
function stitchChunks(chunks: string[]): string {
  if (chunks.length === 0) return "";
  const result = [chunks[0]];

  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1];
    const curr = chunks[i];

    // Find the longest suffix of prev that matches a prefix of curr
    // Check up to 500 chars for overlap
    const maxCheck = Math.min(prev.length, curr.length, 500);
    let overlapLen = 0;

    for (let len = 20; len <= maxCheck; len++) {
      const suffix = prev.slice(-len);
      if (curr.startsWith(suffix)) {
        overlapLen = len;
      }
    }

    if (overlapLen > 0) {
      result.push(curr.slice(overlapLen));
    } else {
      result.push(curr);
    }
  }

  return result.join("\n\n");
}

/** Clean web-scraped content: remove nav noise, dedup lines, collapse whitespace */
function cleanContent(text: string): string {
  const lines = text.split("\n");
  const cleaned: string[] = [];
  const seen = new Set<string>();
  let inCodeBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Track code blocks — don't filter inside them
    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      cleaned.push(line);
      continue;
    }
    if (inCodeBlock) {
      cleaned.push(line);
      continue;
    }

    // Skip empty lines if previous was also empty
    if (trimmed === "" && cleaned.length > 0 && cleaned[cleaned.length - 1].trim() === "") {
      continue;
    }

    // Skip common web noise patterns
    if (/^(Loading\.\.\.|Copy page|Skip to content|Table of Contents)$/i.test(trimmed)) continue;
    if (/^(Previous|Next|Was this helpful\??|Edit this page|Share this)$/i.test(trimmed)) continue;
    if (/Expand\s*Collapse/i.test(trimmed) && trimmed.length < 40) continue;
    if (/^(Written by|Trusted by|Last Updated|Updated)\s/i.test(trimmed) && seen.has(trimmed.toLowerCase())) continue;

    // Deduplicate all substantive lines (not just headings)
    if (trimmed.length > 20) {
      const key = trimmed.toLowerCase().replace(/\s+/g, " ");
      if (seen.has(key)) continue;
      seen.add(key);
    }

    // Deduplicate headings
    if (trimmed.startsWith("#")) {
      const heading = trimmed.replace(/^#+\s*/, "").toLowerCase().replace(/\s+/g, " ");
      if (seen.has(heading)) continue;
      seen.add(heading);
    }

    // Track author/date lines for dedup on repeat
    if (/^(Written by|Trusted by|Last Updated|Updated|Forex trader)\s/i.test(trimmed)) {
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
    }

    // Remove duplicate "Source: <url>" lines (we already have the blockquote)
    if (/^Source:\s*https?:\/\//i.test(trimmed)) continue;

    cleaned.push(line);
  }

  return cleaned.join("\n").replace(/\n{4,}/g, "\n\n\n").trim();
}

/** Get top tags for a set of memory IDs */
function getTagsForMemories(db: DatabaseSync, memoryIds: string[]): string[] {
  if (memoryIds.length === 0) return [];
  const placeholders = memoryIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT tag, COUNT(*) as c FROM memory_tags
       WHERE memory_id IN (${placeholders})
       GROUP BY tag ORDER BY c DESC LIMIT 10`,
    )
    .all(...memoryIds) as unknown as Array<{ tag: string; c: number }>;
  // Filter out noise tags
  const skip = new Set(["docs", "research", "technical", "time-to-live"]);
  return rows.map((r) => r.tag).filter((t) => !skip.has(t));
}

/** Generate See Also section with wikilinks to related files */
function seeAlso(tags: string[], registry: FileRegistry): string {
  const links: string[] = [];
  const tagSet = new Set(tags.map((t) => t.toLowerCase()));

  // Link to projects that match tags
  for (const [slug, title] of registry.projects) {
    if (tagSet.has(slug)) {
      links.push(`- [[Projects/${slug}|${title}]]`);
    }
  }

  // Link to knowledge topics that match tags
  for (const [slug, title] of registry.knowledge) {
    if (tagSet.has(slug)) {
      links.push(`- [[Knowledge/${slug}|${title}]]`);
    }
  }

  if (links.length === 0) return "";
  return `\n## See Also\n\n${links.join("\n")}\n`;
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
      const fm = frontmatter({ type: tag });
      const content = row.content.startsWith("#")
        ? row.content
        : `# ${title}\n\n${row.content}`;
      writeFile(path.join(vaultPath, filename), fm + content);
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

  const fm = frontmatter({ type: "goals", tags: ["goals", "tracking"] });
  const lines: string[] = [fm, "# Goals\n"];

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
  registry: FileRegistry,
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
    const ids = decs.map((d) => d.id);
    const tags = getTagsForMemories(db, ids);
    const fm = frontmatter({ type: "decisions", month, tags });
    const lines: string[] = [fm, `# Decisions - ${month}\n`];

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

    lines.push(seeAlso(tags, registry));

    registry.decisions.set(month, `Decisions ${month}`);
    writeFile(path.join(dir, `${month}.md`), lines.join("\n"));
    fileCount++;
  }

  sections.decisions = fileCount;
}

function exportTechniques(
  db: DatabaseSync,
  vaultPath: string,
  sections: Record<string, number>,
  registry: FileRegistry,
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

  const ids = techniques.map((t) => t.id);
  const tags = getTagsForMemories(db, ids);
  const fm = frontmatter({ type: "techniques", tags });
  const lines: string[] = [fm, "# Techniques & Learnings\n"];

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

  lines.push(seeAlso(tags, registry));

  writeFile(path.join(vaultPath, "Techniques.md"), lines.join("\n"));
  sections.techniques = techniques.length;
}

function exportKnowledge(
  db: DatabaseSync,
  vaultPath: string,
  sections: Record<string, number>,
  registry: FileRegistry,
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
    const ids = memories.map((m) => m.id);
    const tags = getTagsForMemories(db, ids);
    const fm = frontmatter({ type: "knowledge", topic, tags });
    const lines: string[] = [fm, `# ${title}\n`];

    for (const m of memories) {
      lines.push(m.content);
      lines.push("\n---\n");
    }

    // Cross-link to related projects
    lines.push(seeAlso([topic, ...tags], registry));

    const slug = slugify(topic);
    registry.knowledge.set(slug, title);
    writeFile(path.join(dir, `${slug}.md`), lines.join("\n"));
    fileCount++;
  }

  sections.knowledge = fileCount;
}

function exportReference(
  db: DatabaseSync,
  vaultPath: string,
  sections: Record<string, number>,
  registry: FileRegistry,
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
        `SELECT m.id, m.content
         FROM memories m
         WHERE m.is_active = 1 AND m.tier = 'reference' AND m.source_uri = ?
         ORDER BY m.created_at ASC`,
      )
      .all(source_uri) as unknown as Array<{ id: string; content: string }>;

    const title = urlToTitle(source_uri);
    const ids = chunks.map((c) => c.id);
    const tags = getTagsForMemories(db, ids);
    const fm = frontmatter({ type: "reference", source: source_uri, tags });

    // Stitch overlapping chunks, then clean
    const stitched = stitchChunks(chunks.map((c) => c.content));
    const cleaned = cleanContent(stitched);

    const content = [fm, `# ${title}\n`, `> Source: ${source_uri}\n`, cleaned];
    content.push(seeAlso(tags, registry));

    const slug = slugify(title);
    registry.reference.set(slug, title);
    writeFile(path.join(dir, `${slug}.md`), content.join("\n"));
    fileCount++;
  }

  sections.reference = fileCount;
}

function exportProjects(
  db: DatabaseSync,
  vaultPath: string,
  sections: Record<string, number>,
  registry: FileRegistry,
): void {
  // Get projects from both namespace AND tag-based matches
  const namespacedRows = db
    .prepare(
      `SELECT namespace as name FROM memories
       WHERE is_active = 1 AND namespace IS NOT NULL AND tier NOT IN ('reference', 'working')
       GROUP BY namespace`,
    )
    .all() as unknown as Array<{ name: string }>;

  const taggedRows = db
    .prepare(
      `SELECT DISTINCT mt.tag as name FROM memory_tags mt
       JOIN memories m ON m.id = mt.memory_id
       WHERE m.is_active = 1 AND m.tier NOT IN ('reference', 'working')
         AND mt.tag IN ('exocortex', 'substrate', 'nexus', 'alpha-trade', 'omnichat',
                        'bitcoin-horizon', 'claw-hive', 'claw-world', 'model-horizon',
                        'figma-ui-kit', 'prompt-library')`,
    )
    .all() as unknown as Array<{ name: string }>;

  // Merge unique project names
  const projectNames = new Set<string>();
  for (const r of namespacedRows) projectNames.add(r.name);
  for (const r of taggedRows) projectNames.add(r.name);

  if (projectNames.size === 0) return;

  const dir = path.join(vaultPath, "Projects");

  let fileCount = 0;
  for (const project of projectNames) {
    // Get memories by namespace OR tag, deduped
    const memories = db
      .prepare(
        `SELECT DISTINCT m.id, m.content, m.created_at, m.importance
         FROM memories m
         LEFT JOIN memory_tags mt ON m.id = mt.memory_id
         WHERE m.is_active = 1
           AND m.tier NOT IN ('reference', 'working')
           AND (m.namespace = ? OR mt.tag = ?)
         ORDER BY m.importance DESC, m.created_at DESC
         LIMIT 200`,
      )
      .all(project, project) as unknown as MemoryRow[];

    if (memories.length === 0) continue;

    const ids = memories.map((m) => m.id);
    const tags = getTagsForMemories(db, ids);
    const title = project.charAt(0).toUpperCase() + project.slice(1);
    const fm = frontmatter({ type: "project", project, tags });

    const lines: string[] = [fm, `# ${title}\n`];
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

    // Cross-link to knowledge and reference
    const relatedLinks: string[] = [];
    for (const [slug, refTitle] of registry.reference) {
      if (tags.some((t) => slug.includes(slugify(t)))) {
        relatedLinks.push(`- [[Reference/${slug}|${refTitle}]]`);
      }
    }
    for (const [slug, knTitle] of registry.knowledge) {
      if (tags.some((t) => slug.includes(slugify(t)))) {
        relatedLinks.push(`- [[Knowledge/${slug}|${knTitle}]]`);
      }
    }
    if (relatedLinks.length > 0) {
      lines.push(`\n## Related\n\n${relatedLinks.join("\n")}\n`);
    }

    const slug = slugify(project);
    registry.projects.set(slug, title);
    writeFile(path.join(dir, `${slug}.md`), lines.join("\n"));
    fileCount++;
  }

  sections.projects = fileCount;
}

function writeDashboard(vaultPath: string, registry: FileRegistry): void {
  const lines: string[] = [
    "# Exocortex\n",
    "Personal knowledge base.\n",
    "## Core\n",
    "- [[Soul]] - AI personality and behavioral directives",
    "- [[Identity]] - User background and preferences",
    "- [[Goals]] - Active goals with milestone tracking",
    "- [[Techniques]] - Procedural knowledge and learnings\n",
    "## Projects\n",
  ];

  for (const [slug, title] of registry.projects) {
    lines.push(`- [[Projects/${slug}|${title}]]`);
  }

  lines.push("\n## Knowledge\n");
  for (const [slug, title] of registry.knowledge) {
    lines.push(`- [[Knowledge/${slug}|${title}]]`);
  }

  lines.push("\n## Decisions\n");
  for (const [slug, title] of registry.decisions) {
    lines.push(`- [[Decisions/${slug}|${title}]]`);
  }

  lines.push("\n## Reference\n");
  for (const [slug, title] of registry.reference) {
    lines.push(`- [[Reference/${slug}|${title}]]`);
  }

  lines.push("");
  writeFile(path.join(vaultPath, "_Index.md"), lines.join("\n"));
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
  const registry: FileRegistry = {
    projects: new Map(),
    knowledge: new Map(),
    reference: new Map(),
    decisions: new Map(),
  };

  // Export order matters: projects first so other sections can link to them
  exportSoulIdentity(db, vaultPath, sections);
  exportGoals(db, vaultPath, sections);
  exportProjects(db, vaultPath, sections, registry);
  exportKnowledge(db, vaultPath, sections, registry);
  exportReference(db, vaultPath, sections, registry);
  exportDecisions(db, vaultPath, sections, registry);
  exportTechniques(db, vaultPath, sections, registry);
  writeDashboard(vaultPath, registry);

  const files = Object.values(sections).reduce((a, b) => a + b, 0) + 1; // +1 for _Index.md
  return { files, sections };
}
