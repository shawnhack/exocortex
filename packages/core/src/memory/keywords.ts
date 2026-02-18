// Tech term aliases for improved FTS recall
const TECH_ALIASES: Record<string, string[]> = {
  kubernetes: ["k8s"],
  typescript: ["ts"],
  javascript: ["js"],
  postgresql: ["postgres", "psql"],
  mongodb: ["mongo"],
  elasticsearch: ["es", "elastic"],
  "machine learning": ["ml"],
  "artificial intelligence": ["ai"],
  "natural language processing": ["nlp"],
  "large language model": ["llm"],
  "continuous integration": ["ci"],
  "continuous deployment": ["cd"],
  "ci/cd": ["cicd", "ci cd"],
  docker: ["container"],
  "react native": ["rn"],
  graphql: ["gql"],
  "visual studio code": ["vscode"],
  redis: ["cache"],
  nginx: ["reverse proxy"],
  "amazon web services": ["aws"],
  "google cloud platform": ["gcp"],
  "microsoft azure": ["azure"],
};

// Common tech terms to extract from content
const TECH_KEYWORDS = new Set([
  "api", "sdk", "cli", "gui", "sql", "nosql", "orm", "rest", "grpc",
  "http", "https", "websocket", "sse", "jwt", "oauth", "saml",
  "react", "vue", "angular", "svelte", "nextjs", "nuxt",
  "node", "deno", "bun", "python", "rust", "golang",
  "docker", "kubernetes", "terraform", "ansible",
  "postgres", "mysql", "sqlite", "redis", "mongodb",
  "aws", "gcp", "azure", "vercel", "netlify",
  "git", "github", "gitlab", "npm", "pnpm", "yarn",
  "webpack", "vite", "esbuild", "rollup", "turbopack",
  "linux", "macos", "windows", "wsl",
  "llm", "rag", "embedding", "vector", "transformer",
  "microservice", "monolith", "serverless", "edge",
  "ci", "cd", "devops", "sre", "monitoring",
  "typescript", "javascript", "python", "rust", "go",
  "testing", "tdd", "e2e", "unit", "integration",
  "caching", "queue", "pubsub", "webhook",
  "migration", "schema", "index", "query",
  "auth", "rbac", "encryption", "tls", "ssl",
  "mcp", "exocortex", "claude", "openai", "anthropic",
]);

/**
 * Generate a keyword string from content for FTS dual-column indexing.
 * Combines entities, tags, key terms, and tech aliases.
 */
export function generateKeywords(
  content: string,
  tags?: string[],
  entities?: string[]
): string {
  const keywords = new Set<string>();

  // 1. Add provided entities
  if (entities) {
    for (const e of entities) {
      keywords.add(e.toLowerCase());
    }
  }

  // 2. Add provided tags
  if (tags) {
    for (const t of tags) {
      keywords.add(t.toLowerCase());
    }
  }

  // 3. Extract key terms from content
  const contentLower = content.toLowerCase();
  const words = contentLower.split(/[\s,;:()[\]{}|/\\]+/);

  // Tech keywords
  for (const word of words) {
    const cleaned = word.replace(/[^a-z0-9-]/g, "");
    if (cleaned.length >= 2 && TECH_KEYWORDS.has(cleaned)) {
      keywords.add(cleaned);
    }
  }

  // Capitalized words (likely proper nouns / project names)
  const capitalizedPattern = /\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]+)*)\b/g;
  let match: RegExpExecArray | null;
  while ((match = capitalizedPattern.exec(content)) !== null) {
    const term = match[1].toLowerCase();
    // Skip very common words
    if (!STOP_WORDS.has(term) && term.length <= 30) {
      keywords.add(term);
    }
  }

  // Hyphenated technical terms (e.g., "real-time", "server-side")
  const hyphenated = /\b([a-z]+-[a-z]+(?:-[a-z]+)*)\b/gi;
  while ((match = hyphenated.exec(content)) !== null) {
    const term = match[1].toLowerCase();
    if (term.length >= 5 && term.length <= 30) {
      keywords.add(term);
    }
  }

  // 4. Add tech aliases for known terms
  for (const kw of Array.from(keywords)) {
    for (const [canonical, aliases] of Object.entries(TECH_ALIASES)) {
      if (kw === canonical || aliases.includes(kw)) {
        keywords.add(canonical);
        for (const alias of aliases) {
          keywords.add(alias);
        }
      }
    }
  }

  // Also check content directly for multi-word tech terms
  for (const [canonical, aliases] of Object.entries(TECH_ALIASES)) {
    if (contentLower.includes(canonical)) {
      keywords.add(canonical);
      for (const alias of aliases) {
        keywords.add(alias);
      }
    }
  }

  // Limit to ~200 chars
  const result: string[] = [];
  let totalLen = 0;
  for (const kw of keywords) {
    if (totalLen + kw.length + 1 > 200) break;
    result.push(kw);
    totalLen += kw.length + 1;
  }

  return result.join(" ");
}

const STOP_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all",
  "can", "had", "her", "was", "one", "our", "out",
  "has", "have", "been", "some", "them", "than",
  "its", "over", "such", "that", "this", "with",
  "will", "each", "make", "like", "from", "just",
  "into", "also", "more", "other", "could", "would",
  "about", "which", "their", "there", "these", "then",
  "what", "when", "where", "who", "how", "why",
  "should", "because", "between", "through", "after",
  "before", "during", "without", "within",
  "here", "very", "being", "does", "done", "both",
  "only", "most", "much", "many", "same", "still",
  "well", "back", "even", "must", "need",
]);
