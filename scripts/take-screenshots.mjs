#!/usr/bin/env node

// Takes screenshots of the dashboard with demo data for the README.
// Usage: cd packages/mcp && node ../../scripts/take-screenshots.mjs
// Requires: playwright installed (via packages/mcp dependency)

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = path.resolve(ROOT, "docs/screenshots");
const TEMP_DB = path.join(ROOT, ".screenshot-temp.db");
const PORT = 13210;
const BASE = `http://localhost:${PORT}`;

// --- Demo data ---

const demoMemories = [
  {
    content: "Decided to use Reciprocal Rank Fusion (RRF) as the default scoring mode instead of weighted averages. RRF is more robust to outliers and doesn't require manual weight tuning — it fuses ranked lists from vector similarity and BM25 full-text search using reciprocal rank positions.",
    tags: ["architecture", "decision", "scoring", "search"],
    importance: 0.85,
    content_type: "note",
  },
  {
    content: "The embedding model (all-MiniLM-L6-v2) runs locally via HuggingFace transformers — no API keys needed. 384 dimensions, ~80MB download on first build. Produces good results for English text at minimal latency.",
    tags: ["architecture", "embeddings", "performance"],
    importance: 0.8,
    content_type: "note",
  },
  {
    content: "Entity extraction is regex-based (no ML dependency). Extracts 5 types: technology, organization, person, project, concept. Confidence ranges from 0.4 (concepts) to 0.9 (known tech keywords). Relationships extracted from sentence patterns like 'X uses Y' and 'X built with Y'.",
    tags: ["architecture", "entities", "extraction"],
    importance: 0.75,
    content_type: "note",
  },
  {
    content: "Session 2026-02-15 (project: webapp)\n- Refactored authentication middleware to use JWT refresh tokens\n- Added rate limiting to API endpoints (express-rate-limit)\n- Fixed CORS configuration for production domain\n- Updated test suite for new auth flow\n\nFiles changed: 8 | Commands: 12 | Tools used: 24",
    tags: ["session-digest", "webapp", "auth", "refactor"],
    importance: 0.6,
    content_type: "summary",
  },
  {
    content: "Key insight: SQLite FTS5 doesn't support phrase queries with leading wildcards. Use prefix queries ('term*') instead of ('*term'). For substring matching, consider a separate trigram index or LIKE queries on small result sets.",
    tags: ["learning", "sqlite", "fts", "search"],
    importance: 0.7,
    content_type: "note",
  },
  {
    content: "Consolidation uses greedy agglomerative clustering with cosine similarity threshold of 0.75. Clusters of 3+ memories get merged into summaries. Source memories are archived and linked via parent_id. This keeps the active memory set lean without losing information.",
    tags: ["architecture", "consolidation", "intelligence"],
    importance: 0.7,
    content_type: "note",
  },
  {
    content: "Discovered that node:sqlite returns BigInt for rowid values, which silently fails Map lookups when using Number keys. Always use String() for rowid Map keys to avoid type mismatch bugs.",
    tags: ["discovery", "sqlite", "bug", "node"],
    importance: 0.75,
    content_type: "note",
  },
  {
    content: "The MCP server communicates over stdio — no HTTP overhead for agent integrations. Tools are registered with Zod schemas for input validation. Works with Claude Code, Codex CLI, Gemini CLI, VS Code Copilot, and any other MCP-compatible client.",
    tags: ["architecture", "mcp", "integration"],
    importance: 0.8,
    content_type: "note",
  },
  {
    content: "Implemented automatic importance decay: memories never accessed after 30 days lose importance (down to 0.1). Frequently accessed memories (5+ times) get boosted (up to 0.9). Memories pinned at importance 1.0 are never adjusted. This creates a natural knowledge lifecycle.",
    tags: ["architecture", "importance", "maintenance"],
    importance: 0.7,
    content_type: "note",
  },
  {
    content: "Plan: Add graph-aware retrieval to search pipeline. Memories linked to top-scoring results should get a proximity boost. Use 1-hop traversal via MemoryLinkStore, strength-weighted scoring (0.3-0.8 range). Default graph weight: 0.10 in RRF mode.",
    tags: ["plan", "search", "graph", "retrieval"],
    importance: 0.7,
    content_type: "note",
  },
  {
    content: "The dashboard uses React 19 with a Neural Interface dark theme. All pages are mobile-responsive (hamburger sidebar at <=768px). Toast notifications replace native alert()/confirm(). Charts use horizontal bar components with gradient fills.",
    tags: ["architecture", "dashboard", "react", "ui"],
    importance: 0.6,
    content_type: "note",
  },
  {
    content: "Deduplication compares new memories against the 50 most recent active memories of the same content type. If cosine similarity exceeds 0.85 and tags overlap, the old memory is superseded — marked inactive with superseded_by pointing to the new one.",
    tags: ["architecture", "dedup", "intelligence"],
    importance: 0.65,
    content_type: "note",
  },
  {
    content: "Session 2026-02-18 (project: api-gateway)\n- Designed rate limiting strategy: sliding window with Redis backing\n- Implemented token bucket algorithm for burst handling\n- Added circuit breaker pattern for downstream service calls\n- Wrote integration tests for failure scenarios\n\nFiles changed: 5 | Commands: 8 | Tools used: 15",
    tags: ["session-digest", "api-gateway", "performance"],
    importance: 0.6,
    content_type: "summary",
  },
  {
    content: "Decided to keep all data in a single SQLite database file (~/.exocortex/exocortex.db). WAL mode for concurrent reads. No external database dependency — Node.js 20+ has built-in sqlite module. Backup via VACUUM INTO with nightly rotation.",
    tags: ["decision", "architecture", "sqlite", "storage"],
    importance: 0.85,
    content_type: "note",
  },
  {
    content: "Search friction tracking: zero-result queries are logged to a search_misses table. Maintenance surfaces the top missed queries, revealing gaps in indexed knowledge. Helps identify what should be stored or better tagged.",
    tags: ["architecture", "search", "intelligence", "maintenance"],
    importance: 0.6,
    content_type: "note",
  },
  {
    content: "TypeScript monorepo structure with pnpm workspaces: core (storage/retrieval/scoring), mcp (MCP server), server (REST API + dashboard serving), cli (command-line tool), dashboard (React SPA). Each package has its own build step. Tests run from root via vitest.",
    tags: ["architecture", "typescript", "monorepo"],
    importance: 0.7,
    content_type: "note",
  },
  {
    content: "Contradiction detection finds memory pairs with high semantic similarity (>0.7) that contain conflicting statements — negations, value changes, or reversed positions. Detected contradictions can be resolved or dismissed via the dashboard.",
    tags: ["architecture", "contradictions", "intelligence"],
    importance: 0.6,
    content_type: "note",
  },
  {
    content: "Session 2026-02-20 (project: exocortex)\n- Added retrieval feedback loop with useful_count tracking\n- Implemented store-time relation discovery (auto-link similar memories)\n- Built temporal evolution query for memory_timeline\n- Added graph-aware retrieval with memory-link proximity\n\nFiles changed: 12 | Commands: 6 | Tools used: 32",
    tags: ["session-digest", "exocortex", "retrieval"],
    importance: 0.7,
    content_type: "summary",
  },
];

