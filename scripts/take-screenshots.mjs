#!/usr/bin/env node

// Takes screenshots of the dashboard with demo data for the README.
// Usage: cd packages/mcp && node ../../scripts/take-screenshots.mjs
// Requires: playwright installed (via browser-tools dependency)

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
// Memories use entity extraction trigger patterns:
//   Person: "by Alice Chen", "with Bob Park", "author Carol Wu"
//   Project: "working on ProjectAlpha", "building DataStream", "Project NeuralNet"
//   Org: "Acme Labs" (suffix pattern)
//   Tech: direct keyword match (TypeScript, React, PostgreSQL, etc.)
//   Relationships: "X uses Y", "X built with Y", "X works at Y"

const demoMemories = [
  // --- Architecture & decisions ---
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
    content: "Decided to keep all data in a single SQLite database file. WAL mode for concurrent reads. No external database dependency — Node.js 20+ has built-in sqlite module. Backup via VACUUM INTO with nightly rotation.",
    tags: ["decision", "architecture", "sqlite", "storage"],
    importance: 0.85,
    content_type: "note",
  },
  {
    content: "TypeScript monorepo structure with pnpm workspaces: core (storage/retrieval/scoring), mcp (MCP server), server (REST API + dashboard serving), cli (command-line tool), dashboard (React SPA). Each package has its own build step. Tests run from root via vitest.",
    tags: ["architecture", "typescript", "monorepo"],
    importance: 0.7,
    content_type: "note",
  },
  {
    content: "The MCP server communicates over stdio — no HTTP overhead for agent integrations. Tools are registered with Zod schemas for input validation. Compatible with Claude Code, Codex CLI, Gemini CLI, VS Code Copilot, and any MCP-compatible client.",
    tags: ["architecture", "mcp", "integration"],
    importance: 0.8,
    content_type: "note",
  },
  // --- Entity-rich: people, projects, orgs ---
  {
    content: "Meeting notes from Project Alpha kickoff. Presented by Alice Chen — the system architecture uses TypeScript and React on the frontend with a PostgreSQL database. Built with Docker for deployment.",
    tags: ["meeting", "project-alpha", "architecture"],
    importance: 0.75,
    content_type: "note",
  },
  {
    content: "Code review completed by Bob Park for the DataStream ingestion pipeline. DataStream uses Python and Redis for real-time event processing. Performance benchmarks show 12k events/sec throughput.",
    tags: ["code-review", "datastream", "performance"],
    importance: 0.7,
    content_type: "note",
  },
  {
    content: "Research summary by Carol Wu on neural network optimization techniques. Working on NeuralNet — a deep learning framework built with Python and Docker. Targets efficient training on consumer GPUs.",
    tags: ["research", "neuralnet", "deep-learning"],
    importance: 0.75,
    content_type: "note",
  },
  {
    content: "Alice Chen works at Acme Labs as lead architect. She created Project Alpha and designed the TypeScript backend that powers their internal tools. The project depends on PostgreSQL and Redis.",
    tags: ["team", "acme-labs", "project-alpha"],
    importance: 0.7,
    content_type: "note",
  },
  {
    content: "Bob Park joined Acme Labs to lead the DataStream initiative. DataStream uses Redis for caching and PostgreSQL for persistence. Built with Docker containers orchestrated via Kubernetes.",
    tags: ["team", "acme-labs", "datastream"],
    importance: 0.65,
    content_type: "note",
  },
  {
    content: "Sprint retrospective by Alice Chen: Project Alpha frontend migrated from JavaScript to TypeScript. React component library now fully typed. Build times improved 40% after switching to Vite.",
    tags: ["retrospective", "project-alpha", "typescript"],
    importance: 0.6,
    content_type: "note",
  },
  {
    content: "Architecture decision by Bob Park: DataStream will use PostgreSQL for analytics queries and Redis for hot data. The Python workers handle ETL while the TypeScript API serves the dashboard.",
    tags: ["decision", "datastream", "architecture"],
    importance: 0.7,
    content_type: "note",
  },
  // --- Intelligence & features ---
  {
    content: "Entity extraction is regex-based (no ML dependency). Extracts 5 types: technology, organization, person, project, concept. Confidence ranges from 0.4 (concepts) to 0.9 (known tech keywords). Relationships extracted from sentence patterns.",
    tags: ["architecture", "entities", "extraction"],
    importance: 0.75,
    content_type: "note",
  },
  {
    content: "Consolidation uses greedy agglomerative clustering with cosine similarity threshold of 0.75. Clusters of 3+ memories get merged into summaries. Source memories are archived and linked via parent_id.",
    tags: ["architecture", "consolidation", "intelligence"],
    importance: 0.7,
    content_type: "note",
  },
  {
    content: "Implemented automatic importance decay: memories never accessed after 30 days lose importance (down to 0.1). Frequently accessed memories (5+ times) get boosted (up to 0.9). Pinned memories are never adjusted.",
    tags: ["architecture", "importance", "maintenance"],
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
    content: "Plan: Add graph-aware retrieval to search pipeline. Memories linked to top-scoring results should get a proximity boost. Use 1-hop traversal, strength-weighted scoring (0.3-0.8 range). Default graph weight: 0.10 in RRF mode.",
    tags: ["plan", "search", "graph", "retrieval"],
    importance: 0.7,
    content_type: "note",
  },
  // --- Learning & discovery ---
  {
    content: "Key insight: SQLite FTS5 doesn't support phrase queries with leading wildcards. Use prefix queries ('term*') instead of ('*term'). For substring matching, consider a separate trigram index or LIKE queries on small result sets.",
    tags: ["learning", "sqlite", "fts", "search"],
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
    content: "The dashboard uses React 19 with a dark theme. All pages are mobile-responsive (hamburger sidebar at <=768px). Toast notifications replace native alert()/confirm(). Charts use horizontal bar components with gradient fills.",
    tags: ["architecture", "dashboard", "react", "ui"],
    importance: 0.6,
    content_type: "note",
  },
  // --- Session digests ---
  {
    content: "Session 2026-02-15 (project: webapp)\n- Refactored authentication middleware to use JWT refresh tokens\n- Added rate limiting to API endpoints\n- Fixed CORS configuration for production domain\n- Updated test suite for new auth flow\n\nFiles changed: 8 | Commands: 12 | Tools used: 24",
    tags: ["session-digest", "webapp", "auth", "refactor"],
    importance: 0.6,
    content_type: "summary",
  },
  {
    content: "Session 2026-02-18 (project: api-gateway)\n- Designed rate limiting strategy with Redis backing\n- Implemented token bucket algorithm for burst handling\n- Added circuit breaker pattern for downstream service calls\n- Wrote integration tests for failure scenarios\n\nFiles changed: 5 | Commands: 8 | Tools used: 15",
    tags: ["session-digest", "api-gateway", "performance"],
    importance: 0.6,
    content_type: "summary",
  },
  {
    content: "Session 2026-02-20 (project: exocortex)\n- Added retrieval feedback loop with useful_count tracking\n- Implemented store-time relation discovery (auto-link similar memories)\n- Built temporal evolution query for memory_timeline\n- Added graph-aware retrieval with memory-link proximity\n\nFiles changed: 12 | Commands: 6 | Tools used: 32",
    tags: ["session-digest", "exocortex", "retrieval"],
    importance: 0.7,
    content_type: "summary",
  },
  {
    content: "Session 2026-02-22 (project: project-alpha)\n- Created by Carol Wu: NeuralNet training pipeline with Python\n- Deployed DataStream workers to Docker containers\n- Bob Park optimized PostgreSQL query plans for analytics dashboard\n\nFiles changed: 9 | Commands: 14 | Tools used: 20",
    tags: ["session-digest", "project-alpha", "deployment"],
    importance: 0.65,
    content_type: "summary",
  },
  // --- More cross-referencing ---
  {
    content: "Deduplication compares new memories against the 50 most recent active memories of the same content type. If cosine similarity exceeds 0.85 and tags overlap, the old memory is superseded — marked inactive with superseded_by pointing to the new one.",
    tags: ["architecture", "dedup", "intelligence"],
    importance: 0.65,
    content_type: "note",
  },
  {
    content: "Search friction tracking: zero-result queries are logged to a search_misses table. Maintenance surfaces the top missed queries, revealing gaps in indexed knowledge. Helps identify what should be stored or better tagged.",
    tags: ["architecture", "search", "intelligence", "maintenance"],
    importance: 0.6,
    content_type: "note",
  },
];

