import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WikiCompileOptions {
  /** Path to the wiki output directory */
  wikiPath: string;
  /** Only compile a specific namespace */
  namespace?: string;
  /** Dry run — return plan without writing files */
  dryRun?: boolean;
  /** Min memories to produce an article (default 3) */
  minMemories?: number;
  /** Max memories per article (default 200) */
  maxMemories?: number;
}

export interface WikiArticle {
  slug: string;
  title: string;
  entities: string[];
  memoryCount: number;
  wordCount: number;
  path: string;
}

export interface WikiCompileResult {
  articles: WikiArticle[];
  indexUpdated: boolean;
  logEntry: string;
}

interface ArticleMemory {
  id: string;
  content: string;
  importance: number;
  access_count: number;
  created_at: string;
  tags: string;
  tier: string;
  namespace: string | null;
}

interface NamespaceInfo {
  namespace: string;
  count: number;
}

interface EntityLink {
  entity_name: string;
  namespaces: string[];
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
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function frontmatter(fields: Record<string, string | string[] | number>): string {
  const lines = ["---"];
  for (const [key, val] of Object.entries(fields)) {
    if (Array.isArray(val)) {
      if (val.length > 0)
        lines.push(`${key}: [${val.map((v) => `"${v}"`).join(", ")}]`);
    } else if (typeof val === "number") {
      lines.push(`${key}: ${val}`);
    } else {
      lines.push(`${key}: "${val}"`);
    }
  }
  lines.push("---\n");
  return lines.join("\n");
}

function writeFile(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf-8");
}

// ---------------------------------------------------------------------------
// Namespace discovery
// ---------------------------------------------------------------------------

function discoverNamespaces(db: DatabaseSync, minMemories: number): NamespaceInfo[] {
  return db
    .prepare(
      `SELECT namespace, COUNT(*) as count
       FROM memories
       WHERE is_active = 1 AND parent_id IS NULL
         AND namespace IS NOT NULL AND namespace != ''
       GROUP BY namespace
       HAVING COUNT(*) >= ?
       ORDER BY COUNT(*) DESC`
    )
    .all(minMemories) as unknown as NamespaceInfo[];
}

// ---------------------------------------------------------------------------
// Memory gathering — tiered: all memories, importance-sorted
// ---------------------------------------------------------------------------

/** Tags that indicate operational/internal memories — not knowledge */
const NOISE_TAGS = [
  "run-summary", "digest", "session-digest", "auto-digested",
  "sentinel", "operations", "prompt-amendment",
  "outcome", "goal-progress-implicit",
];

/** SQL clause to exclude operational noise */
const NOISE_FILTER = `
  AND m.is_metadata = 0
  AND NOT EXISTS (
    SELECT 1 FROM memory_tags t
    WHERE t.memory_id = m.id
    AND t.tag IN ('run-summary', 'digest', 'session-digest', 'auto-digested', 'prompt-amendment')
  )`;

function gatherNamespaceMemories(
  db: DatabaseSync,
  namespace: string,
  limit: number
): ArticleMemory[] {
  return db
    .prepare(
      `SELECT m.id, m.content, m.importance, m.access_count,
              m.created_at, COALESCE(m.tier, 'episodic') as tier,
              m.namespace,
              COALESCE(
                (SELECT GROUP_CONCAT(t.tag, ', ')
                 FROM memory_tags t WHERE t.memory_id = m.id), ''
              ) as tags
       FROM memories m
       WHERE m.namespace = ?
         AND m.is_active = 1
         AND m.parent_id IS NULL
         AND length(m.content) > 50
         ${NOISE_FILTER}
       ORDER BY m.importance DESC, m.access_count DESC
       LIMIT ?`
    )
    .all(namespace, limit) as unknown as ArticleMemory[];
}

function gatherUnscoped(db: DatabaseSync, limit: number): ArticleMemory[] {
  return db
    .prepare(
      `SELECT m.id, m.content, m.importance, m.access_count,
              m.created_at, COALESCE(m.tier, 'episodic') as tier,
              m.namespace,
              COALESCE(
                (SELECT GROUP_CONCAT(t.tag, ', ')
                 FROM memory_tags t WHERE t.memory_id = m.id), ''
              ) as tags
       FROM memories m
       WHERE (m.namespace IS NULL OR m.namespace = '')
         AND m.is_active = 1
         AND m.parent_id IS NULL
         AND length(m.content) > 50
         ${NOISE_FILTER}
       ORDER BY m.importance DESC, m.access_count DESC
       LIMIT ?`
    )
    .all(limit) as unknown as ArticleMemory[];
}

// ---------------------------------------------------------------------------
// Entity enrichment + cross-article linking
// ---------------------------------------------------------------------------

function findLinkedEntities(db: DatabaseSync, memoryIds: string[]): string[] {
  if (memoryIds.length === 0) return [];
  const placeholders = memoryIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT DISTINCT e.name
       FROM entities e
       INNER JOIN memory_entities me ON e.id = me.entity_id
       WHERE me.memory_id IN (${placeholders})
       ORDER BY e.name`
    )
    .all(...memoryIds) as unknown as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/** Build global entity→namespaces map for cross-article wikilinks */
function buildEntityNamespaceMap(db: DatabaseSync): Map<string, string[]> {
  const rows = db
    .prepare(
      `SELECT DISTINCT e.name as entity_name, m.namespace
       FROM entities e
       INNER JOIN memory_entities me ON e.id = me.entity_id
       INNER JOIN memories m ON me.memory_id = m.id
       WHERE m.is_active = 1 AND m.namespace IS NOT NULL AND m.namespace != ''
       ORDER BY e.name`
    )
    .all() as unknown as Array<{ entity_name: string; namespace: string }>;

  const map = new Map<string, string[]>();
  for (const r of rows) {
    const arr = map.get(r.entity_name.toLowerCase());
    if (arr) {
      if (!arr.includes(r.namespace)) arr.push(r.namespace);
    } else {
      map.set(r.entity_name.toLowerCase(), [r.namespace]);
    }
  }
  return map;
}

/** Find which other namespaces share entities with this one */
function findRelatedNamespaces(
  entities: string[],
  currentNamespace: string,
  entityNsMap: Map<string, string[]>
): Map<string, number> {
  const related = new Map<string, number>(); // namespace → shared entity count
  for (const entity of entities) {
    const namespaces = entityNsMap.get(entity.toLowerCase()) ?? [];
    for (const ns of namespaces) {
      if (ns !== currentNamespace) {
        related.set(ns, (related.get(ns) ?? 0) + 1);
      }
    }
  }
  return related;
}

// ---------------------------------------------------------------------------
// LLM synthesis memories — produced by sentinel:wiki-compile job
// ---------------------------------------------------------------------------

function loadSynthesisMemories(db: DatabaseSync): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT m.content,
              (SELECT GROUP_CONCAT(t.tag, ',')
               FROM memory_tags t WHERE t.memory_id = m.id) as tags
       FROM memories m
       INNER JOIN memory_tags mt ON mt.memory_id = m.id
       WHERE mt.tag = 'wiki-synthesis'
         AND m.is_active = 1
       ORDER BY m.created_at DESC`
    )
    .all() as unknown as Array<{ content: string; tags: string }>;

