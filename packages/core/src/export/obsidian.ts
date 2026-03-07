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

interface FileRegistry {
  projects: Map<string, string>;
  knowledge: Map<string, string>;
  reference: Map<string, string>;
  decisions: Map<string, string>;
  notes: Map<string, string>;
}

/** Detect project names from data: namespaces + CLAUDE.md snapshot names + known tags */
function detectProjects(db: DatabaseSync): Set<string> {
  const projects = new Set<string>();

  // 1. All namespaces are definitively projects
  const ns = db
    .prepare("SELECT DISTINCT namespace FROM memories WHERE is_active = 1 AND namespace IS NOT NULL")
    .all() as unknown as Array<{ namespace: string }>;
  for (const r of ns) projects.add(r.namespace);

  // 2. Extract project names from "CLAUDE.md project context" memories
  const snapshots = db
    .prepare(
      `SELECT content FROM memories
       WHERE is_active = 1 AND content LIKE '%CLAUDE.md project context%'`,
    )
    .all() as unknown as Array<{ content: string }>;
  for (const r of snapshots) {
    // Pattern: "ProjectName — CLAUDE.md project context:"
    const match = r.content.match(/^(.+?)\s*[—-]\s*CLAUDE\.md/m);
    if (match) projects.add(slugify(match[1].trim()));
  }

  // 3. Extract project names from CLAUDE.md snapshot content
  for (const r of snapshots) {
    const match = r.content.match(/^(.+?)\s*[—-]\s*CLAUDE\.md/m);
    if (match) {
      const name = slugify(match[1].trim());
      if (name.length > 2) projects.add(name);
    }
  }

  // 4. Tags with 10+ episodic memories that have session summary content
  //    (session summaries are always project-scoped)
  const freqTags = db
    .prepare(
      `SELECT mt.tag, COUNT(DISTINCT mt.memory_id) as c
       FROM memory_tags mt JOIN memories m ON m.id = mt.memory_id
       WHERE m.is_active = 1 AND m.tier = 'episodic'
       GROUP BY mt.tag HAVING c >= 10
       ORDER BY c DESC`,
    )
    .all() as unknown as Array<{ tag: string; c: number }>;

  // Common tech/meta terms that are never project names
  const techTerms = /^(typescript|react|react-query|node|pnpm|css|html|rust|go|python|javascript|vite|graphql|postgresql|redis|sqlite|tailwind|fastify|playwright|vitest|vercel|telegram|websocket|rest|monorepo|npm|embeddings|docker|git|linux|windows|aws|gcp|claude|anthropic|github|openai|trading|api|docs|security|testing|deployment|performance|refactor|summary|architecture|research|operations|llm|rag|dashboard|analytics|config|database|validation|product|navigation|notifications|session-summary|decision|technique|learning|soul|identity|goal-progress|goal-progress-implicit|quality-report|prompt-amendment|outcome|self-model|self-improvement|epoch|monthly-summary|check-in|memory-gardening|intelligence|intelligence-snapshot|exploration|project|project-overview|roadmap|plan|features|implementation|discovery|audit|code-review|code-analysis|code-structure|code-quality|competitive-analysis|complete-findings|reference|bug-analysis|bug-fix|bug-diagnosis|diagnosis|timeout|error-handling|dry-run|high-change|low-quality|save-behavior|edit-flow|data-flow|process-management|process-console|ui-features|async-race-condition|windows-pipes|locale-aware|multi-layered|co-retrieval|missed-query|knowledge-graph|obsidian|memory|memory-system|strategy|profitability|mathematics|risk-management|on-chain|memecoin|meme-coins|entry-timing|entry-gate|entry-pipeline|stop-loss|take-profit|nighttime-losses|time-of-day|trading-logic|trading-flow|broker|api-audit|soul-level|superpowers|yarn|next-js|hono|solid|gaps|document)$/;

  for (const r of freqTags) {
    if (projects.has(r.tag)) continue;
    if (techTerms.test(r.tag)) continue;
    // Must have session-summary-like content (strong project signal)
    const hasSession = db
      .prepare(
        `SELECT COUNT(*) as c FROM memories m JOIN memory_tags mt ON m.id = mt.memory_id
         WHERE mt.tag = ? AND m.is_active = 1
           AND (m.content LIKE '%Session Summary%' OR m.content LIKE '%CLAUDE.md%'
                OR m.content LIKE '%Key decisions%' OR m.content LIKE '%codebase%')`,
      )
      .get(r.tag) as { c: number };
    if (hasSession.c >= 1) {
      projects.add(r.tag);
      continue;
    }
    // Check if tag appears as a capitalized proper noun in its own memories
    // (e.g., "Terminus" in terminus-tagged content = project name)
    const capName = r.tag.split("-").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    const hasProperNoun = db
      .prepare(
        `SELECT COUNT(*) as c FROM memories m JOIN memory_tags mt ON m.id = mt.memory_id
         WHERE mt.tag = ? AND m.is_active = 1 AND m.content LIKE ?`,
      )
      .get(r.tag, `%${capName}%`) as { c: number };
    if (hasProperNoun.c >= 3) {
      projects.add(r.tag);
    }
  }

  return projects;
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

function titleCase(text: string): string {
  return text
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
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
    const maxCheck = Math.min(prev.length, curr.length, 500);
    let overlapLen = 0;
    for (let len = 20; len <= maxCheck; len++) {
      const suffix = prev.slice(-len);
      if (curr.startsWith(suffix)) overlapLen = len;
    }
    result.push(overlapLen > 0 ? curr.slice(overlapLen) : curr);
  }
  return result.join("\n\n");
}

