import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerAllTools } from "@exocortex/mcp/tools";

const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

const mcpRoutes = new Hono();

mcpRoutes.all("/mcp", async (c) => {
  const sessionId = c.req.header("Mcp-Session-Id");

  // Existing session — delegate to its transport
  if (sessionId && sessions.has(sessionId)) {
    return sessions.get(sessionId)!.handleRequest(c.req.raw);
  }

  // New session — create transport + server pair
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, transport);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };

  const server = new McpServer({ name: "exocortex", version: "0.1.0" });

  // Attribution defaults from server-side env vars
  const attribution = {
    provider: process.env.EXOCORTEX_DEFAULT_PROVIDER || undefined,
    model_id: process.env.EXOCORTEX_DEFAULT_MODEL_ID || undefined,
    model_name: process.env.EXOCORTEX_DEFAULT_MODEL_NAME || undefined,
    agent: process.env.EXOCORTEX_DEFAULT_AGENT || undefined,
  };

  registerAllTools(server, { attribution });
  await server.connect(transport);

  return transport.handleRequest(c.req.raw);
});

export default mcpRoutes;
