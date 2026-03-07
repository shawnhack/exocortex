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

interface TaggedMemoryRow extends MemoryRow {
  tags: string[];
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

interface FileEntry {
  slug: string;
  title: string;
  section: string;
  tags: Set<string>;
}

interface FileRegistry {
  /** "section/slug" → FileEntry */
  files: Map<string, FileEntry>;
  /** memory ID → "section/slug" file key (for memory-link cross-linking) */
  memoryToFile: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Project detection — strict: namespaces + CLAUDE.md snapshots only
// ---------------------------------------------------------------------------

function detectProjects(db: DatabaseSync): Set<string> {
  const projects = new Set<string>();

  // 1. All namespaces are definitively projects
  const ns = db
    .prepare(
      "SELECT DISTINCT namespace FROM memories WHERE is_active = 1 AND namespace IS NOT NULL",
    )
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
    const match = r.content.match(/^(.+?)\s*[—-]\s*CLAUDE\.md/m);
    if (match) {
      const name = slugify(match[1].trim());
      if (name.length > 2) projects.add(name);
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
      if (val.length > 0)
        lines.push(`${key}: [${val.map((v) => `"${v}"`).join(", ")}]`);
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

// ---------------------------------------------------------------------------
// Content cleaning — aggressive for reference docs
// ---------------------------------------------------------------------------

/** Detect if a line is an API type definition or schema noise */
function isTypeDefLine(line: string): boolean {
  const t = line.trim();
  // "TypeName = object { ... }" or "TypeName = SomeType { ... } or ..." or "TypeName = ..."
  if (/^[A-Z]\w+ = /.test(t)) return true;
  // "field: type" patterns — "type: \"base64\"", "media_type: ...", "content: array of ..."
  if (/^[a-z_\d]+:\s*(string|number|boolean|array|object|integer|optional)\b/i.test(t)) return true;
  // "field_name: TypeName { ... }" or "field_name: array of TypeName"
  if (/^[a-z_\d]+:\s*(array of\s+)?[A-Z]\w+(\s*\{[^}]*\})?(\s+or\s+)?/i.test(t)) return true;
  // Standalone type references: "error_code: BashCodeExecutionToolResultErrorCode"
  if (/^[a-z_\d]+:\s*[A-Z][A-Za-z]+$/i.test(t)) return true;
  // "field: quoted-value or quoted-value or ..." — enum field definitions
  if (/^[a-z_\d]+:\s*"[^"]*"(\s+or\s+"[^"]*")+/i.test(t)) return true;
  // "type: \"some_quoted_value\"" alone
  if (/^[a-z_\d]+:\s*"[^"]*"$/i.test(t)) return true;
  // "Accepts one of the following:" patterns
  if (/^(Accepts|This may be) one (of )?the following/i.test(t)) return true;
  // Quoted values alone: "image/jpeg", "base64", "5m", "1h", etc.
  if (/^"[a-z0-9_/+.-]+"$/i.test(t)) return true;
  // Backtick enum descriptions: "`5m`: 5 minutes"
  if (/^`[^`]+`:\s*\d+\s*(minute|hour|second|ms|day)/i.test(t)) return true;
  // "Defaults to `value`."
  if (/^Defaults to [`"]/i.test(t)) return true;
  // POST/GET endpoints: "POST/v1/messages"
  if (/^(POST|GET|PUT|DELETE|PATCH)\/\w/i.test(t)) return true;
  return false;
}

/** Clean web-scraped content — aggressive mode for reference docs */
function cleanContent(text: string, aggressive = false): string {
  const lines = text.split("\n");
  const cleaned: string[] = [];
  const seen = new Set<string>();
  let inCodeBlock = false;
  let consecutiveNoise = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // Track code blocks
    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      consecutiveNoise = 0;
      cleaned.push(line);
      continue;
    }
    if (inCodeBlock) {
      cleaned.push(line);
      continue;
    }

    // Skip empty lines (but keep one between paragraphs)
    if (
      trimmed === "" &&
      cleaned.length > 0 &&
      cleaned[cleaned.length - 1].trim() === ""
    )
      continue;

