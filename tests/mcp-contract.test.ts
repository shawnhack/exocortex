import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MCP_ENTRY = path.join(ROOT, "packages/mcp/dist/index.js");
const { Client } = require("@modelcontextprotocol/sdk/client");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

function envWith(overrides: Record<string, string>): Record<string, string> {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => typeof value === "string")
  ) as Record<string, string>;
  return { ...base, ...overrides };
}

function extractText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> })?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c?.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

function extractFirstIdFromText(text: string): string | null {
  const bracketMatch = text.match(/\[([0-9A-HJKMNP-TV-Z]{26})\]/);
  if (bracketMatch) return bracketMatch[1];

  const idMatch = text.match(/id:\s*([0-9A-HJKMNP-TV-Z]{26})/i);
  return idMatch ? idMatch[1] : null;
}

let tempDir = "";
let dbPath = "";
let transport: InstanceType<typeof StdioClientTransport> | null = null;
let client: InstanceType<typeof Client> | null = null;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "exo-mcp-contract-"));
  dbPath = path.join(tempDir, "mcp.db");
  if (!fs.existsSync(MCP_ENTRY)) {
    throw new Error("Missing MCP build at packages/mcp/dist/index.js. Run: pnpm build");
  }

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_ENTRY],
    cwd: ROOT,
    env: envWith({ EXOCORTEX_DB_PATH: dbPath }),
    stderr: "pipe",
  });

  client = new Client({ name: "exocortex-contract-test", version: "0.1.0" });
  await client.connect(transport);
}, 60_000);

afterEach(async () => {
  if (client) {
    await client.close();
    client = null;
  }
  if (transport) {
    await transport.close();
    transport = null;
  }
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("mcp contract", () => {
  it("exposes expected core tools", async () => {
    const listed = await client!.listTools();
    const names = listed.tools.map((t) => t.name);

    expect(names).toEqual(
      expect.arrayContaining([
        "memory_store",
        "memory_search",
        "memory_get",
        "memory_update",
        "memory_browse",
        "goal_create",
        "goal_list",
      ])
    );
  });

  it("supports stable roundtrip for memory and goal tool calls", async () => {
    const token = `MCP-CONTRACT-${Date.now()}`;

    const storeResult = await client!.callTool({
      name: "memory_store",
      arguments: {
        content: `Contract memory ${token}`,
        tags: ["contract", "mcp"],
        content_type: "note",
      },
    });
    const storeText = extractText(storeResult);
    expect((storeResult as { isError?: boolean }).isError).not.toBe(true);
    expect(storeText).toContain("Stored memory");

    const browseResult = await client!.callTool({
      name: "memory_browse",
      arguments: {
        tags: ["contract"],
        compact: true,
        limit: 5,
      },
    });
    const browseText = extractText(browseResult);
    const memoryId = extractFirstIdFromText(browseText);
    expect(memoryId).toBeTruthy();

    const searchResult = await client!.callTool({
      name: "memory_search",
      arguments: {
        query: token,
        compact: true,
        limit: 5,
      },
    });
    const searchText = extractText(searchResult);
    expect((searchResult as { isError?: boolean }).isError).not.toBe(true);
    expect(searchText).toContain("Found");

    const getResult = await client!.callTool({
      name: "memory_get",
      arguments: { ids: [memoryId] },
    });
    const getText = extractText(getResult);
    expect(getText).toContain(token);

    const updateResult = await client!.callTool({
      name: "memory_update",
      arguments: {
        id: memoryId,
        tags: ["contract", "mcp", "updated"],
      },
    });
    expect((updateResult as { isError?: boolean }).isError).not.toBe(true);
    expect(extractText(updateResult)).toContain("Updated memory");

    const goalTitle = `MCP Goal ${token}`;
    const goalCreate = await client!.callTool({
      name: "goal_create",
      arguments: {
        title: goalTitle,
        priority: "high",
      },
    });
    expect((goalCreate as { isError?: boolean }).isError).not.toBe(true);
    expect(extractText(goalCreate)).toContain("Created goal");

    const goalList = await client!.callTool({
      name: "goal_list",
      arguments: { status: "active" },
    });
    const goalText = extractText(goalList);
    expect((goalList as { isError?: boolean }).isError).not.toBe(true);
    expect(goalText).toContain(goalTitle);
  }, 90_000);
});