  const map = new Map<string, string>();
  for (const row of rows) {
    // Extract slug from tags: ["wiki-synthesis", "skills-and-techniques"] → "skills-and-techniques"
    const tags = (row.tags || "").split(",").map((t: string) => t.trim());
    const slugTag = tags.find((t: string) => t !== "wiki-synthesis" && t.length > 0);
    if (slugTag && !map.has(slugTag)) {
      // Only use the most recent synthesis per slug (DESC order)
      map.set(slugTag, row.content);
    }
  }

  return map;
}

// ---------------------------------------------------------------------------
// Topic clustering — group unscoped memories by dominant tags
// ---------------------------------------------------------------------------

/** Primary topic tags that form natural article boundaries */
const TOPIC_TAGS: Record<string, string[]> = {
  "skills-and-techniques": ["skill", "technique", "learning", "how-to"],
  "operations-and-sentinel": ["sentinel", "operations"],
  "decisions-and-strategy": ["decision", "architecture", "strategy", "planning"],
  "goals-and-progress": ["goal-progress", "goal-progress-implicit", "milestone", "outcome"],
  "trading-and-crypto": ["trading", "crypto", "bitcoin", "solana", "defi", "alpha"],
  "research-and-discovery": ["research", "discovery", "investigation", "proactive-insight", "github-scout"],
  "testing-and-quality": ["testing", "test", "quality", "bug", "bug-fix"],
  "deployment-and-devops": ["deployment", "docker", "ci-cd", "devops", "windows"],
  "performance-and-optimization": ["performance", "optimization", "refactor", "caching"],
  "security-and-auth": ["security", "auth", "authentication", "encryption"],
};