/** Clean web-scraped content */
function cleanContent(text: string): string {
  const lines = text.split("\n");
  const cleaned: string[] = [];
  const seen = new Set<string>();
  let inCodeBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      cleaned.push(line);
      continue;
    }
    if (inCodeBlock) { cleaned.push(line); continue; }
    if (trimmed === "" && cleaned.length > 0 && cleaned[cleaned.length - 1].trim() === "") continue;
    if (/^(Loading\.\.\.|Copy page|Skip to content|Table of Contents)$/i.test(trimmed)) continue;
    if (/^(Previous|Next|Was this helpful\??|Edit this page|Share this)$/i.test(trimmed)) continue;
    if (/Expand\s*Collapse/i.test(trimmed) && trimmed.length < 40) continue;
    if (/^Source:\s*https?:\/\//i.test(trimmed)) continue;

    // Dedup substantive lines
    if (trimmed.length > 20) {
      const key = trimmed.toLowerCase().replace(/\s+/g, " ");
      if (seen.has(key)) continue;
      seen.add(key);
    }
    if (trimmed.startsWith("#")) {
      const heading = trimmed.replace(/^#+\s*/, "").toLowerCase().replace(/\s+/g, " ");
      if (seen.has(heading)) continue;
      seen.add(heading);
    }
    if (/^(Written by|Trusted by|Last Updated|Updated|Forex trader)\s/i.test(trimmed)) {
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
    }

    cleaned.push(line);
  }
  return cleaned.join("\n").replace(/\n{4,}/g, "\n\n\n").trim();
}

/** Get top tags for memory IDs */
function getTagsForIds(db: DatabaseSync, ids: string[]): string[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT tag, COUNT(*) as c FROM memory_tags WHERE memory_id IN (${placeholders}) GROUP BY tag ORDER BY c DESC LIMIT 10`)
    .all(...ids) as unknown as Array<{ tag: string; c: number }>;
  return rows.map((r) => r.tag);
}


/** Build See Also wikilinks */
function seeAlso(tags: string[], registry: FileRegistry): string {
  const links: string[] = [];
  const tagSet = new Set(tags.map((t) => t.toLowerCase()));

  for (const [slug, title] of registry.projects) {
    if (tagSet.has(slug)) links.push(`- [[Projects/${slug}|${title}]]`);
  }
  for (const [slug, title] of registry.knowledge) {
    if (tagSet.has(slug)) links.push(`- [[Knowledge/${slug}|${title}]]`);
  }
  for (const [slug, title] of registry.notes) {
    if (tagSet.has(slug)) links.push(`- [[Notes/${slug}|${title}]]`);
  }

  if (links.length === 0) return "";
  return `\n## See Also\n\n${links.join("\n")}\n`;
}