    // Universal noise patterns
    if (
      /^(Loading\.\.\.|Copy page|Skip to content|Table of Contents|API Reference|On this page)$/i.test(
        trimmed,
      )
    )
      continue;
    if (
      /^(Previous|Next|Was this helpful\??|Edit this page|Share this|Share \d+|Tweet \d+)$/i.test(
        trimmed,
      )
    )
      continue;
    if (/Expand\s*Collapse/i.test(trimmed) && trimmed.length < 40) continue;
    if (/^Source:\s*https?:\/\//i.test(trimmed)) continue;
    if (/^Manage Cookie Consent/i.test(trimmed)) continue;
    if (/cookie|consent|marketing|advertising/i.test(trimmed) && trimmed.length < 100) continue;
    if (/^(Functional|Preferences|Statistics|Marketing)\s+(Functional|Preferences|Statistics|Marketing)?/i.test(trimmed)) continue;
    if (/^(Accept|Deny|View preferences|Save preferences|Manage options|Manage services|Read more about)/i.test(trimmed)) continue;
    if (/^\{(title|email|url|required)\}/i.test(trimmed)) continue;
    if (/^(Written by|Trusted by|Last Updated|Updated|Forex trader)\s/i.test(trimmed)) continue;

    // Aggressive mode for reference docs: strip type definitions and noise
    if (aggressive) {
      if (isTypeDefLine(trimmed)) {
        consecutiveNoise++;
        continue;
      }
      // "2 more" or "3 more" fragments from collapsed type fields
      if (/^\d+ more$/.test(trimmed)) continue;
      // Bare field names: just "data" or "media_type" on a line
      if (/^[a-z_]+$/i.test(trimmed) && trimmed.length < 30) {
        consecutiveNoise++;
        if (consecutiveNoise > 2) continue;
      } else {
        consecutiveNoise = 0;
      }
      // Navigation breadcrumb patterns: short lines that are just page titles
      if (
        trimmed.length < 40 &&
        !trimmed.startsWith("#") &&
        /^[A-Z][a-z]+ [A-Z][a-z]+$/u.test(trimmed)
      )
        continue;
      // Short promotional lines: "100k monthly readers", "Sign up now", etc.
      if (/^\d+k?\s+(monthly|weekly|daily)\s+\w+$/i.test(trimmed)) continue;
      // "The number of X tokens..." (API field description noise)
      if (/^The number of \w+ tokens/i.test(trimmed) && trimmed.length < 80) continue;
    } else {
      consecutiveNoise = 0;
    }

    // Dedup substantive lines
    if (trimmed.length > 20) {
      const key = trimmed.toLowerCase().replace(/\s+/g, " ");
      if (seen.has(key)) continue;
      seen.add(key);
    }
    if (trimmed.startsWith("#")) {
      const heading = trimmed
        .replace(/^#+\s*/, "")
        .toLowerCase()
        .replace(/\s+/g, " ");
      if (seen.has(heading)) continue;
      seen.add(heading);
    }

    cleaned.push(line);
  }

  return cleaned
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

/** Check if reference content is mostly noise (type defs / short lines) */
function computeProseRatio(text: string): number {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return 0;
  let proseLines = 0;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("#")) {
      proseLines++;
      continue;
    }
    // Prose = at least 40 chars and contains spaces (full sentences)
    if (t.length >= 40 && t.includes(" ") && !isTypeDefLine(t)) {
      proseLines++;
    }
  }
  return proseLines / lines.length;
}

/** Get tags for a set of memory IDs */
function getTagsForIds(db: DatabaseSync, ids: string[]): string[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT tag, COUNT(*) as c FROM memory_tags WHERE memory_id IN (${placeholders}) GROUP BY tag ORDER BY c DESC LIMIT 10`,
    )
    .all(...ids) as unknown as Array<{ tag: string; c: number }>;
  return rows.map((r) => r.tag);
}

/** Get all tags for a single memory */
function getMemoryTags(db: DatabaseSync, id: string): string[] {
  const rows = db
    .prepare("SELECT tag FROM memory_tags WHERE memory_id = ?")
    .all(id) as unknown as Array<{ tag: string }>;
  return rows.map((r) => r.tag);
}

/** Load memories with their tags */
function loadTaggedMemories(
  db: DatabaseSync,
  memories: MemoryRow[],
): TaggedMemoryRow[] {
  return memories.map((m) => ({
    ...m,
    tags: getMemoryTags(db, m.id),
  }));
}

// ---------------------------------------------------------------------------
// Content structuring — group memories by category, not just chronology
// ---------------------------------------------------------------------------

/** Detect if memory content is a consolidated summary with garbage artifacts */
function isConsolidatedGarbage(content: string): boolean {
  if (!content.includes("Consolidated summary of")) return false;
  // Check if it's mostly just timestamps and numbers
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  let garbageLines = 0;
  for (const line of lines) {
    const t = line.trim();
    // Lines that are mostly numbers, timestamps, or version strings
    if (/^[-\s]*[\d.,\s/]+$/.test(t)) garbageLines++;
    // "Key facts:" followed by nothing meaningful
    if (t === "Key facts:" || t === "Specifics:") garbageLines++;
    // Lines with random numbers/versions like "39.047, 26.828, v2.1.74"
    if (/^[-\s]*[\d.,\sv]+[\w-]*$/.test(t.replace(/,\s*/g, ""))) garbageLines++;
  }
  return garbageLines / lines.length > 0.4;
}

/** Detect if memory is too low-quality to include */
function isLowQuality(content: string): boolean {
  const trimmed = content.trim();
  // Too short
  if (trimmed.length < 30) return true;
  // Just timestamps and numbers
  if (/^[\d.,\s:/-]+$/.test(trimmed)) return true;
  return false;
}

/** Categorize a memory by its tags/content */
type MemoryCategory =
  | "overview"
  | "decisions"
  | "architecture"
  | "features"
  | "bugs"
  | "learnings"
  | "research"
  | "other";

function categorizeMemory(m: TaggedMemoryRow): MemoryCategory {
  const tags = new Set(m.tags);
  const c = m.content.toLowerCase();

  if (tags.has("decision") || c.includes("decided to") || c.includes("decision:"))
    return "decisions";
  if (
    c.includes("claude.md project context") ||
    c.includes("executive summary") ||
    c.includes("project overview")
  )
    return "overview";
  if (
    tags.has("architecture") ||
    tags.has("design") ||
    c.includes("architecture") ||
    c.includes("schema")
  )
    return "architecture";
  if (
    tags.has("bug-fix") ||
    tags.has("bug-analysis") ||
    tags.has("bug-diagnosis") ||
    c.includes("bug fix") ||
    c.includes("fixed a bug")
  )
    return "bugs";
  if (
    tags.has("technique") ||
    tags.has("learning") ||
    tags.has("discovery") ||
    c.includes("lesson learned") ||
    c.includes("key takeaway")
  )
    return "learnings";
  if (tags.has("research") || c.includes("research") || c.includes("competitive"))
    return "research";
  if (
    tags.has("feature") ||
    tags.has("implementation") ||
    c.includes("built") ||
    c.includes("implemented") ||
    c.includes("added")
  )
    return "features";

  return "other";
}

const CATEGORY_ORDER: MemoryCategory[] = [
  "overview",
  "architecture",
  "features",
  "decisions",
  "bugs",
  "learnings",
  "research",
  "other",
];

const CATEGORY_TITLES: Record<MemoryCategory, string> = {
  overview: "Overview",
  architecture: "Architecture",
  features: "Features & Implementation",
  decisions: "Decisions",
  bugs: "Bug Fixes",
  learnings: "Learnings",
  research: "Research",
  other: "Notes",
};

/** Render memories grouped by category with structure */
function renderStructuredContent(memories: TaggedMemoryRow[]): string {
  // Filter out garbage
  const valid = memories.filter(
    (m) => !isConsolidatedGarbage(m.content) && !isLowQuality(m.content),
  );
  if (valid.length === 0) return "";

  // Categorize
  const byCategory = new Map<MemoryCategory, TaggedMemoryRow[]>();
  for (const m of valid) {
    const cat = categorizeMemory(m);
    const arr = byCategory.get(cat) ?? [];
    arr.push(m);
    byCategory.set(cat, arr);
  }

  const lines: string[] = [];

  // TOC for files with multiple categories and many memories
  const activeCats = CATEGORY_ORDER.filter(
    (c) => (byCategory.get(c)?.length ?? 0) > 0,
  );
  if (activeCats.length > 2 && valid.length > 10) {
    lines.push("## Contents\n");
    for (const cat of activeCats) {
      const count = byCategory.get(cat)!.length;
      lines.push(
        `- [[#${CATEGORY_TITLES[cat]}]] (${count})`,
      );
    }
    lines.push("");
  }