function clusterByTopic(memories: ArticleMemory[]): Map<string, ArticleMemory[]> {
  const clusters = new Map<string, ArticleMemory[]>();
  const assigned = new Set<string>();

  // Pass 1: assign memories to topic clusters by tag matching
  for (const m of memories) {
    const memTags = m.tags.toLowerCase().split(", ").filter(Boolean);
    let bestTopic: string | null = null;
    let bestScore = 0;

    for (const [topic, tags] of Object.entries(TOPIC_TAGS)) {
      const score = memTags.filter((t) => tags.includes(t)).length;
      if (score > bestScore) {
        bestScore = score;
        bestTopic = topic;
      }
    }

    if (bestTopic && bestScore > 0) {
      const arr = clusters.get(bestTopic);
      if (arr) arr.push(m);
      else clusters.set(bestTopic, [m]);
      assigned.add(m.id);
    }
  }

  // Pass 2: unassigned memories go into "general-knowledge"
  const unassigned = memories.filter((m) => !assigned.has(m.id));
  if (unassigned.length > 0) {
    clusters.set("general-knowledge", unassigned);
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// Content synthesis — extract key facts and build narrative
// ---------------------------------------------------------------------------

function cleanMemoryContent(content: string): string {
  return content
    .replace(/\[Consolidated summary of.*?\]/g, "")
    .replace(/^\s*---+\s*$/gm, "")
    .trim();
}

/** Extract the first meaningful sentence from memory content */
function extractKeyPoint(content: string): string {
  const cleaned = cleanMemoryContent(content);
  const lines = cleaned.split("\n").filter((l) => l.trim().length > 10);
  // Skip lines that are headers, tag lists, or metadata
  const firstContent = lines.find((l) => {
    const t = l.trim();
    if (t.startsWith("#")) return false;
    if (isTagList(t)) return false;
    if (t.startsWith("*tags:") || t.startsWith("*importance:")) return false;
    if (t.length < 20) return false;
    return true;
  });
  if (!firstContent) return lines[0]?.trim().slice(0, 150) ?? "";
  return firstContent.trim().slice(0, 200);
}

/** Synthesize an overview paragraph from the top memories */
function synthesizeOverview(memories: ArticleMemory[], title: string): string {
  // Take top 5 memories by importance and extract their key points
  const topMemories = memories.slice(0, 5);
  const keyPoints = topMemories
    .map((m) => extractKeyPoint(m.content))
    .filter((p) => p.length > 20);

  if (keyPoints.length === 0) return "";

  // Build a synthetic overview
  const dateRange = getDateRange(memories);
  const tierCounts = countTiers(memories);

  const parts: string[] = [];
  parts.push(`**${title}** spans ${memories.length} memories`);
  if (dateRange) parts[0] += ` from ${dateRange}`;
  parts[0] += ".";

  if (tierCounts.semantic > 0 || tierCounts.procedural > 0) {
    const durable: string[] = [];
    if (tierCounts.semantic > 0) durable.push(`${tierCounts.semantic} permanent facts`);
    if (tierCounts.procedural > 0) durable.push(`${tierCounts.procedural} techniques`);
    parts.push(`Contains ${durable.join(" and ")}.`);
  }

  // Add synthesized key points
  parts.push("Key topics include:");
  for (const point of keyPoints.slice(0, 4)) {
    parts.push(`- ${point}`);
  }

  return parts.join("\n");
}

function getDateRange(memories: ArticleMemory[]): string | null {
  if (memories.length === 0) return null;
  const dates = memories.map((m) => m.created_at).sort();
  const first = dates[0].slice(0, 7); // YYYY-MM
  const last = dates[dates.length - 1].slice(0, 7);
  return first === last ? first : `${first} to ${last}`;
}

function countTiers(memories: ArticleMemory[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const m of memories) {
    counts[m.tier] = (counts[m.tier] ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Memory categorization
// ---------------------------------------------------------------------------

function categorizeMemory(m: ArticleMemory): string {
  const tags = m.tags.toLowerCase();
  const content = m.content.toLowerCase();
  if (tags.includes("decision") || content.includes("decided") || content.includes("decision:")) return "decisions";
  if (tags.includes("architecture") || content.includes("architecture") || content.includes("schema")) return "architecture";
  if (tags.includes("technique") || tags.includes("learning") || tags.includes("how-to") || m.tier === "procedural") return "techniques";
  if (tags.includes("bug") || content.includes("bug fix") || content.includes("fixed:")) return "issues";
  if (tags.includes("discovery") || tags.includes("research") || tags.includes("investigation")) return "research";
  if (tags.includes("session-summary") || tags.includes("digest") || tags.includes("session-digest")) return "sessions";
  if (tags.includes("goal") || tags.includes("milestone")) return "goals";
  if (m.tier === "semantic") return "knowledge";
  if (m.tier === "reference") return "reference";
  return "notes";
}

const SECTION_ORDER = [
  "knowledge", "architecture", "decisions", "techniques",
  "goals", "research", "issues", "sessions", "reference", "notes",
];
const SECTION_TITLES: Record<string, string> = {
  knowledge: "Key Knowledge",
  architecture: "Architecture & Design",
  decisions: "Decisions",
  techniques: "Techniques & Patterns",
  goals: "Goals & Milestones",
  research: "Research & Discovery",
  issues: "Issues & Fixes",
  sessions: "Session Summaries",
  reference: "Reference Material",
  notes: "Notes",
};

// ---------------------------------------------------------------------------
// Progressive depth rendering — tier memories by importance
// ---------------------------------------------------------------------------

interface RenderTier {
  /** Full content — top memories */
  full: ArticleMemory[];
  /** Key point only — medium memories */
  summary: ArticleMemory[];
  /** One-line mention — low importance */
  mention: ArticleMemory[];
}

function tierMemories(memories: ArticleMemory[]): RenderTier {
  const sorted = [...memories].sort((a, b) => b.importance - a.importance);

  // Top 30% get full treatment, middle 40% get summary, bottom 30% get mention
  const fullCount = Math.max(3, Math.ceil(sorted.length * 0.3));
  const summaryCount = Math.ceil(sorted.length * 0.4);

  return {
    full: sorted.slice(0, fullCount),
    summary: sorted.slice(fullCount, fullCount + summaryCount),
    mention: sorted.slice(fullCount + summaryCount),
  };
}

/** Check if a string looks like a tag list rather than a proper heading */
function isTagList(text: string): boolean {
  // "tag1, tag2, tag3 (N sources, date)" pattern
  if (/^[\w-]+(?:,\s*[\w-]+){2,}\s*\(/.test(text)) return true;
  // Just comma-separated lowercase words
  if (/^[a-z][\w-]*(?:,\s*[a-z][\w-]*){2,}$/.test(text)) return true;
  return false;
}

/** Generate a readable heading from memory content */
function generateHeading(m: ArticleMemory): string {
  const content = cleanMemoryContent(m.content);
  const firstLine = content.split("\n")[0].replace(/^#+\s*/, "").trim();

  // If first line is a tag list, try to find a better heading
  if (isTagList(firstLine) || firstLine.length > 120 || firstLine.length < 5) {
    // Try second line
    const secondLine = content.split("\n").find((l, i) => i > 0 && l.trim().length > 10 && !l.trim().startsWith("-"));
    if (secondLine) {
      const clean = secondLine.replace(/^#+\s*/, "").replace(/^\*\*/, "").replace(/\*\*$/, "").trim();
      if (clean.length > 5 && clean.length < 120) return clean.slice(0, 100);
    }
    // Fall back to date + truncated content
    const date = m.created_at.slice(0, 10);
    const preview = content.replace(/\n/g, " ").slice(0, 80).trim();
    return `${date}: ${preview}`;
  }

  return firstLine.slice(0, 100);
}

function renderFullMemory(m: ArticleMemory): string {
  const content = cleanMemoryContent(m.content)
    .replace(/^#{1,2}\s+/gm, "#### "); // demote headings

  if (content.length < 30) return "";

  const heading = generateHeading(m);
  // Get content body — skip the first line if it was used as heading
  const firstLine = content.split("\n")[0].replace(/^#+\s*/, "").trim();
  const body = heading === firstLine.slice(0, 100)
    ? content.split("\n").slice(1).join("\n").trim()
    : content.trim();

  const lines: string[] = [`### ${heading}\n`];
  if (body) {
    lines.push(body.slice(0, 1500) + (body.length > 1500 ? "\n\n*[...truncated]*" : ""));
  }

  return lines.join("\n");
}

function renderSummaryMemory(m: ArticleMemory): string {
  const keyPoint = extractKeyPoint(m.content);
  if (keyPoint.length < 10) return "";
  const date = m.created_at.slice(0, 10);
  return `- **${date}**: ${keyPoint}`;
}

function renderMentionMemory(m: ArticleMemory): string {
  const preview = m.content.split("\n")[0].replace(/^#+\s*/, "").trim().slice(0, 80);
  if (preview.length < 10) return "";
  return `- ${preview}`;
}

// ---------------------------------------------------------------------------
// Article rendering
// ---------------------------------------------------------------------------

function renderArticle(
  title: string,
  slug: string,
  memories: ArticleMemory[],
  entities: string[],
  entityNsMap: Map<string, string[]>,
  namespaceSlugs: Map<string, string>,
  currentNamespace: string,
): string {
  const now = new Date().toISOString();

  // Unique tags
  const allTags = [...new Set(
    memories.flatMap((m) => m.tags.split(", ").filter(Boolean))
  )].slice(0, 20);

  const fm = frontmatter({
    title,
    compiled: now,
    entities: entities.slice(0, 15),
    sources: memories.length,
    tags: allTags,
  });

  // --- Synthesized overview ---
  const overview = synthesizeOverview(memories, title);
  const overviewLines = [`# ${title}\n`, overview, ""];

  // Entity list with cross-article wikilinks
  if (entities.length > 0) {
    overviewLines.push("**Entities:** " + entities.slice(0, 25).map((name) => {
      // Link to another article if this entity appears in other namespaces
      const namespaces = entityNsMap.get(name.toLowerCase()) ?? [];
      const otherNs = namespaces.find((ns) => ns !== currentNamespace);
      if (otherNs) {
        const targetSlug = namespaceSlugs.get(otherNs);
        if (targetSlug) return `[[${targetSlug}|${titleCase(name)}]]`;
      }
      return titleCase(name);
    }).join(", ") + "\n");
  }

  // --- Sections with progressive depth ---
  const sections = new Map<string, ArticleMemory[]>();
  for (const m of memories) {
    const cat = categorizeMemory(m);
    const arr = sections.get(cat);
    if (arr) arr.push(m);
    else sections.set(cat, [m]);
  }

  const sectionBlocks: string[] = [];
  for (const cat of SECTION_ORDER) {
    const mems = sections.get(cat);
    if (!mems || mems.length === 0) continue;

    const lines: string[] = [`## ${SECTION_TITLES[cat] ?? titleCase(cat)} (${mems.length})\n`];
    const tiered = tierMemories(mems);

    // Full-tier: complete content
    for (const m of tiered.full) {
      const rendered = renderFullMemory(m);
      if (rendered) {
        lines.push(rendered);
        lines.push("");
      }
    }

    // Summary-tier: key point per memory
    if (tiered.summary.length > 0) {
      if (tiered.full.length > 0) lines.push("**Additional:**\n");
      for (const m of tiered.summary) {
        const rendered = renderSummaryMemory(m);
        if (rendered) lines.push(rendered);
      }
      lines.push("");
    }

    // Mention-tier: one-line list
    if (tiered.mention.length > 0) {
      lines.push(`<details><summary>${tiered.mention.length} more...</summary>\n`);
      for (const m of tiered.mention) {
        const rendered = renderMentionMemory(m);
        if (rendered) lines.push(rendered);
      }
      lines.push("</details>\n");
    }

    sectionBlocks.push(lines.join("\n"));
  }

  // --- Timeline ---
  const sorted = [...memories].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const timelineLines: string[] = ["## Timeline\n"];
  const byMonth = new Map<string, ArticleMemory[]>();
  for (const m of sorted) {
    const month = m.created_at.slice(0, 7);
    const arr = byMonth.get(month);
    if (arr) arr.push(m);
    else byMonth.set(month, [m]);
  }
  for (const [month, mems] of byMonth) {
    timelineLines.push(`**${month}** (${mems.length} memories)`);
    for (const m of mems.slice(0, 8)) {
      const preview = m.content.split("\n")[0].replace(/^#+\s*/, "").trim().slice(0, 120);
      timelineLines.push(`- ${preview}`);
    }
    if (mems.length > 8) timelineLines.push(`- *...and ${mems.length - 8} more*`);
    timelineLines.push("");
  }

  // --- Related articles via shared entities ---
  const relatedNs = findRelatedNamespaces(entities, currentNamespace, entityNsMap);
  const relatedLines: string[] = [];
  if (relatedNs.size > 0) {
    relatedLines.push("## Related Articles\n");
    const sortedRelated = [...relatedNs.entries()].sort((a, b) => b[1] - a[1]);
    for (const [ns, sharedCount] of sortedRelated.slice(0, 15)) {
      const targetSlug = namespaceSlugs.get(ns);
      if (targetSlug) {
        relatedLines.push(`- [[${targetSlug}|${titleCase(ns)}]] — ${sharedCount} shared entities`);
      }
    }
    relatedLines.push("");
  }

  return [
    fm,
    overviewLines.join("\n"),
    ...sectionBlocks,
    timelineLines.join("\n"),
    relatedLines.join("\n"),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Index file — comprehensive catalog with summaries
// ---------------------------------------------------------------------------

function renderIndex(
  articles: WikiArticle[],
  compiledAt: string,
  entityNsMap: Map<string, string[]>
): string {
  const fm = frontmatter({
    title: "Wiki Index",
    compiled: compiledAt,
    type: "index",
  });

  const totalWords = articles.reduce((s, a) => s + a.wordCount, 0);
  const totalSources = articles.reduce((s, a) => s + a.memoryCount, 0);

  const lines = [
    fm,
    "# Wiki Index\n",
    `> ${articles.length} articles, ${totalSources} source memories, ${totalWords.toLocaleString()} words.`,
    `> Last compiled: ${compiledAt.slice(0, 10)}\n`,
    "## Articles\n",
    "| Article | Sources | Words | Key Entities |",
    "|---------|---------|-------|-------------|",
  ];

  for (const a of articles.sort((x, y) => y.memoryCount - x.memoryCount)) {
    const entityPreview = a.entities.slice(0, 4).join(", ") || "—";
    lines.push(
      `| [[${a.slug}\\|${a.title}]] | ${a.memoryCount} | ${a.wordCount.toLocaleString()} | ${entityPreview} |`
    );
  }

  // Entity cross-reference — show entities that span multiple articles
  const crossEntities = [...entityNsMap.entries()]
    .filter(([, namespaces]) => namespaces.length >= 2)
    .sort((a, b) => b[1].length - a[1].length);

  if (crossEntities.length > 0) {
    lines.push("\n## Cross-Cutting Entities\n");
    lines.push("Entities that appear across multiple articles:\n");
    for (const [entity, namespaces] of crossEntities.slice(0, 20)) {
      const nsLinks = namespaces.map((ns) => `[[${slugify(ns)}|${titleCase(ns)}]]`).join(", ");
      lines.push(`- **${titleCase(entity)}**: ${nsLinks}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Log file
// ---------------------------------------------------------------------------

function appendLog(wikiPath: string, entry: string): void {
  const logPath = path.join(wikiPath, "_log.md");
  const header = "# Wiki Compilation Log\n\n";

  if (!fs.existsSync(logPath)) {
    writeFile(logPath, header + entry + "\n");
  } else {
    fs.appendFileSync(logPath, entry + "\n", "utf-8");
  }
}

// ---------------------------------------------------------------------------
// Main compilation
// ---------------------------------------------------------------------------

export function compileWiki(
  db: DatabaseSync,
  options: WikiCompileOptions
): WikiCompileResult {
  const {
    wikiPath,
    namespace: targetNamespace,
    dryRun = false,
    minMemories = 3,
    maxMemories = 200,
  } = options;

  const now = new Date().toISOString();
  const nowShort = now.slice(0, 10);

  // 1. Discover namespaces
  const namespaces = targetNamespace
    ? [{ namespace: targetNamespace, count: 0 }]
    : discoverNamespaces(db, minMemories);

  // 2. Build global entity→namespace map for cross-linking
  const entityNsMap = buildEntityNamespaceMap(db);

  // 3. Build namespace→slug map
  const namespaceSlugs = new Map<string, string>();
  for (const ns of namespaces) {
    namespaceSlugs.set(ns.namespace, slugify(ns.namespace));
  }
  namespaceSlugs.set("general-knowledge", "general-knowledge");

  // 4. Load any LLM-synthesized articles (from sentinel:wiki-compile job)
  const synthesisMap = loadSynthesisMemories(db);

  // 5. Compile each namespace
  const articles: WikiArticle[] = [];

  for (const ns of namespaces) {
    const memories = gatherNamespaceMemories(db, ns.namespace, maxMemories);
    if (memories.length < minMemories) continue;

    const entities = findLinkedEntities(db, memories.map((m) => m.id));
    const title = titleCase(ns.namespace);
    const slug = slugify(ns.namespace);

    // Use LLM synthesis if available, otherwise extractive
    const synthesized = synthesisMap.get(slug);
    const articleContent = synthesized
      ? synthesized
      : renderArticle(title, slug, memories, entities, entityNsMap, namespaceSlugs, ns.namespace);
    const articlePath = path.join(wikiPath, `${slug}.md`);
    const wordCount = articleContent.split(/\s+/).length;

    if (!dryRun) {
      writeFile(articlePath, articleContent);
    }

    articles.push({ slug, title, entities, memoryCount: memories.length, wordCount, path: articlePath });
  }

  // 5. Unscoped memories → split into topic-based articles by tag clustering
  if (!targetNamespace) {
    const allUnscoped = gatherUnscoped(db, 2000); // get all unscoped
    if (allUnscoped.length > 0) {
      const topicArticles = clusterByTopic(allUnscoped);
      for (const [topicName, topicMemories] of topicArticles) {
        if (topicMemories.length < 1) continue;
        const entities = findLinkedEntities(db, topicMemories.map((m) => m.id));
        const title = titleCase(topicName);
        const slug = slugify(topicName);
        namespaceSlugs.set(topicName, slug);

        const articleContent = renderArticle(
          title, slug, topicMemories, entities,
          entityNsMap, namespaceSlugs, "",
        );
        const articlePath = path.join(wikiPath, `${slug}.md`);
        const wordCount = articleContent.split(/\s+/).length;

        if (!dryRun) {
          writeFile(articlePath, articleContent);
        }

        articles.push({ slug, title, entities, memoryCount: topicMemories.length, wordCount, path: articlePath });
      }
    }
  }

  // 6. Tiny namespaces (< minMemories) → compile individually if they have at least 1 memory
  if (!targetNamespace) {
    const tinyNamespaces = db
      .prepare(
        `SELECT namespace, COUNT(*) as count
         FROM memories
         WHERE is_active = 1 AND parent_id IS NULL
           AND namespace IS NOT NULL AND namespace != ''
           AND length(content) > 50
         GROUP BY namespace
         HAVING COUNT(*) < ? AND COUNT(*) >= 1
         ORDER BY COUNT(*) DESC`
      )
      .all(minMemories) as unknown as NamespaceInfo[];

    for (const ns of tinyNamespaces) {
      const memories = gatherNamespaceMemories(db, ns.namespace, maxMemories);
      if (memories.length === 0) continue;
      const entities = findLinkedEntities(db, memories.map((m) => m.id));
      const title = titleCase(ns.namespace);
      const slug = slugify(ns.namespace);
      namespaceSlugs.set(ns.namespace, slug);

      const articleContent = renderArticle(
        title, slug, memories, entities,
        entityNsMap, namespaceSlugs, ns.namespace,
      );
      const articlePath = path.join(wikiPath, `${slug}.md`);
      const wordCount = articleContent.split(/\s+/).length;

      if (!dryRun) {
        writeFile(articlePath, articleContent);
      }

      articles.push({ slug, title, entities, memoryCount: memories.length, wordCount, path: articlePath });
    }
  }

  // 6. Write index with cross-reference
  if (!dryRun && articles.length > 0) {
    const indexContent = renderIndex(articles, now, entityNsMap);
    writeFile(path.join(wikiPath, "_index.md"), indexContent);
  }

  // 7. Log
  const totalWords = articles.reduce((s, a) => s + a.wordCount, 0);
  const logEntry = `## [${nowShort}] compile | ${articles.length} articles (${totalWords} words)`;
  if (!dryRun) {
    appendLog(wikiPath, logEntry);
  }

  return {
    articles,
    indexUpdated: !dryRun && articles.length > 0,
    logEntry,
  };
}