/** Render a list of memories as markdown sections */
function renderMemories(memories: MemoryRow[]): string {
  const lines: string[] = [];
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
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Section exporters
// ---------------------------------------------------------------------------

function exportSoulIdentity(
  db: DatabaseSync, vaultPath: string, sections: Record<string, number>, exported: Set<string>,
): void {
  for (const tag of ["soul", "identity"]) {
    const row = db
      .prepare(
        `SELECT m.id, m.content FROM memories m
         JOIN memory_tags mt ON m.id = mt.memory_id
         WHERE mt.tag = ? AND m.is_active = 1 AND m.parent_id IS NULL
         ORDER BY m.importance DESC, m.created_at DESC LIMIT 1`,
      )
      .get(tag) as { id: string; content: string } | undefined;

    if (row) {
      exported.add(row.id);
      const filename = tag === "soul" ? "Soul.md" : "Identity.md";
      const title = tag === "soul" ? "Soul" : "Identity";
      const fm = frontmatter({ type: tag });
      const content = row.content.startsWith("#") ? row.content : `# ${title}\n\n${row.content}`;
      writeFile(path.join(vaultPath, filename), fm + content);
      sections[tag] = 1;
    }
  }
}

function exportGoals(
  db: DatabaseSync, vaultPath: string, sections: Record<string, number>,
): void {
  const goals = db
    .prepare(
      `SELECT id, title, description, status, priority, deadline, metadata, created_at
       FROM goals WHERE status IN ('active', 'paused')
       ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
       created_at DESC`,
    )
    .all() as unknown as GoalRow[];

  if (goals.length === 0) return;

  const fm = frontmatter({ type: "goals", tags: ["goals"] });
  const lines: string[] = [fm, "# Goals\n"];

  for (const goal of goals) {
    lines.push(`## ${goal.title}`);
    lines.push(`**Status:** ${goal.status} | **Priority:** ${goal.priority}${goal.deadline ? ` | **Deadline:** ${goal.deadline.slice(0, 10)}` : ""}`);
    lines.push("");
    if (goal.description) { lines.push(goal.description); lines.push(""); }
    if (goal.metadata) {
      try {
        const meta = JSON.parse(goal.metadata);
        const milestones = meta.milestones as Array<{ title: string; status: string; order: number }> | undefined;
        if (milestones && milestones.length > 0) {
          lines.push("### Milestones");
          for (const ms of [...milestones].sort((a, b) => a.order - b.order)) {
            lines.push(`- [${ms.status === "completed" ? "x" : " "}] ${ms.title}`);
          }
          lines.push("");
        }
      } catch { /* ignore */ }
    }
    lines.push("---\n");
  }

  writeFile(path.join(vaultPath, "Goals.md"), lines.join("\n"));
  sections.goals = goals.length;
}

function exportProjects(
  db: DatabaseSync, vaultPath: string, sections: Record<string, number>,
  registry: FileRegistry, exported: Set<string>,
): void {
  const projectNames = detectProjects(db);
  if (projectNames.size === 0) return;

  const dir = path.join(vaultPath, "Projects");
  let fileCount = 0;

  for (const project of projectNames) {
    const memories = db
      .prepare(
        `SELECT DISTINCT m.id, m.content, m.created_at, m.importance
         FROM memories m LEFT JOIN memory_tags mt ON m.id = mt.memory_id
         WHERE m.is_active = 1 AND m.tier NOT IN ('reference', 'working')
           AND (m.namespace = ? OR mt.tag = ?)
         ORDER BY m.importance DESC, m.created_at DESC
         LIMIT 200`,
      )
      .all(project, project) as unknown as MemoryRow[];

    if (memories.length === 0) continue;

    for (const m of memories) exported.add(m.id);

    const ids = memories.map((m) => m.id);
    const tags = getTagsForIds(db, ids);
    const title = titleCase(project);
    const fm = frontmatter({ type: "project", project, tags });

    const content = [fm, `# ${title}\n`, renderMemories(memories)];

    const slug = slugify(project);
    registry.projects.set(slug, title);
    writeFile(path.join(dir, `${slug}.md`), content.join("\n"));
    fileCount++;
  }

  sections.projects = fileCount;
}

function exportDecisions(
  db: DatabaseSync, vaultPath: string, sections: Record<string, number>,
  registry: FileRegistry, exported: Set<string>,
): void {
  const decisions = db
    .prepare(
      `SELECT DISTINCT m.id, m.content, m.created_at, m.importance
       FROM memories m JOIN memory_tags mt ON m.id = mt.memory_id
       WHERE mt.tag = 'decision' AND m.is_active = 1
       ORDER BY m.created_at DESC`,
    )
    .all() as unknown as MemoryRow[];

  if (decisions.length === 0) return;

  const dir = path.join(vaultPath, "Decisions");
  const byMonth = new Map<string, MemoryRow[]>();
  for (const d of decisions) {
    const month = d.created_at.slice(0, 7);
    const arr = byMonth.get(month) ?? [];
    arr.push(d);
    byMonth.set(month, arr);
  }

  let fileCount = 0;
  for (const [month, decs] of byMonth) {
    for (const d of decs) exported.add(d.id);
    const ids = decs.map((d) => d.id);
    const tags = getTagsForIds(db, ids);
    const fm = frontmatter({ type: "decisions", month, tags });

    const content = [fm, `# Decisions - ${month}\n`, renderMemories(decs)];
    content.push(seeAlso(tags, registry));

    registry.decisions.set(month, `Decisions ${month}`);
    writeFile(path.join(dir, `${month}.md`), content.join("\n"));
    fileCount++;
  }

  sections.decisions = fileCount;
}

function exportTechniques(
  db: DatabaseSync, vaultPath: string, sections: Record<string, number>,
  registry: FileRegistry, exported: Set<string>,
): void {
  const techniques = db
    .prepare(
      `SELECT DISTINCT m.id, m.content, m.created_at, m.importance
       FROM memories m LEFT JOIN memory_tags mt ON m.id = mt.memory_id
       WHERE m.is_active = 1
         AND (m.tier = 'procedural' OR mt.tag IN ('technique', 'learning'))
       ORDER BY m.importance DESC, m.created_at DESC`,
    )
    .all() as unknown as MemoryRow[];

  if (techniques.length === 0) return;

  for (const t of techniques) exported.add(t.id);

  const ids = techniques.map((t) => t.id);
  const tags = getTagsForIds(db, ids);
  const fm = frontmatter({ type: "techniques", tags });

  const content = [fm, "# Techniques & Learnings\n", renderMemories(techniques)];
  content.push(seeAlso(tags, registry));

  writeFile(path.join(vaultPath, "Techniques.md"), content.join("\n"));
  sections.techniques = techniques.length;
}

function exportKnowledge(
  db: DatabaseSync, vaultPath: string, sections: Record<string, number>,
  registry: FileRegistry, exported: Set<string>,
): void {
  const semantics = db
    .prepare(
      `SELECT m.id, m.content, m.created_at, m.importance
       FROM memories m WHERE m.is_active = 1 AND m.tier = 'semantic' AND m.parent_id IS NULL
       ORDER BY m.created_at DESC`,
    )
    .all() as unknown as MemoryRow[];

  if (semantics.length === 0) return;

  const dir = path.join(vaultPath, "Knowledge");
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
    for (const m of memories) exported.add(m.id);
    const ids = memories.map((m) => m.id);
    const tags = getTagsForIds(db, ids);
    const title = titleCase(topic);
    const fm = frontmatter({ type: "knowledge", topic, tags });
    const content = [fm, `# ${title}\n`, renderMemories(memories)];
    content.push(seeAlso([topic, ...tags], registry));

    const slug = slugify(topic);
    registry.knowledge.set(slug, title);
    writeFile(path.join(dir, `${slug}.md`), content.join("\n"));
    fileCount++;
  }

  sections.knowledge = fileCount;
}

