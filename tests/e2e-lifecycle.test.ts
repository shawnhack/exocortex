import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { closeDb, getDb, initializeSchema } from "@exocortex/core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_ENTRY = path.join(ROOT, "packages/cli/dist/index.js");

function envWith(overrides: Record<string, string>): Record<string, string> {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => typeof value === "string")
  ) as Record<string, string>;
  return { ...base, ...overrides };
}

function randomPort(): number {
  return 21000 + Math.floor(Math.random() * 2000);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(baseUrl: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {}
    await sleep(300);
  }
  throw new Error(`Server did not become healthy within ${timeoutMs}ms`);
}

async function requestJson<T>(baseUrl: string, pathName: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl}${pathName}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${pathName}: ${JSON.stringify(body)}`);
  }
  return body as T;
}

async function runCliImport(filePath: string, dbPath: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [CLI_ENTRY, "import", filePath],
      {
        cwd: ROOT,
        env: envWith({ EXOCORTEX_DB_PATH: dbPath }),
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

let tempDir = "";
let dbPath = "";
let importDbPath = "";
let backupPath = "";
let port = 0;
let baseUrl = "";
let server: ChildProcess | null = null;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "exo-e2e-lifecycle-"));
  dbPath = path.join(tempDir, "server.db");
  importDbPath = path.join(tempDir, "import.db");
  backupPath = path.join(tempDir, "backup.json");
  port = randomPort();
  baseUrl = `http://127.0.0.1:${port}`;

  server = spawn(
    process.execPath,
    [CLI_ENTRY, "serve", "-p", String(port)],
    {
      cwd: ROOT,
      env: envWith({ EXOCORTEX_DB_PATH: dbPath }),
      stdio: "ignore",
    }
  );

  await waitForHealth(baseUrl);
}, 60_000);

afterEach(async () => {
  if (server) {
    server.kill();
    await sleep(1200);
    server = null;
  }

  closeDb(dbPath);
  closeDb(importDbPath);

  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("lifecycle e2e", () => {
  it("supports create -> search -> update -> archive -> restore -> export -> import", async () => {
    const token = `E2E-LIFECYCLE-${Date.now()}`;
    const created = await requestJson<{ id: string; content: string }>(baseUrl, "/api/memories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: `Initial lifecycle content ${token}`,
        content_type: "note",
        source: "api",
        tags: ["e2e", "lifecycle"],
        importance: 0.7,
      }),
    });

    expect(created.id).toBeTruthy();

    const search = await requestJson<{ count: number; results: Array<{ memory: { id: string } }> }>(
      baseUrl,
      "/api/memories/search",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: token, limit: 10 }),
      }
    );
    expect(search.count).toBeGreaterThan(0);
    expect(search.results.some((r) => r.memory.id === created.id)).toBe(true);

    const updatedContent = `Updated lifecycle content ${token}`;
    const updated = await requestJson<{ id: string; content: string; tags: string[] }>(
      baseUrl,
      `/api/memories/${created.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: updatedContent,
          tags: ["e2e", "lifecycle", "updated"],
          importance: 0.8,
        }),
      }
    );
    expect(updated.content).toContain("Updated lifecycle content");
    expect(updated.tags).toContain("updated");

    await requestJson(baseUrl, `/api/memories/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ is_active: false }),
    });

    const archived = await requestJson<{ count: number; results: Array<{ id: string }> }>(
      baseUrl,
      "/api/memories/archived?limit=20&offset=0"
    );
    expect(archived.results.some((m) => m.id === created.id)).toBe(true);

    const restored = await requestJson<{ ok: boolean }>(
      baseUrl,
      `/api/memories/${created.id}/restore`,
      { method: "POST" }
    );
    expect(restored.ok).toBe(true);

    const fetched = await requestJson<{ id: string; is_active: boolean; content: string }>(
      baseUrl,
      `/api/memories/${created.id}`
    );
    expect(fetched.is_active).toBe(true);
    expect(fetched.content).toContain("Updated lifecycle content");

    const backup = await requestJson<{
      version: number;
      memories: Array<{ id: string; content: string }>;
    }>(baseUrl, "/api/export");
    expect(backup.version).toBe(1);
    expect(backup.memories.some((m) => m.id === created.id)).toBe(true);

    fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2), "utf8");

    const imported = await runCliImport(backupPath, importDbPath);
    expect(imported.code).toBe(0);

    const importedDb = getDb(importDbPath);
    initializeSchema(importedDb);

    const importedRow = importedDb
      .prepare("SELECT content, is_active FROM memories WHERE id = ?")
      .get(created.id) as { content: string; is_active: number } | undefined;
    expect(importedRow).toBeTruthy();
    expect(importedRow!.content).toContain("Updated lifecycle content");
    expect(importedRow!.is_active).toBe(1);
  });
});
  if (!fs.existsSync(CLI_ENTRY)) {
    throw new Error("Missing CLI build at packages/cli/dist/index.js. Run: pnpm build");
  }