const demoGoals = [
  {
    title: "Ship v1.0 public release",
    description: "Finalize API stability, write migration guide, publish to npm.",
    priority: "critical",
    deadline: "2026-03-15",
  },
  {
    title: "Add multi-modal memory support",
    description: "Support images and audio alongside text memories. Requires new embedding pipeline.",
    priority: "high",
    deadline: "2026-04-01",
  },
  {
    title: "Improve search recall for short queries",
    description: "Short queries (1-2 words) often miss relevant results. Investigate query expansion and synonym matching.",
    priority: "medium",
  },
];

// Milestones to add to goals after creation (index → milestones array)
const goalMilestones = [
  // Goal 0: Ship v1.0
  [
    { id: "m1", title: "Freeze public API surface", status: "completed", order: 0, deadline: null, completed_at: "2026-02-10 14:30:00" },
    { id: "m2", title: "Write migration guide from v0.x", status: "in_progress", order: 1, deadline: "2026-03-01", completed_at: null },
    { id: "m3", title: "Set up CI/CD for npm publish", status: "pending", order: 2, deadline: "2026-03-10", completed_at: null },
    { id: "m4", title: "Final QA and release", status: "pending", order: 3, deadline: "2026-03-15", completed_at: null },
  ],
  // Goal 1: Multi-modal
  [
    { id: "m5", title: "Research image embedding models", status: "completed", order: 0, deadline: null, completed_at: "2026-02-20 09:00:00" },
    { id: "m6", title: "Design storage schema for binary assets", status: "in_progress", order: 1, deadline: "2026-03-15", completed_at: null },
    { id: "m7", title: "Implement image memory pipeline", status: "pending", order: 2, deadline: "2026-03-30", completed_at: null },
  ],
  // Goal 2: Search recall
  [
    { id: "m8", title: "Benchmark current recall on test queries", status: "completed", order: 0, deadline: null, completed_at: "2026-02-18 16:00:00" },
    { id: "m9", title: "Implement query expansion with synonyms", status: "pending", order: 1, deadline: null, completed_at: null },
  ],
];

