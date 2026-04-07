import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "@exocortex/core";
import { createSessionState } from "./helpers.js";
import { registerMemoryCoreTools } from "./memory-core.js";
import { registerMemoryMaintenanceTools } from "./memory-maintenance.js";
import { registerMemoryIngestTools } from "./memory-ingest.js";
import { registerLinkTools } from "./links.js";
import { registerGoalTools } from "./goals.js";
import { registerPredictionTools } from "./predictions.js";
import { registerIntelligenceTools } from "./intelligence.js";
import { registerMemoryAutoTool } from "./memory-auto.js";
import { registerWikiCompileTools } from "./wiki-compile.js";
import { registerHierarchyTools } from "./hierarchy.js";
import type { ToolRegistrationContext } from "./types.js";

export interface RegisterToolsOptions {
  attribution?: {
    provider?: string;
    model_id?: string;
    model_name?: string;
    agent?: string;
  };
  startTime?: number;
}

export function registerAllTools(server: McpServer, options?: RegisterToolsOptions): void {
  const db = getDb();
  const DEFAULT_ATTRIBUTION = options?.attribution ?? {};
  const startTime = options?.startTime ?? Date.now();

  const { recordSearchResults, checkAndSignalUsefulness } = createSessionState();

  const ctx: ToolRegistrationContext = {
    server,
    db,
    defaultAttribution: DEFAULT_ATTRIBUTION,
    startTime,
    recordSearchResults,
    checkAndSignalUsefulness,
  };

  registerMemoryCoreTools(ctx);
  registerMemoryMaintenanceTools(ctx);
  registerMemoryIngestTools(ctx);
  registerLinkTools(ctx);
  registerGoalTools(ctx);
  registerPredictionTools(ctx);
  registerIntelligenceTools(ctx);
  registerMemoryAutoTool(ctx);
  registerWikiCompileTools(ctx);
  registerHierarchyTools(ctx);
}