// --- Helpers ---

async function waitForServer(url, maxWaitMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server did not start within ${maxWaitMs}ms`);
}

const demoGoals = [
  { title: "Ship v1.0 public release", description: "Finalize API stability, write migration guide, publish to npm.", priority: "critical" },
  { title: "Add multi-modal memory support", description: "Support images and audio alongside text memories. Requires new embedding pipeline.", priority: "high" },
  { title: "Improve search recall for short queries", description: "Short queries (1-2 words) often miss relevant results. Investigate query expansion and synonym matching.", priority: "medium" },
  { title: "Write contributor guide", description: "Document architecture, setup instructions, and contribution workflow for open-source contributors.", priority: "low" },
];

async function seedData(baseUrl) {
  for (const mem of demoMemories) {
    await fetch(`${baseUrl}/api/memories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mem),
    });
  }
  for (const goal of demoGoals) {
    await fetch(`${baseUrl}/api/goals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(goal),
    });
  }
}

// --- Main ---

// Clean up any previous temp DB
if (fs.existsSync(TEMP_DB)) fs.unlinkSync(TEMP_DB);

console.log("Starting temp server with demo data...");

const server = spawn(
  "node",
  [path.join(ROOT, "packages/cli/dist/index.js"), "serve", "-p", String(PORT)],
  {
    env: { ...process.env, EXOCORTEX_DB_PATH: TEMP_DB },
    stdio: "ignore",
  }
);

try {
  await waitForServer(BASE);
  console.log("Server ready. Seeding demo data...");
  await seedData(BASE);
  // Let enrichment (entities, tags) settle
  await new Promise((r) => setTimeout(r, 3000));

  // Tag extracted entities for screenshot showcase
  console.log("Tagging entities...");
  const entRes = await fetch(`${BASE}/api/entities`);
  const entData = await entRes.json();
  const tagMap = {
    // Technologies
    react: ["technology", "frontend"], typescript: ["technology", "language"],
    sqlite: ["technology", "database"], "node.js": ["technology", "runtime"],
    hono: ["technology", "backend"], vite: ["technology", "tooling"],
    vitest: ["technology", "testing"], playwright: ["technology", "testing"],
    redis: ["technology", "database"], docker: ["technology", "devops"],
    tailwind: ["technology", "frontend"], pnpm: ["technology", "tooling"],
    zod: ["technology", "validation"], "react query": ["technology", "frontend"],
    "tanstack query": ["technology", "frontend"], jwt: ["technology", "auth"],
    // Organizations
    anthropic: ["organization", "ai"], openai: ["organization", "ai"],
    "hugging face": ["organization", "ml"], huggingface: ["organization", "ml"],
    github: ["platform", "devops"], cloudflare: ["platform", "infrastructure"],
    // Protocols & products
    mcp: ["protocol", "ai"], "model context protocol": ["protocol", "ai"],
    claude: ["product", "ai"], gemini: ["product", "ai"], codex: ["product", "ai"],
    // Concepts
    "reciprocal rank fusion": ["scoring", "algorithm"], rrf: ["scoring", "algorithm"],
    bm25: ["scoring", "algorithm"], wal: ["database", "concept"],
  };
  for (const entity of entData.results ?? []) {
    const key = entity.name.toLowerCase();
    const tags = tagMap[key];
    if (tags) {
      await fetch(`${BASE}/api/entities/${entity.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags }),
      });
    }
  }

  console.log("Taking screenshots...");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  });

  // Dashboard
  {
    const page = await context.newPage();
    console.log("  dashboard...");
    await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle", timeout: 15000 });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(OUT, "dashboard.png"), type: "png" });
    await page.close();
  }

  // Search with results
  {
    const page = await context.newPage();
    console.log("  search...");
    await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 15000 });
    await page.waitForTimeout(1000);
    const input = page.locator('input[type="search"], input[placeholder*="earch"]');
    await input.fill("architecture decisions");
    await input.press("Enter");
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(OUT, "search.png"), type: "png" });
    await page.close();
  }

  // Timeline
  {
    const page = await context.newPage();
    console.log("  timeline...");
    await page.goto(`${BASE}/timeline`, { waitUntil: "networkidle", timeout: 15000 });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(OUT, "timeline.png"), type: "png" });
    await page.close();
  }

  // Entities
  {
    const page = await context.newPage();
    console.log("  entities...");
    await page.goto(`${BASE}/entities`, { waitUntil: "networkidle", timeout: 15000 });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(OUT, "entities.png"), type: "png" });
    await page.close();
  }

  // Entity detail — pick first entity
  {
    const page = await context.newPage();
    console.log("  entity detail...");
    const res = await fetch(`${BASE}/api/entities`);
    const data = await res.json();
    // Pick an entity with tags for a better screenshot
    const tagged = (data.results ?? []).find(e => e.tags?.length > 0);
    const entityId = tagged?.id ?? data.results?.[0]?.id;
    if (entityId) {
      await page.goto(`${BASE}/entities/${entityId}`, { waitUntil: "networkidle", timeout: 15000 });
      await page.waitForTimeout(2000);
      await page.screenshot({ path: path.join(OUT, "entity-detail.png"), type: "png" });
    } else {
      console.log("    skipped — no entities found");
    }
    await page.close();
  }

  // Graph
  {
    const page = await context.newPage();
    console.log("  graph...");
    await page.goto(`${BASE}/graph`, { waitUntil: "networkidle", timeout: 15000 });
    await page.waitForTimeout(4000); // let force simulation settle
    await page.screenshot({ path: path.join(OUT, "graph.png"), type: "png" });
    await page.close();
  }

  // Goals
  {
    const page = await context.newPage();
    console.log("  goals...");
    await page.goto(`${BASE}/goals`, { waitUntil: "networkidle", timeout: 15000 });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(OUT, "goals.png"), type: "png" });
    await page.close();
  }

  await browser.close();
  console.log("Done — screenshots saved to docs/screenshots/");
} finally {
  server.kill();
  // Wait for server to fully exit before cleaning temp files
  await new Promise((r) => setTimeout(r, 2000));
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const f = TEMP_DB + suffix;
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
  }
}