// Entity tags for better display
const entityTagMap = {
  // Technologies
  react: ["technology", "frontend"], typescript: ["technology", "language"],
  javascript: ["technology", "language"],
  sqlite: ["technology", "database"], "node.js": ["technology", "runtime"],
  python: ["technology", "language"], postgresql: ["technology", "database"],
  redis: ["technology", "database"], docker: ["technology", "devops"],
  kubernetes: ["technology", "devops"], vite: ["technology", "tooling"],
  vitest: ["technology", "testing"], playwright: ["technology", "testing"],
  pnpm: ["technology", "tooling"], jwt: ["technology", "auth"],
  // People
  "alice chen": ["person", "engineering"], "bob park": ["person", "engineering"],
  "carol wu": ["person", "research"],
  // Projects
  "project alpha": ["project", "internal"], datastream: ["project", "data"],
  neuralnet: ["project", "ml"],
  // Organizations
  "acme labs": ["organization", "company"],
  "hugging face": ["organization", "ml"], huggingface: ["organization", "ml"],
  // Protocols & products
  mcp: ["protocol", "ai"], claude: ["product", "ai"],
  // Concepts
  "reciprocal rank fusion": ["scoring", "algorithm"], rrf: ["scoring", "algorithm"],
  "deep learning": ["concept", "ml"],
};

// --- Helpers ---

async function waitForServer(url, maxWaitMs = 30000) {
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

async function seedData(baseUrl) {
  // Seed memories
  console.log(`  seeding ${demoMemories.length} memories...`);
  for (const mem of demoMemories) {
    const res = await fetch(`${baseUrl}/api/memories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mem),
    });
    if (!res.ok) console.warn(`  WARN: memory seed failed: ${res.status}`);
  }

  // Seed goals
  console.log(`  seeding ${demoGoals.length} goals with milestones...`);
  const goalIds = [];
  for (const goal of demoGoals) {
    const res = await fetch(`${baseUrl}/api/goals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(goal),
    });
    if (res.ok) {
      const data = await res.json();
      goalIds.push(data.id);
    } else {
      console.warn(`  WARN: goal seed failed: ${res.status}`);
      goalIds.push(null);
    }
  }

  // Add milestones to goals via metadata PATCH
  for (let i = 0; i < goalIds.length; i++) {
    const goalId = goalIds[i];
    const milestones = goalMilestones[i];
    if (!goalId || !milestones) continue;

    await fetch(`${baseUrl}/api/goals/${goalId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ metadata: { milestones } }),
    });
  }
}

async function tagEntities(baseUrl) {
  const entRes = await fetch(`${baseUrl}/api/entities`);
  const entData = await entRes.json();
  const entities = entData.results ?? [];
  console.log(`  tagging ${entities.length} extracted entities...`);

  for (const entity of entities) {
    const key = entity.name.toLowerCase();
    const tags = entityTagMap[key];
    if (tags) {
      await fetch(`${baseUrl}/api/entities/${entity.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags }),
      });
    }
  }

  return entities;
}

