import type { EntityType, ExtractedRelationship } from "./types.js";

export interface ExtractedEntity {
  name: string;
  type: EntityType;
  confidence: number;
}

// Technology keywords — common programming languages, frameworks, tools
const TECHNOLOGIES = new Set([
  "javascript", "typescript", "python", "java", "c++", "c#",
  "php", "kotlin", "scala", "elixir", "haskell", "lua",
  "react", "vue", "angular", "svelte", "next.js", "nextjs", "nuxt",
  "node.js", "nodejs", "deno", "hono", "fastify", "django",
  "laravel",
  "postgres", "postgresql", "mysql", "sqlite", "mongodb", "redis", "dynamodb",
  "docker", "kubernetes", "terraform", "aws", "gcp", "azure", "vercel", "netlify",
  "git", "github", "gitlab", "linux", "windows", "macos",
  "graphql", "grpc", "websocket", "http",
  "tailwind", "css", "html", "webpack", "vite", "esbuild", "rollup",
  "claude", "gpt", "llm", "langchain",
  "figma", "storybook",
  "jest", "vitest", "playwright", "cypress", "mocha",
  "pnpm", "npm", "yarn",
  "tauri", "electron", "react native",
]);

// Organization patterns — common suffixes (AI removed — too ambiguous in verb phrases)
const ORG_SUFFIXES = /\b(Inc|Corp|LLC|Ltd|Co|Foundation|Labs|Studio|Solutions|Group|Technologies|Tech|Systems|Software)\b/;

// Words that commonly appear capitalized in tech text but aren't person names
const PERSON_WORD_BLOCKLIST = new Set([
  // Adjectives
  "neural", "visual", "digital", "virtual", "global", "active", "open",
  "native", "modern", "quick", "smart", "hybrid", "remote", "custom",
  "simple", "dynamic", "static", "atomic", "binary", "linear",
  "basic", "direct", "local", "final", "total", "super", "auto",
  "internal", "external", "primary", "secondary",
  // Common code/tech verbs and nouns that appear capitalized at sentence start
  "added", "agent", "alpha", "api", "automated", "bitcoin", "bot", "browser",
  "built", "chakra", "claw", "clerk", "code", "concurrent", "created", "creates",
  "database", "discovery", "exocortex", "fira", "from", "holder",
  "implementation", "isometric", "memory", "promise", "rendering",
  "schema", "solana", "token", "trade", "weak", "worker",
  // General English words that get capitalized
  "action", "all", "applied", "auth", "authentication", "autonomy", "base",
  "check", "codebase", "config", "configuration", "content", "count",
  "creation", "current", "data", "default", "detail", "distribution",
  "entry", "error", "event", "extension", "fetch", "group", "handler",
  "horizon", "hive", "import", "input", "interface", "item", "list",
  "manager", "method", "module", "node", "object", "other", "output", "page",
  "panel", "query", "request", "response", "result", "route", "server",
  "service", "session", "source", "state", "status", "storage", "store",
  "stream", "table", "target", "template", "test", "tick", "timer",
  "trigger", "type", "update", "value", "view", "world",
]);

// Nouns that follow a false-positive "person name" — signals it's a compound term
const PERSON_CONTEXT_NOUNS = new Set([
  "theme", "mode", "design", "pattern", "style", "config", "system",
  "framework", "engine", "model", "plugin", "directory", "studio",
  "component", "module", "service", "handler", "worker", "manager",
  "controller", "provider", "factory", "builder", "parser", "renderer",
]);

// Words that shouldn't be extracted as project names after keywords like "project"
const PROJECT_STOPWORDS = new Set([
  "status", "update", "version", "config", "settings", "code", "data",
  "apps", "tools", "files", "docs", "tests", "build", "plan", "list",
  "info", "notes", "log", "report", "overview", "details", "management",
  // Generic English nouns that appear capitalized after project-trigger verbs
  "structure", "trade", "design", "feature", "change", "system", "model",
  "interface", "function", "process", "service", "component", "module",
  "pattern", "logic", "support", "issue", "task", "format", "method",
  "page", "section", "part", "area", "layer", "flow", "pipeline",
  "handler", "worker", "manager", "controller", "engine", "framework",
]);

// File extensions that indicate a filename, not a project
const FILE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|css|html|json|md|yaml|yml|toml|sql|sh|py|rs|go)$/;

// Common verb prefixes that precede org-suffix false positives
const VERB_PREFIXES = new Set([
  "building", "using", "deploying", "creating", "running", "testing",
  "developing", "launching", "shipping", "maintaining", "designing",
]);

