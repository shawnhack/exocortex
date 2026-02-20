import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb, getDb, initializeSchema, setSetting } from "@exocortex/core";

describe("MCP memory tools", () => {
  it("stores benchmark metadata and requires include_metadata when excluded by default", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "exo-mcp-test-"));
    const dbPath = path.join(tempDir, "test.db");

    process.env.EXOCORTEX_DB_PATH = dbPath;
    process.env.EXOCORTEX_MCP_NO_AUTOSTART = "1";
    process.env.EXOCORTEX_SKIP_EMBEDDING_WARMUP = "1";
    closeDb();

    const db = getDb();
    initializeSchema(db);
    setSetting(db, "search.metadata_mode", "exclude");

    const mod = await import("../packages/mcp/src/index.ts");
    const getTool = (name: string) =>
      mod.getRegisteredToolForTesting(name) as {
        handler: (args: any) => Promise<{ content: Array<{ text: string }> }>;
      };

    const storeTool = getTool("memory_store");
    const searchTool = getTool("memory_search");

    const storeRes = await storeTool.handler({
      content: "Regression drift report from MCP integration test",
      benchmark: true,
      tags: ["retrieval-regression"],
    });
    expect(storeRes.content[0].text).toContain("Stored memory");

    const hiddenRes = await searchTool.handler({
      query: "regression drift report",
      limit: 5,
    });
    expect(hiddenRes.content[0].text).toContain("No memories found");

    const shownRes = await searchTool.handler({
      query: "regression drift report",
      limit: 5,
      include_metadata: true,
    });
    expect(shownRes.content[0].text).toContain("Found");

    closeDb();
    delete process.env.EXOCORTEX_DB_PATH;
    delete process.env.EXOCORTEX_MCP_NO_AUTOSTART;
    delete process.env.EXOCORTEX_SKIP_EMBEDDING_WARMUP;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
