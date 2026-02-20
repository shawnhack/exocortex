const TECH_KEYWORDS = new Set([
  "react", "typescript", "javascript", "python", "rust", "go", "java", "ruby",
  "sqlite", "postgres", "postgresql", "mysql", "mongodb", "redis", "dynamodb",
  "node", "nodejs", "deno", "bun", "express", "fastify", "nextjs", "remix",
  "vite", "webpack", "rollup", "esbuild", "turbopack",
  "docker", "kubernetes", "aws", "azure", "gcp", "vercel", "cloudflare",
  "graphql", "rest", "grpc", "websocket",
  "git", "github", "gitlab", "npm", "pnpm", "yarn",
  "vue", "svelte", "angular", "solid", "astro",
  "tailwind", "css", "html", "sass",
  "vitest", "jest", "playwright", "cypress",
  "openai", "anthropic", "claude", "llm", "embeddings", "rag",
  "linux", "windows", "macos",
]);

const TOPIC_PATTERNS: Array<{ pattern: RegExp; tag: string }> = [
  { pattern: /\b(?:decided|decision|chose|choosing|trade-?off)\b/i, tag: "decision" },
  { pattern: /\b(?:bug|fix(?:ed)?|broke|broken|crash|error|issue)\b/i, tag: "bug" },
  { pattern: /\b(?:architect(?:ure)?|design(?:ed)?|pattern|structure)\b/i, tag: "architecture" },
  { pattern: /\b(?:lesson|learned|insight|takeaway|realization)\b/i, tag: "lesson" },
  { pattern: /\b(?:config(?:uration)?|setting|env(?:ironment)?|\.env)\b/i, tag: "config" },
  { pattern: /\b(?:perf(?:ormance)?|optimi[sz](?:e|ation)|slow|fast|latency|benchmark)\b/i, tag: "performance" },
  { pattern: /\b(?:deploy(?:ment)?|ci\/cd|pipeline|release|ship(?:ping)?)\b/i, tag: "deployment" },
  { pattern: /\b(?:test(?:ing|s)?|spec|coverage|assertion|mock)\b/i, tag: "testing" },
  { pattern: /\b(?:refactor(?:ing|ed)?|cleanup|reorgani[sz]e|restructure)\b/i, tag: "refactor" },
  { pattern: /\b(?:secur(?:ity|e)|auth(?:entication)?|vulnerabilit(?:y|ies)|xss|csrf|injection)\b/i, tag: "security" },
];

const PROJECT_BLOCKLIST = new Set([
  "built-in", "real-time", "re-use", "re-run", "pre-commit", "pre-build",
  "post-build", "non-null", "non-empty", "up-to-date", "end-to-end",
  "out-of-date", "day-to-day", "step-by-step", "case-by-case",
  "long-term", "short-term", "high-level", "low-level",
]);

const PROJECT_PATTERN = /\b([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\b/g;

/**
 * Auto-generate up to 5 tags from memory content.
 * Uses tech keywords, topic patterns, and kebab-case project names.
 */
export function autoGenerateTags(content: string): string[] {
  PROJECT_PATTERN.lastIndex = 0;
  const tags = new Set<string>();

  // 1. Tech keywords
  const words = content.toLowerCase().split(/[\s,.:;!?()[\]{}"'`/\\]+/);
  for (const word of words) {
    if (TECH_KEYWORDS.has(word) && tags.size < 5) {
      tags.add(word);
    }
  }

  // 2. Topic patterns
  for (const { pattern, tag } of TOPIC_PATTERNS) {
    if (tags.size >= 5) break;
    if (pattern.test(content)) {
      tags.add(tag);
    }
  }

  // 3. Project names (kebab-case)
  if (tags.size < 5) {
    let match: RegExpExecArray | null;
    while ((match = PROJECT_PATTERN.exec(content)) !== null) {
      if (tags.size >= 5) break;
      const name = match[1].toLowerCase();
      if (!PROJECT_BLOCKLIST.has(name) && name.length >= 3 && name.length <= 30) {
        tags.add(name);
      }
    }
  }

  return Array.from(tags);
}