// First-word blocklist for org names matched by suffix patterns
const ORG_NAME_PREFIX_BLOCKLIST = new Set([
  // Past participles / verbs
  "added", "created", "built", "used", "found", "updated", "removed",
  "deployed", "launched", "shipped", "released", "applied", "called",
  "defined", "enabled", "extended", "fixed", "implemented", "improved",
  "installed", "loaded", "managed", "merged", "moved", "named",
  "opened", "parsed", "passed", "provided", "pushed", "rendered",
  "resolved", "returned", "selected", "started", "stored", "triggered",
  // Pronouns / determiners
  "my", "our", "your", "the", "a", "an", "this", "that", "its",
  // Adjectives
  "new", "old", "first", "last", "next", "other", "same", "each",
  "every", "many", "some", "any", "all", "most", "own",
]);

/**
 * Extract entities from text using regex-based NER.
 * Returns deduplicated entities sorted by confidence.
 */
export function extractEntities(text: string): ExtractedEntity[] {
  const entities = new Map<string, ExtractedEntity>();

  function add(name: string, type: EntityType, confidence: number) {
    const key = name.toLowerCase();
    const existing = entities.get(key);
    if (!existing || existing.confidence < confidence) {
      entities.set(key, { name, type, confidence });
    }
  }

  extractTechnologies(text, add);
  extractOrganizations(text, add);
  extractPersonNames(text, add);
  extractProjects(text, add);
  extractConcepts(text, add);

  return Array.from(entities.values()).sort((a, b) => b.confidence - a.confidence);
}

type AddFn = (name: string, type: EntityType, confidence: number) => void;

// Pre-compiled regex patterns for each technology (compiled once at module load)
const TECH_PATTERNS: Array<{ tech: string; re: RegExp }> = Array.from(TECHNOLOGIES).map((tech) => {
  const escaped = tech.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return { tech, re: new RegExp(`\\b${escaped}\\b`, "i") };
});

// Canonical display names for technologies
const TECH_DISPLAY: Record<string, string> = {
  "javascript": "JavaScript", "typescript": "TypeScript", "python": "Python",
  "java": "Java", "c++": "C++", "c#": "C#",
  "php": "PHP", "kotlin": "Kotlin",
  "react": "React", "vue": "Vue", "angular": "Angular", "svelte": "Svelte",
  "next.js": "Next.js", "nextjs": "Next.js", "node.js": "Node.js", "nodejs": "Node.js",
  "hono": "Hono", "fastify": "Fastify", "django": "Django",
  "docker": "Docker", "kubernetes": "Kubernetes", "terraform": "Terraform",
  "graphql": "GraphQL", "tailwind": "Tailwind", "css": "CSS", "html": "HTML",
  "claude": "Claude", "gpt": "GPT",
  "llm": "LLM", "tauri": "Tauri", "electron": "Electron",
  "postgres": "PostgreSQL", "postgresql": "PostgreSQL", "mysql": "MySQL",
  "sqlite": "SQLite", "mongodb": "MongoDB", "redis": "Redis",
  "github": "GitHub", "gitlab": "GitLab", "git": "Git",
  "playwright": "Playwright", "vitest": "Vitest", "jest": "Jest",
  "vite": "Vite", "webpack": "webpack", "pnpm": "pnpm",
};