function exportReference(
  db: DatabaseSync, vaultPath: string, sections: Record<string, number>,
  registry: FileRegistry, exported: Set<string>,
): void {
  const uris = db
    .prepare(
      `SELECT source_uri, COUNT(*) as chunk_count FROM memories
       WHERE is_active = 1 AND tier = 'reference' AND source_uri IS NOT NULL
       GROUP BY source_uri ORDER BY chunk_count DESC`,
    )
    .all() as unknown as Array<{ source_uri: string; chunk_count: number }>;

  if (uris.length === 0) return;

  const dir = path.join(vaultPath, "Reference");
  let fileCount = 0;

  for (const { source_uri } of uris) {
    const chunks = db
      .prepare(
        `SELECT m.id, m.content FROM memories m
         WHERE m.is_active = 1 AND m.tier = 'reference' AND m.source_uri = ?
         ORDER BY m.created_at ASC`,
      )
      .all(source_uri) as unknown as Array<{ id: string; content: string }>;

    for (const c of chunks) exported.add(c.id);

    const title = urlToTitle(source_uri);
    const ids = chunks.map((c) => c.id);
    const tags = getTagsForIds(db, ids);
    const fm = frontmatter({ type: "reference", source: source_uri, tags });
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

function exportNotes(
  db: DatabaseSync, vaultPath: string, sections: Record<string, number>,
  registry: FileRegistry, exported: Set<string>,
): void {
  // Get all active non-reference, non-working memories not yet exported
  const all = db
    .prepare(
      `SELECT m.id, m.content, m.created_at, m.importance
       FROM memories m WHERE m.is_active = 1 AND m.tier NOT IN ('reference', 'working')
       ORDER BY m.importance DESC, m.created_at DESC`,
    )
    .all() as unknown as MemoryRow[];

  const remaining = all.filter((m) => !exported.has(m.id));
  if (remaining.length === 0) return;

  // Get primary tag for each remaining memory (most specific = longest tag)
  const memoryPrimaryTag = new Map<string, string>();
  for (const m of remaining) {
    const tags = db
      .prepare("SELECT tag FROM memory_tags WHERE memory_id = ? ORDER BY length(tag) DESC LIMIT 1")
      .all(m.id) as unknown as Array<{ tag: string }>;
    const tag = tags.length > 0 ? tags[0].tag : "uncategorized";
    memoryPrimaryTag.set(m.id, tag);
  }

  // Group by primary tag
  const byTag = new Map<string, MemoryRow[]>();
  for (const m of remaining) {
    const tag = memoryPrimaryTag.get(m.id) || "uncategorized";
    const arr = byTag.get(tag) ?? [];
    arr.push(m);
    byTag.set(tag, arr);
  }

  // Merge small groups (<5 memories) into broader topic buckets
  const MIN_GROUP_SIZE = 5;
  const merged = new Map<string, MemoryRow[]>();
  const miscellaneous: MemoryRow[] = [];

  for (const [tag, memories] of byTag) {
    if (memories.length >= MIN_GROUP_SIZE) {
      merged.set(tag, memories);
    } else {
      miscellaneous.push(...memories);
    }
  }

  if (miscellaneous.length > 0) {
    merged.set("miscellaneous", miscellaneous);
  }

  const dir = path.join(vaultPath, "Notes");
  let fileCount = 0;

  for (const [tag, memories] of merged) {
    if (memories.length === 0) continue;
    for (const m of memories) exported.add(m.id);

    const title = titleCase(tag);
    const fm = frontmatter({ type: "notes", topic: tag, tags: [tag] });
    const content = [fm, `# ${title}\n`, renderMemories(memories)];

    const slug = slugify(tag);
    registry.notes.set(slug, title);
    writeFile(path.join(dir, `${slug}.md`), content.join("\n"));
    fileCount++;
  }

  sections.notes = fileCount;
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
  ];

  if (registry.projects.size > 0) {
    lines.push("## Projects\n");
    for (const [slug, title] of registry.projects) {
      lines.push(`- [[Projects/${slug}|${title}]]`);
    }
    lines.push("");
  }

  if (registry.knowledge.size > 0) {
    lines.push("## Knowledge\n");
    for (const [slug, title] of registry.knowledge) {
      lines.push(`- [[Knowledge/${slug}|${title}]]`);
    }
    lines.push("");
  }

  if (registry.decisions.size > 0) {
    lines.push("## Decisions\n");
    for (const [slug, title] of registry.decisions) {
      lines.push(`- [[Decisions/${slug}|${title}]]`);
    }
    lines.push("");
  }

  if (registry.notes.size > 0) {
    lines.push("## Notes\n");
    for (const [slug, title] of registry.notes) {
      lines.push(`- [[Notes/${slug}|${title}]]`);
    }
    lines.push("");
  }

  if (registry.reference.size > 0) {
    lines.push("## Reference\n");
    for (const [slug, title] of registry.reference) {
      lines.push(`- [[Reference/${slug}|${title}]]`);
    }
    lines.push("");
  }

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

  if (clean) cleanVault(vaultPath);
  ensureDir(vaultPath);

  const sections: Record<string, number> = {};
  const registry: FileRegistry = {
    projects: new Map(),
    knowledge: new Map(),
    reference: new Map(),
    decisions: new Map(),
    notes: new Map(),
  };
  const exported = new Set<string>();

  // Order: projects first (biggest catch), then specifics, notes last (catch-all)
  exportSoulIdentity(db, vaultPath, sections, exported);
  exportGoals(db, vaultPath, sections);
  exportProjects(db, vaultPath, sections, registry, exported);
  exportDecisions(db, vaultPath, sections, registry, exported);
  exportTechniques(db, vaultPath, sections, registry, exported);
  exportKnowledge(db, vaultPath, sections, registry, exported);
  exportReference(db, vaultPath, sections, registry, exported);
  exportNotes(db, vaultPath, sections, registry, exported);
  writeDashboard(vaultPath, registry);

  const files = Object.values(sections).reduce((a, b) => a + b, 0) + 1;
  return { files, sections };
}
