import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "@exocortex/server";
import {
  closeDb,
  EntityStore,
  getDb,
  initializeSchema,
  MemoryStore,
  setSetting,
} from "@exocortex/core";

let tempDir = "";
let app = createApp();

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "exo-server-test-"));
  process.env.EXOCORTEX_DB_PATH = path.join(tempDir, "test.db");
  delete process.env.EXOCORTEX_CORS_ORIGINS;
  closeDb();
  initializeSchema(getDb());
  app = createApp();
});

afterEach(() => {
  closeDb();
  delete process.env.EXOCORTEX_DB_PATH;
  delete process.env.EXOCORTEX_CORS_ORIGINS;
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("server routes", () => {
  it("masks sensitive settings including short secrets", async () => {
    const db = getDb();
    setSetting(db, "ai.api_key", "abcd");
    setSetting(db, "service.token", "tok123");
    setSetting(db, "scoring.min_score", "0.15");

    const res = await app.request("http://localhost/api/settings");
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, string>;
    expect(body["ai.api_key"]).toBe("••••");
    expect(body["service.token"]).toBe("to••••23");
    expect(body["scoring.min_score"]).toBe("0.15");
  });

  it("does not emit CORS headers by default", async () => {
    const res = await app.request("http://localhost/api/settings", {
      headers: { origin: "http://evil.example" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("emits CORS headers only for configured origins", async () => {
    process.env.EXOCORTEX_CORS_ORIGINS = "http://localhost:4001";
    app = createApp();

    const allowed = await app.request("http://localhost/api/settings", {
      headers: { origin: "http://localhost:4001" },
    });
    const blocked = await app.request("http://localhost/api/settings", {
      headers: { origin: "http://evil.example" },
    });

    expect(allowed.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:4001"
    );
    expect(blocked.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects non-string settings patch values", async () => {
    const res = await app.request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "importance.boost_threshold": 5 }),
    });

    expect(res.status).toBe(400);
  });

  it("clamps and defaults numeric query params for recent memories", async () => {
    const store = new MemoryStore(getDb());
    await store.create({ content: "A" });
    await store.create({ content: "B" });
    await store.create({ content: "C" });

    const res = await app.request("http://localhost/api/memories/recent?limit=NaN&offset=-10");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { count: number; results: Array<{ content: string }> };
    expect(body.count).toBe(3);
    expect(body.results.map((r) => r.content)).toEqual(["C", "B", "A"]);
  });

  it("rejects invalid contradictions status filters", async () => {
    const res = await app.request("http://localhost/api/contradictions?status=bad");
    expect(res.status).toBe(400);
  });

  it("returns linked memories for entity without N+1 lookups", async () => {
    const db = getDb();
    const entityStore = new EntityStore(db);
    const memoryStore = new MemoryStore(db);

    const entity = entityStore.create({ name: "Exocortex" });
    const first = await memoryStore.create({ content: "First memory" });
    const second = await memoryStore.create({ content: "Second memory" });

    entityStore.linkMemory(entity.id, first.memory.id, 0.2);
    entityStore.linkMemory(entity.id, second.memory.id, 0.9);

    const res = await app.request(`http://localhost/api/entities/${entity.id}/memories`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { count: number; memories: Array<{ id: string }> };
    expect(body.count).toBe(2);
    expect(body.memories.map((m) => m.id)).toEqual([second.memory.id, first.memory.id]);
  });

  it("allows clearing goal description and deadline with null", async () => {
    const created = await app.request("http://localhost/api/goals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Goal to clear",
        description: "temp",
        deadline: "2026-12-31",
      }),
    });
    expect(created.status).toBe(201);
    const goal = (await created.json()) as { id: string };

    const patched = await app.request(`http://localhost/api/goals/${goal.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: null, deadline: null }),
    });
    expect(patched.status).toBe(200);

    const body = (await patched.json()) as {
      description: string | null;
      deadline: string | null;
    };
    expect(body.description).toBeNull();
    expect(body.deadline).toBeNull();
  });
});