// Case-sensitive tech patterns — words that are common English words in lowercase
// but refer to technologies when capitalized (e.g. "Go" vs "go", "Rust" vs "rust")
const CASE_SENSITIVE_TECH: Array<{ display: string; re: RegExp }> = [
  "Go", "Rust", "Spring", "Express", "Flask", "Remix", "Bun", "Phoenix",
  "Rails", "Swift", "Ruby", "Sketch", "Cargo", "Pip", "Brew", "Sass",
  "Expo", "REST",
].map((name) => ({
  display: name,
  re: new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`),
}));

// Set of lowercase case-sensitive tech names for isTechnology lookups
const CASE_SENSITIVE_TECH_LOWER = new Set(
  CASE_SENSITIVE_TECH.map((t) => t.display.toLowerCase())
);

/** Check if a name is a known technology (case-insensitive set OR case-sensitive set) */
function isTechnology(name: string): boolean {
  if (TECHNOLOGIES.has(name.toLowerCase())) return true;
  // For case-sensitive techs, the name must match the display form exactly
  if (CASE_SENSITIVE_TECH_LOWER.has(name.toLowerCase())) {
    return CASE_SENSITIVE_TECH.some((t) => t.re.test(name));
  }
  return false;
}

function extractTechnologies(text: string, add: AddFn): void {
  for (const { tech, re } of TECH_PATTERNS) {
    const match = re.exec(text);
    if (match) {
      add(TECH_DISPLAY[tech] ?? match[0], "technology", 0.9);
    }
  }
  // Case-sensitive matches
  for (const { display, re } of CASE_SENSITIVE_TECH) {
    if (re.test(text)) {
      add(display, "technology", 0.9);
    }
  }
}

function extractOrganizations(text: string, add: AddFn): void {
  // Pattern: Capitalized word(s) followed by org suffix
  const orgPattern = /\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)\s+(Inc|Corp|LLC|Ltd|Co|Foundation|Labs|Studio|Solutions|Group|Technologies|Tech|Systems|Software)\b/g;
  let match;
  while ((match = orgPattern.exec(text)) !== null) {
    // Skip if preceded by a verb (e.g. "Building AI Solutions" → not an org)
    const before = text.slice(0, match.index).trimEnd().split(/\s+/).pop()?.toLowerCase() ?? "";
    if (VERB_PREFIXES.has(before)) continue;
    // Skip if the first word of the org name is a blocklisted prefix
    const firstWord = match[1].split(/\s+/)[0].toLowerCase();
    if (ORG_NAME_PREFIX_BLOCKLIST.has(firstWord)) continue;
    add(`${match[1]} ${match[2]}`, "organization", 0.85);
  }

  // Well-known orgs without suffixes
  const knownOrgs = /\b(Google|Microsoft|Apple|Amazon|Meta|Netflix|Stripe|Shopify|Cloudflare|GitHub|GitLab|Mozilla|Canonical|Red Hat|IBM|Oracle|Intel|NVIDIA|AMD|Tesla|SpaceX|OpenAI|Anthropic|Mistral|Hugging Face|Databricks|Snowflake|Confluent|HashiCorp|Vercel|Supabase|PlanetScale|Neon|Fly\.io|Railway|Render)\b/g;
  while ((match = knownOrgs.exec(text)) !== null) {
    add(match[1], "organization", 0.85);
  }
}

function extractPersonNames(text: string, add: AddFn): void {
  // Only detect person names from strong contextual signals.
  // The general "two capitalized words" pattern produces too many false positives
  // in technical text, so we rely on explicit attribution patterns only.
  let match;

  // Explicit attribution: "by [Name]", "met [Name]", "author [Name]", etc.
  const attrPattern = /\b(?:by|from|with|author|creator|founder|CEO|CTO|met|told|asked|said|name is|called)\s+([A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]{2,})\b/g;
  while ((match = attrPattern.exec(text)) !== null) {
    const name = match[1];
    const parts = name.split(/\s+/);
    if (parts.some((p) => isTechnology(p))) continue;
    if (parts.some((p) => PERSON_WORD_BLOCKLIST.has(p.toLowerCase()))) continue;
    add(name, "person", 0.75);
  }
}

function extractProjects(text: string, add: AddFn): void {
  // Patterns that suggest project names
  // "working on X", "building X", "project X", "launched X"
  const projPattern = /\b(?:[Ww]orking on|[Bb]uilding|[Pp]roject|[Ll]aunched|[Ss]hipped|[Dd]eployed|[Rr]eleased|[Cc]reated|[Dd]eveloping|[Mm]aintained)\s+([A-Z][a-zA-Z0-9]+(?:[-_.][a-zA-Z0-9]+)*)/g;
  let match;
  while ((match = projPattern.exec(text)) !== null) {
    const name = match[1];
    // Skip known technologies, stopwords, and adjective-suffix names
    if (isTechnology(name)) continue;
    if (PROJECT_STOPWORDS.has(name.toLowerCase())) continue;
    if (/-(ready|based|assisted|driven|oriented)$/.test(name.toLowerCase())) continue;
    if (FILE_EXTENSIONS.test(name)) continue;
    if (name.length > 2) {
      add(name, "project", 0.65);
    }
  }

  // Pattern: "X project" — word before "project"
  const beforeProjPattern = /\b([A-Z][a-zA-Z0-9]+)\s+project\b/g;
  while ((match = beforeProjPattern.exec(text)) !== null) {
    const name = match[1];
    if (!isTechnology(name) && !PROJECT_STOPWORDS.has(name.toLowerCase()) && name.length > 2) {
      add(name, "project", 0.65);
    }
  }

  // Pattern: "projects: X" or "projects X" — word after "projects"
  const afterProjsPattern = /\bprojects[:\s]+([A-Z][a-zA-Z0-9]+)/g;
  while ((match = afterProjsPattern.exec(text)) !== null) {
    const name = match[1];
    if (!isTechnology(name) && !PROJECT_STOPWORDS.has(name.toLowerCase()) && name.length > 2) {
      add(name, "project", 0.65);
    }
  }

  // Note: kebab-case/dotted pattern removed — too many false positives
  // (CSS properties, compound adjectives, code identifiers, prefixed words).
  // Projects are detected via context patterns above only.
}

// Pre-compiled concept patterns (compiled once at module load)
const QUOTED_CONCEPT_RE = /"([A-Za-z][A-Za-z\s]{2,30})"/g;
const DOMAIN_CONCEPT_RE = /\b(machine learning|deep learning|artificial intelligence|neural network|natural language processing|computer vision|reinforcement learning|transfer learning|federated learning|RAG|retrieval augmented generation|knowledge graph|vector database|embedding|fine-tuning|prompt engineering|agentic AI|multi-agent|chain of thought|few-shot|zero-shot|tokenization|attention mechanism|transformer architecture)\b/gi;

// Blocklist for quoted concept extraction — entity types, enums, generic words
const CONCEPT_BLOCKLIST = new Set([
  // Entity type names
  "person", "organization", "technology", "project", "concept",
  // content_type / source enums
  "text", "note", "conversation", "summary", "api", "cli", "web",
  // Generic words that appear quoted in code/docs
  "nul", "null", "continue", "module", "icon", "source", "content",
  "type", "name", "value", "status", "error", "success", "pending",
  "active", "default", "custom", "manual", "auto", "none", "other",
  "true", "false", "yes", "data", "info", "test", "debug",
  // Parameter descriptor words
  "max", "min", "tags", "total", "optional", "required",
  // Status/state words
  "operational", "available", "ready", "complete", "failed",
]);

// Articles / determiners that start non-concept phrases
const ARTICLE_STARTERS = new Set([
  "the", "a", "an", "this", "that", "these", "those",
  "my", "your", "our", "his", "her", "its", "their",
  "no", "not",
]);

// Imperative verbs that start tool descriptions / instructions
const IMPERATIVE_STARTERS = new Set([
  "store", "search", "find", "get", "set", "add", "remove", "delete",
  "update", "create", "load", "save", "fetch", "check", "run", "use",
  "list", "show", "browse", "view", "open", "close", "start", "stop",
  "enable", "disable", "configure", "install", "build", "deploy",
  "apply", "filter", "select", "sort", "group", "import", "export",
]);

function extractConcepts(text: string, add: AddFn): void {
  // Quoted terms — heavily filtered to reduce noise
  QUOTED_CONCEPT_RE.lastIndex = 0;
  let match;
  while ((match = QUOTED_CONCEPT_RE.exec(text)) !== null) {
    const name = match[1].trim();
    const words = name.split(/\s+/);
    const lower = name.toLowerCase();
    const firstWordLower = words[0].toLowerCase();

    // Skip technologies
    if (isTechnology(name)) continue;

    if (words.length === 1) {
      // Single word: only accept ALL-CAPS acronyms 3+ chars (e.g. "MCP", "RAG")
      if (!/^[A-Z]{3,}$/.test(name)) continue;
    } else {
      // Multi-word: max 3 words, first word must be capitalized
      if (words.length > 3) continue;
      if (!/^[A-Z]/.test(words[0])) continue;
      // Skip ALL-CAPS multi-word phrases (error/status messages)
      if (/^[A-Z\s]+$/.test(name)) continue;
      // Skip phrases that look like person names (two capitalized words)
      if (words.length === 2 && /^[A-Z][a-z]+$/.test(words[0]) && /^[A-Z][a-z]+$/.test(words[1])) continue;
      // Skip blocklisted words (full phrase or first word)
      if (CONCEPT_BLOCKLIST.has(lower)) continue;
      if (CONCEPT_BLOCKLIST.has(firstWordLower)) continue;
      // Skip if first word is a past participle / determiner / adjective
      if (ORG_NAME_PREFIX_BLOCKLIST.has(firstWordLower)) continue;
      // Skip article/determiner starters
      if (ARTICLE_STARTERS.has(firstWordLower)) continue;
      // Skip imperative verb starters
      if (IMPERATIVE_STARTERS.has(firstWordLower)) continue;
    }

    add(name, "concept", 0.4);
  }

  // Domain-specific concept patterns (unchanged)
  DOMAIN_CONCEPT_RE.lastIndex = 0;
  while ((match = DOMAIN_CONCEPT_RE.exec(text)) !== null) {
    add(match[1], "concept", 0.8);
  }
}

// --- Relationship Extraction ---

interface RelationshipPattern {
  re: RegExp;
  relationship: string;
  confidence: number;
  contextGroup: number; // capture group index for context phrase
}

// Captures optional trailing context phrase: "for/to/in/as/with {phrase}"
const CONTEXT_SUFFIX = /(?:\s+(?:for|to|in|as|with)\s+([^.,]+))?/;
const TERMINATOR = "(?:\\.|,|$)";

/** Count capturing groups in a regex source string */
function countGroups(source: string): number {
  let count = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\\") { i++; continue; } // skip escaped chars
    if (source[i] === "(" && source[i + 1] !== "?") count++;
  }
  return count;
}

function withContext(base: RegExp): { re: RegExp; contextGroup: number } {
  const src = base.source;
  if (!src.endsWith(TERMINATOR)) return { re: base, contextGroup: -1 };
  const stripped = src.slice(0, -TERMINATOR.length);
  const baseGroups = countGroups(stripped);
  const re = new RegExp(stripped + CONTEXT_SUFFIX.source + TERMINATOR, base.flags);
  return { re, contextGroup: baseGroups + 1 };
}

const RELATIONSHIP_PATTERNS: RelationshipPattern[] = [
  // "X uses Y", "X using Y"
  { ...withContext(/\b(.+?)\s+(?:uses|using|use)\s+(.+?)(?:\.|,|$)/gi), relationship: "uses", confidence: 0.7 },
  // "X built with Y", "X built on Y"
  { ...withContext(/\b(.+?)\s+(?:built\s+(?:with|on|using))\s+(.+?)(?:\.|,|$)/gi), relationship: "uses", confidence: 0.7 },
  // "X depends on Y"
  { ...withContext(/\b(.+?)\s+(?:depends\s+on|relies\s+on)\s+(.+?)(?:\.|,|$)/gi), relationship: "uses", confidence: 0.7 },
  // "X works at Y", "X joined Y"
  { ...withContext(/\b(.+?)\s+(?:works\s+at|joined|works\s+for)\s+(.+?)(?:\.|,|$)/gi), relationship: "works_at", confidence: 0.7 },
  // "X is part of Y", "X belongs to Y"
  { ...withContext(/\b(.+?)\s+(?:is\s+part\s+of|belongs\s+to)\s+(.+?)(?:\.|,|$)/gi), relationship: "part_of", confidence: 0.7 },
  // "X created Y", "X built Y", "X authored Y"
  { ...withContext(/\b(.+?)\s+(?:created|built|authored|developed|wrote)\s+(.+?)(?:\.|,|$)/gi), relationship: "created", confidence: 0.7 },
  // "X replaces Y", "X supersedes Y"
  { ...withContext(/\b(.+?)\s+(?:replaces|supersedes|replaced)\s+(.+?)(?:\.|,|$)/gi), relationship: "replaces", confidence: 0.7 },
];

/**
 * Extract relationships between entities found in the same content.
 * Only creates relationships between entities that were actually extracted.
 */
export function extractRelationships(
  text: string,
  entities: ExtractedEntity[]
): ExtractedRelationship[] {
  if (entities.length < 2) return [];

  // Build a lookup map: lowercase name → entity name
  const entityNames = new Map<string, string>();
  for (const e of entities) {
    entityNames.set(e.name.toLowerCase(), e.name);
  }

  const results: ExtractedRelationship[] = [];
  const seen = new Set<string>();

  for (const pattern of RELATIONSHIP_PATTERNS) {
    pattern.re.lastIndex = 0;
    let match;
    while ((match = pattern.re.exec(text)) !== null) {
      const rawSource = match[1].trim();
      const rawTarget = match[2].trim();
      const rawContext = pattern.contextGroup > 0
        ? match[pattern.contextGroup]?.trim() || undefined
        : undefined;

      // Try to match source and target to known entities
      const source = findMatchingEntity(rawSource, entityNames);
      const target = findMatchingEntity(rawTarget, entityNames);

      if (source && target && source !== target) {
        const key = `${source.toLowerCase()}|${pattern.relationship}|${target.toLowerCase()}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push({
            source,
            target,
            relationship: pattern.relationship,
            confidence: pattern.confidence,
            context: rawContext,
          });
        }
      }
    }
  }

  return results;
}

/**
 * Try to find a known entity name within a text fragment.
 * Returns the canonical entity name if found.
 */
function findMatchingEntity(
  text: string,
  entityNames: Map<string, string>
): string | null {
  const lower = text.toLowerCase();

  // Direct match
  if (entityNames.has(lower)) return entityNames.get(lower)!;

  // Check if any entity name appears in the text
  for (const [key, name] of entityNames) {
    if (lower.includes(key)) return name;
  }

  return null;
}
