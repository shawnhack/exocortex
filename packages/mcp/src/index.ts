#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getDb, closeDb, initializeSchema, getEmbeddingProvider } from "@exocortex/core";
import { registerAllTools } from "./tools.js";

const startTime = Date.now();
const suppressProtocolNoise = process.env.EXOCORTEX_MCP_ALLOW_STDIO_LOGS !== "1";

if (suppressProtocolNoise) {
  // MCP stdio transport requires stdout to be JSON-RPC only.
  // Node's console.error writes to stderr, but core hot paths can call console.error
  // and any stray write to stdout would corrupt the JSON-RPC stream — suppress all
  // four console methods to be safe. Set EXOCORTEX_MCP_ALLOW_STDIO_LOGS=1 to debug.
  console.log = () => {};
  console.info = () => {};
  console.warn = () => {};
  console.error = () => {};
}

// Eagerly initialize DB + schema + embedding model at startup
// so first tool call doesn't pay the cost
const db = getDb();
initializeSchema(db);

// Default attribution from environment — each MCP client can set these
// so memories are tagged with the correct provider/model even if the caller omits them.
const DEFAULT_ATTRIBUTION = {
  provider: process.env.EXOCORTEX_DEFAULT_PROVIDER || undefined,
  model_id: process.env.EXOCORTEX_DEFAULT_MODEL_ID || undefined,
  model_name: process.env.EXOCORTEX_DEFAULT_MODEL_NAME || undefined,
  agent: process.env.EXOCORTEX_DEFAULT_AGENT || undefined,
};
if (process.env.EXOCORTEX_SKIP_EMBEDDING_WARMUP !== "1") {
  getEmbeddingProvider().catch(() => {
    // Model warmup failed — will retry on first tool call
  });
}

const server = new McpServer({
  name: "exocortex",
  version: "0.1.0",
});

registerAllTools(server, { attribution: DEFAULT_ATTRIBUTION, startTime });

// Graceful shutdown
process.on("exit", () => {
  try { closeDb(); } catch {}
});

// Start
async function main() {
  // On Windows, MCP hosts may redirect stderr to "nul" which can create
  // a literal file in the CWD under some shell environments (git-bash/MSYS).
  // Suppress stderr to avoid this.
  if (suppressProtocolNoise && process.platform === "win32") {
    process.stderr.write = () => true;
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export { server };

export function getRegisteredToolForTesting(name: string): unknown {
  const tools = (server as unknown as { _registeredTools?: unknown })
    ._registeredTools;
  if (!tools) return undefined;
  if (tools instanceof Map) {
    return tools.get(name);
  }
  if (Array.isArray(tools)) {
    return tools.find((tool) =>
      typeof tool === "object" &&
      tool !== null &&
      (tool as { name?: string }).name === name
    );
  }
  if (typeof tools === "object") {
    return (tools as Record<string, unknown>)[name];
  }
  return undefined;
}

if (process.env.EXOCORTEX_MCP_NO_AUTOSTART !== "1") {
  main().catch((err) => {
    console.error("Exocortex MCP server failed to start:", err);
    process.exit(1);
  });
}
