import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DatabaseSync } from "node:sqlite";

export interface ToolRegistrationContext {
  server: McpServer;
  db: DatabaseSync;
  defaultAttribution: {
    provider?: string;
    model_id?: string;
    model_name?: string;
    agent?: string;
  };
  startTime: number;
  recordSearchResults: (ids: string[]) => void;
  checkAndSignalUsefulness: (ids: string[], db: DatabaseSync) => string[];
  autoMarkSearchUseful: (ids: string[], db: DatabaseSync, maxMark?: number) => void;
}