// --- Main ---

// Clean up any previous temp DB
for (const suffix of ["", "-wal", "-shm", "-journal"]) {
  const f = TEMP_DB + suffix;
  try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
}

// Ensure output directory exists
fs.mkdirSync(OUT, { recursive: true });

console.log("Starting temp server on port " + PORT + "...");

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

  // Let enrichment (entity extraction, auto-tags, embeddings) settle
  console.log("Waiting for enrichment to complete...");
  await new Promise((r) => setTimeout(r, 5000));

  // Tag extracted entities for better display
  console.log("Tagging entities...");
  const entities = await tagEntities(BASE);

  console.log("Taking screenshots...\n");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  });

  // 1. Dashboard (sources overview with charts)
  {
    const page = await context.newPage();
    console.log("  1/6 dashboard...");
    await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(OUT, "dashboard.png"), type: "png" });
    await page.close();
  }

  // 2. Memories (search page with results)
  {
    const page = await context.newPage();
    console.log("  2/6 memories...");
    await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(1000);
    const input = page.locator('input[type="search"], input[placeholder*="earch"]');
    await input.fill("architecture decisions");
    await input.press("Enter");
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(OUT, "memories.png"), type: "png" });
    await page.close();
  }

  // 3. Entities (entity list)
  {
    const page = await context.newPage();
    console.log("  3/6 entities...");
    await page.goto(`${BASE}/entities`, { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(OUT, "entities.png"), type: "png" });
    await page.close();
  }

  // 4. Graph (knowledge graph — extra wait for force simulation)
  {
    const page = await context.newPage();
    console.log("  4/6 graph...");
    await page.goto(`${BASE}/graph`, { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(5000); // let force simulation settle
    await page.screenshot({ path: path.join(OUT, "graph.png"), type: "png" });
    await page.close();
  }

  // 5. Goals (goals with milestones — click first goal to expand)
  {
    const page = await context.newPage();
    console.log("  5/6 goals...");
    await page.goto(`${BASE}/goals`, { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(1500);
    // Click the first goal card to expand and show milestones
    const goalCard = page.locator('div[style*="cursor: pointer"]').first();
    if (await goalCard.count() > 0) {
      await goalCard.click();
      await page.waitForTimeout(2000); // wait for expanded detail + milestones to load
    }
    await page.screenshot({ path: path.join(OUT, "goals.png"), type: "png" });
    await page.close();
  }

  // 6. Entity detail — pick an entity with the most relationships for a rich screenshot
  {
    const page = await context.newPage();
    console.log("  6/6 entity-detail...");
    // Prefer entities with tags (tagged = richer display)
    const tagged = entities.filter((e) => e.tags?.length > 0);
    // Pick one likely to have relationships: try TypeScript, React, or first tagged
    const preferred = ["typescript", "react", "postgresql", "project alpha"];
    let entityId = null;
    for (const name of preferred) {
      const match = entities.find((e) => e.name.toLowerCase() === name);
      if (match) { entityId = match.id; break; }
    }
    if (!entityId) entityId = tagged[0]?.id ?? entities[0]?.id;

    if (entityId) {
      await page.goto(`${BASE}/entities/${entityId}`, { waitUntil: "networkidle", timeout: 20000 });
      await page.waitForTimeout(2000);
      await page.screenshot({ path: path.join(OUT, "entity-detail.png"), type: "png" });
    } else {
      console.log("    skipped — no entities found");
    }
    await page.close();
  }

  await browser.close();
  console.log("\nDone — 6 screenshots saved to docs/screenshots/");
} finally {
  server.kill();
  // Wait for server to fully exit before cleaning temp files
  await new Promise((r) => setTimeout(r, 2000));
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const f = TEMP_DB + suffix;
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
  }
}