  // Render each category
  for (const cat of CATEGORY_ORDER) {
    const items = byCategory.get(cat);
    if (!items || items.length === 0) continue;

    lines.push(`## ${CATEGORY_TITLES[cat]}\n`);

    // Sort by date descending within category
    items.sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );

    for (const m of items) {
      const date = m.created_at.slice(0, 10);
      // If content already has a heading, use it
      if (m.content.startsWith("# ")) {
        // Demote h1 to h3 since we have h2 category headers
        lines.push(
          m.content.replace(/^# /m, "### ").replace(/\n# /g, "\n### "),
        );
      } else if (m.content.startsWith("## ")) {
        lines.push(
          m.content.replace(/^## /m, "### ").replace(/\n## /g, "\n### "),
        );
      } else {
        lines.push(`### ${date}\n`);
        lines.push(m.content);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

/** Simple chronological render for non-project content */
function renderMemories(memories: MemoryRow[]): string {
  const valid = memories.filter(
    (m) => !isConsolidatedGarbage(m.content) && !isLowQuality(m.content),
  );
  const lines: string[] = [];
  for (const m of valid) {
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
// Cross-linking — use entities, tags, and relationships
// ---------------------------------------------------------------------------

/** Build wikilinks to related files based on shared tags, slug matches, and memory links */
function buildCrossLinks(
  tags: string[],
  currentSlug: string,
  currentSection: string,
  registry: FileRegistry,
  memoryIds?: string[],
  db?: DatabaseSync,
): string {
  const links: string[] = [];
  const tagSet = new Set(tags.map((t) => t.toLowerCase()));
  const seen = new Set<string>();
  const currentKey = `${currentSection}/${currentSlug}`;

  // 1. Tag overlap (2+ shared tags)
  for (const [key, info] of registry.files) {
    if (key === currentKey) continue;
    if (seen.has(key)) continue;

    let shared = 0;
    for (const t of info.tags) {
      if (tagSet.has(t)) shared++;
    }

    if (shared >= 2) {
      seen.add(key);
      links.push(`- [[${info.section}/${info.slug}|${info.title}]]`);
    }
  }

  // 2. Slug name appearing in tags
  for (const [key, info] of registry.files) {
    if (key === currentKey || seen.has(key)) continue;
    if (tagSet.has(info.slug)) {
      seen.add(key);
      links.push(`- [[${info.section}/${info.slug}|${info.title}]]`);
    }
  }

  // 3. Memory links — find files that contain memories linked to ours
  if (db && memoryIds && memoryIds.length > 0 && registry.memoryToFile) {
    const placeholders = memoryIds.map(() => "?").join(",");
    try {
      const linked = db
        .prepare(
          `SELECT DISTINCT target_id FROM memory_links
           WHERE source_id IN (${placeholders}) AND strength >= 0.4
           UNION
           SELECT DISTINCT source_id FROM memory_links
           WHERE target_id IN (${placeholders}) AND strength >= 0.4`,
        )
        .all(...memoryIds, ...memoryIds) as unknown as Array<{
        target_id?: string;
        source_id?: string;
      }>;

      for (const row of linked) {
        const linkedId =
          (row as Record<string, string>).target_id ??
          (row as Record<string, string>).source_id;
        if (!linkedId) continue;
        const fileKey = registry.memoryToFile.get(linkedId);
        if (!fileKey || fileKey === currentKey || seen.has(fileKey)) continue;
        const info = registry.files.get(fileKey);
        if (!info) continue;
        seen.add(fileKey);
        links.push(`- [[${info.section}/${info.slug}|${info.title}]]`);
      }
    } catch {
      // memory_links table might not exist
    }
  }

  if (links.length === 0) return "";
  const limited = links.slice(0, 15);
  return `\n## Related\n\n${limited.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Section exporters
// ---------------------------------------------------------------------------

function exportSoulIdentity(
  db: DatabaseSync,
  vaultPath: string,
  sections: Record<string, number>,
  exported: Set<string>,
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
          for (const ms of [...milestones].sort((a, b) => a.order - b.order)) {
            lines.push(
              `- [${ms.status === "completed" ? "x" : " "}] ${ms.title}`,
            );
          }
          lines.push("");
        }
      } catch {
        /* ignore */
      }
    }
    lines.push("---\n");
  }

  writeFile(path.join(vaultPath, "Goals.md"), lines.join("\n"));
  sections.goals = goals.length;
}

function exportProjects(
  db: DatabaseSync,
  vaultPath: string,
  sections: Record<string, number>,
  registry: FileRegistry,
  exported: Set<string>,
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

    const tagged = loadTaggedMemories(db, memories);
    const ids = memories.map((m) => m.id);
    const tags = getTagsForIds(db, ids);
    const title = titleCase(project);
    const fm = frontmatter({ type: "project", project, tags });

    const slug = slugify(project);
    const structured = renderStructuredContent(tagged);
    if (!structured) continue; // all garbage

    const fileKey = `Projects/${slug}`;
    for (const id of ids) registry.memoryToFile.set(id, fileKey);

    const content = [fm, `# ${title}\n`, structured];
    content.push(buildCrossLinks(tags, slug, "Projects", registry, ids, db));

    registry.files.set(fileKey, {
      slug,
      title,
      section: "Projects",
      tags: new Set(tags.map((t) => t.toLowerCase())),
    });
    writeFile(path.join(dir, `${slug}.md`), content.join("\n"));
    fileCount++;
  }

  sections.projects = fileCount;
}

function exportDecisions(
  db: DatabaseSync,
  vaultPath: string,
  sections: Record<string, number>,
  registry: FileRegistry,
  exported: Set<string>,
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
    // Filter out garbage
    const valid = decs.filter(
      (d) => !isConsolidatedGarbage(d.content) && !isLowQuality(d.content),
    );
    if (valid.length === 0) continue;

    for (const d of valid) exported.add(d.id);
    const ids = valid.map((d) => d.id);
    const tags = getTagsForIds(db, ids);
    const fm = frontmatter({ type: "decisions", month, tags });

    const slug = month;
    const fileKey = `Decisions/${slug}`;
    for (const id of ids) registry.memoryToFile.set(id, fileKey);

    const content = [fm, `# Decisions - ${month}\n`, renderMemories(valid)];
    content.push(buildCrossLinks(tags, month, "Decisions", registry, ids, db));

    registry.files.set(fileKey, {
      slug,
      title: `Decisions ${month}`,
      section: "Decisions",
      tags: new Set(tags.map((t) => t.toLowerCase())),
    });
    writeFile(path.join(dir, `${slug}.md`), content.join("\n"));
    fileCount++;
  }

  sections.decisions = fileCount;
}

function exportTechniques(
  db: DatabaseSync,
  vaultPath: string,
  sections: Record<string, number>,
  registry: FileRegistry,
  exported: Set<string>,
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

  // Filter out garbage
  const valid = techniques.filter(
    (t) => !isConsolidatedGarbage(t.content) && !isLowQuality(t.content),
  );
  if (valid.length === 0) return;

  for (const t of valid) exported.add(t.id);

  const ids = valid.map((t) => t.id);
  const tags = getTagsForIds(db, ids);
  const fm = frontmatter({ type: "techniques", tags });

  // Group techniques by primary topic tag for structure
  const tagged = loadTaggedMemories(db, valid);
  const byTopic = new Map<string, TaggedMemoryRow[]>();
  for (const m of tagged) {
    // Find best topic tag (not 'technique' or 'learning')
    const topicTag =
      m.tags.find(
        (t) =>
          t !== "technique" &&
          t !== "learning" &&
          t !== "discovery" &&
          t !== "decision",
      ) ?? "general";
    const arr = byTopic.get(topicTag) ?? [];
    arr.push(m);
    byTopic.set(topicTag, arr);
  }

  const lines: string[] = [fm, "# Techniques & Learnings\n"];

  // TOC
  if (byTopic.size > 3) {
    lines.push("## Contents\n");
    for (const [topic, items] of byTopic) {
      lines.push(`- [[#${titleCase(topic)}]] (${items.length})`);
    }
    lines.push("");
  }

  // Render each topic group
  for (const [topic, items] of byTopic) {
    lines.push(`## ${titleCase(topic)}\n`);
    items.sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
    for (const m of items) {
      if (m.content.startsWith("#")) {
        // Demote headings
        lines.push(
          m.content.replace(/^# /gm, "### ").replace(/^## /gm, "### "),
        );
      } else {
        lines.push(`### ${m.created_at.slice(0, 10)}\n`);
        lines.push(m.content);
      }
      lines.push("");
    }
  }

  lines.push(buildCrossLinks(tags, "techniques", ".", registry));

  writeFile(path.join(vaultPath, "Techniques.md"), lines.join("\n"));
  sections.techniques = valid.length;
}

function exportKnowledge(
  db: DatabaseSync,
  vaultPath: string,
  sections: Record<string, number>,
  registry: FileRegistry,
  exported: Set<string>,
): void {
  const semantics = db
    .prepare(
      `SELECT m.id, m.content, m.created_at, m.importance
       FROM memories m WHERE m.is_active = 1 AND m.tier = 'semantic' AND m.parent_id IS NULL
       ORDER BY m.created_at DESC`,
    )
    .all() as unknown as MemoryRow[];

  if (semantics.length === 0) return;

  // Filter garbage
  const valid = semantics.filter(
    (m) => !isConsolidatedGarbage(m.content) && !isLowQuality(m.content),
  );
  if (valid.length === 0) return;

  const dir = path.join(vaultPath, "Knowledge");
  const byTopic = new Map<string, MemoryRow[]>();
  for (const m of valid) {
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

    const slug = slugify(topic);
    const fileKey = `Knowledge/${slug}`;
    for (const id of ids) registry.memoryToFile.set(id, fileKey);
    content.push(buildCrossLinks([topic, ...tags], slug, "Knowledge", registry, ids, db));

    registry.files.set(fileKey, {
      slug,
      title,
      section: "Knowledge",
      tags: new Set([topic, ...tags].map((t) => t.toLowerCase())),
    });
    writeFile(path.join(dir, `${slug}.md`), content.join("\n"));
    fileCount++;
  }

  sections.knowledge = fileCount;
}

function exportReference(
  db: DatabaseSync,
  vaultPath: string,
  sections: Record<string, number>,
  registry: FileRegistry,
  exported: Set<string>,
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

    // Stitch and clean aggressively
    const stitched = stitchChunks(chunks.map((c) => c.content));
    const cleaned = cleanContent(stitched, true);

    // Skip if the result is mostly noise
    const proseRatio = computeProseRatio(cleaned);
    if (proseRatio < 0.20 && cleaned.length > 500) continue;
    if (cleaned.length < 100) continue;

    for (const c of chunks) exported.add(c.id);

    const title = urlToTitle(source_uri);
    const ids = chunks.map((c) => c.id);
    const tags = getTagsForIds(db, ids);
    const fm = frontmatter({ type: "reference", source: source_uri, tags });

    const content = [fm, `# ${title}\n`, `> Source: ${source_uri}\n`, cleaned];

    const slug = slugify(title);
    const fileKey = `Reference/${slug}`;
    for (const id of ids) registry.memoryToFile.set(id, fileKey);
    content.push(buildCrossLinks(tags, slug, "Reference", registry, ids, db));

    registry.files.set(fileKey, {
      slug,
      title,
      section: "Reference",
      tags: new Set(tags.map((t) => t.toLowerCase())),
    });
    writeFile(path.join(dir, `${slug}.md`), content.join("\n"));
    fileCount++;
  }

  sections.reference = fileCount;
}

function exportNotes(
  db: DatabaseSync,
  vaultPath: string,
  sections: Record<string, number>,
  registry: FileRegistry,
  exported: Set<string>,
): void {
  // Get all active non-reference, non-working memories not yet exported
  const all = db
    .prepare(
      `SELECT m.id, m.content, m.created_at, m.importance
       FROM memories m WHERE m.is_active = 1 AND m.tier NOT IN ('reference', 'working')
       ORDER BY m.importance DESC, m.created_at DESC`,
    )
    .all() as unknown as MemoryRow[];

  const remaining = all.filter(
    (m) =>
      !exported.has(m.id) &&
      !isConsolidatedGarbage(m.content) &&
      !isLowQuality(m.content),
  );
  if (remaining.length === 0) return;

  // Get primary tag for each remaining memory
  const memoryPrimaryTag = new Map<string, string>();
  for (const m of remaining) {
    const tags = db
      .prepare(
        "SELECT tag FROM memory_tags WHERE memory_id = ? ORDER BY length(tag) DESC LIMIT 1",
      )
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

  // Merge small groups (<5 memories) into miscellaneous
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
    const tags = [tag];
    const fm = frontmatter({ type: "notes", topic: tag, tags });
    const content = [fm, `# ${title}\n`, renderMemories(memories)];

    const slug = slugify(tag);
    const ids = memories.map((m) => m.id);
    const fileKey = `Notes/${slug}`;
    for (const id of ids) registry.memoryToFile.set(id, fileKey);
    content.push(buildCrossLinks(tags, slug, "Notes", registry, ids, db));

    registry.files.set(fileKey, {
      slug,
      title,
      section: "Notes",
      tags: new Set(tags.map((t) => t.toLowerCase())),
    });
    writeFile(path.join(dir, `${slug}.md`), content.join("\n"));
    fileCount++;
  }

  sections.notes = fileCount;
}

// ---------------------------------------------------------------------------
// Dashboard / Index
// ---------------------------------------------------------------------------

function writeDashboard(vaultPath: string, registry: FileRegistry): void {
  // Group files by section
  const bySect = new Map<string, Array<{ slug: string; title: string }>>();
  for (const [, info] of registry.files) {
    const arr = bySect.get(info.section) ?? [];
    arr.push({ slug: info.slug, title: info.title });
    bySect.set(info.section, arr);
  }

  const lines: string[] = [
    "# Exocortex\n",
    "Personal knowledge base.\n",
    "## Core\n",
    "- [[Soul]] - AI personality and behavioral directives",
    "- [[Identity]] - User background and preferences",
    "- [[Goals]] - Active goals with milestone tracking",
    "- [[Techniques]] - Procedural knowledge and learnings",
    "- [[Predictions]] - Forecasts and track record\n",
  ];

  const sectionOrder = [
    "Projects",
    "Knowledge",
    "Decisions",
    "Notes",
    "Reference",
  ];
  for (const section of sectionOrder) {
    const files = bySect.get(section);
    if (!files || files.length === 0) continue;
    lines.push(`## ${section}\n`);
    for (const { slug, title } of files) {
      lines.push(`- [[${section}/${slug}|${title}]]`);
    }
    lines.push("");
  }

  writeFile(path.join(vaultPath, "_Index.md"), lines.join("\n"));
}

function exportPredictions(
  db: DatabaseSync,
  vaultPath: string,
  sections: Record<string, number>,
): void {
  let predictions: Array<{
    claim: string;
    confidence: number;
    status: string;
    resolution: string | null;
    created_at: string;
    resolved_at: string | null;
  }>;
  try {
    predictions = db
      .prepare(
        `SELECT claim, confidence, status, resolution, created_at, resolved_at
         FROM predictions ORDER BY created_at DESC`,
      )
      .all() as unknown as typeof predictions;
  } catch {
    return; // table might not exist
  }

  if (predictions.length === 0) return;

  const fm = frontmatter({ type: "predictions", tags: ["predictions"] });
  const lines: string[] = [fm, "# Predictions\n"];

  // Stats
  const resolved = predictions.filter((p) => p.status === "resolved");
  const correct = resolved.filter((p) => p.resolution === "true");
  const open = predictions.filter((p) => p.status === "open");
  lines.push(
    `**Total:** ${predictions.length} | **Resolved:** ${resolved.length} (${correct.length} correct, ${resolved.length - correct.length} incorrect) | **Open:** ${open.length}\n`,
  );

  // Open predictions first
  if (open.length > 0) {
    lines.push("## Open\n");
    for (const p of open) {
      lines.push(
        `- **${(p.confidence * 100).toFixed(0)}%** ${p.claim} *(${p.created_at.slice(0, 10)})*`,
      );
    }
    lines.push("");
  }

  // Resolved
  if (resolved.length > 0) {
    lines.push("## Resolved\n");
    for (const p of resolved) {
      const icon = p.resolution === "true" ? "+" : "-";
      lines.push(
        `- [${icon}] **${(p.confidence * 100).toFixed(0)}%** ${p.claim} *(${p.resolved_at?.slice(0, 10) ?? p.created_at.slice(0, 10)})*`,
      );
    }
    lines.push("");
  }

  writeFile(path.join(vaultPath, "Predictions.md"), lines.join("\n"));
  sections.predictions = predictions.length;
}

function exportFacts(
  db: DatabaseSync,
  vaultPath: string,
  sections: Record<string, number>,
): void {
  let facts: Array<{
    subject: string;
    predicate: string;
    object: string;
    confidence: number;
  }>;
  try {
    facts = db
      .prepare(
        `SELECT subject, predicate, object, confidence FROM facts
         WHERE confidence >= 0.7
         ORDER BY confidence DESC, subject ASC`,
      )
      .all() as unknown as typeof facts;
  } catch {
    return;
  }

  // Filter out noise — most extracted facts are garbage
  const stopWords = new Set([
    "now", "has", "is", "was", "are", "the", "its", "this", "that", "can",
    "will", "have", "had", "not", "but", "and", "for", "with", "from",
    "also", "been", "each", "both", "all", "any", "may", "use", "set",
    "get", "new", "old", "run", "add", "how", "why", "fully", "always",
    "then", "only", "just", "very", "when", "what", "which", "where",
    "pairs.", "claim", "editor", "session", "migration", "scheduling",
  ]);
  const valid = facts.filter((f) => {
    if (f.subject.length < 3 || f.object.length < 3) return false;
    if (stopWords.has(f.subject.toLowerCase())) return false;
    if (f.predicate === "version") return false;
    if (/^\d+(\.\d+)*$/.test(f.object)) return false;
    // Subject should start with uppercase (proper noun / entity)
    if (!/^[A-Z]/.test(f.subject)) return false;
    // Object shouldn't be a sentence fragment
    if (f.object.length > 60) return false;
    return true;
  });

  if (valid.length === 0) return;

  // Group by subject
  const bySubject = new Map<string, typeof valid>();
  for (const f of valid) {
    const arr = bySubject.get(f.subject) ?? [];
    arr.push(f);
    bySubject.set(f.subject, arr);
  }

  const fm = frontmatter({ type: "facts", tags: ["facts", "knowledge"] });
  const lines: string[] = [fm, "# Known Facts\n"];

  for (const [subject, subjectFacts] of bySubject) {
    lines.push(`## ${subject}\n`);
    for (const f of subjectFacts) {
      lines.push(`- ${f.predicate} → ${f.object}`);
    }
    lines.push("");
  }

  writeFile(path.join(vaultPath, "Facts.md"), lines.join("\n"));
  sections.facts = valid.length;
}

// ---------------------------------------------------------------------------
// Second pass: update cross-links after all files exist
// ---------------------------------------------------------------------------

function updateCrossLinks(
  db: DatabaseSync,
  vaultPath: string,
  registry: FileRegistry,
): void {
  for (const [key, info] of registry.files) {
    const filePath = path.join(vaultPath, info.section, `${info.slug}.md`);
    if (!fs.existsSync(filePath)) continue;

    let content = fs.readFileSync(filePath, "utf-8");

    // Skip if already has Related section (from first pass)
    if (content.includes("## Related\n")) continue;

    // Collect memory IDs for this file
    const memIds: string[] = [];
    for (const [memId, fKey] of registry.memoryToFile) {
      if (fKey === key) memIds.push(memId);
    }

    const tags = Array.from(info.tags);
    const links = buildCrossLinks(tags, info.slug, info.section, registry, memIds, db);
    if (links) {
      content += links;
      fs.writeFileSync(filePath, content, "utf-8");
    }
  }
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
  const registry: FileRegistry = { files: new Map(), memoryToFile: new Map() };
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
  exportPredictions(db, vaultPath, sections);
  // Facts skipped — extracted triples are too low quality to be useful

  // Second pass: add cross-links now that all files exist
  updateCrossLinks(db, vaultPath, registry);

  writeDashboard(vaultPath, registry);

  const files = Object.values(sections).reduce((a, b) => a + b, 0) + 1;
  return { files, sections };
}
