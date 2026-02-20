#!/usr/bin/env node

import { Command } from "commander";
import { registerAdd } from "./commands/add.js";
import { registerSearch } from "./commands/search.js";
import { registerImport } from "./commands/import.js";
import { registerStats } from "./commands/stats.js";
import { registerServe } from "./commands/serve.js";
import { registerMcp } from "./commands/mcp.js";
import { registerConsolidate } from "./commands/consolidate.js";
import { registerEntities } from "./commands/entities.js";
import { registerContradictions } from "./commands/contradictions.js";
import { registerExport } from "./commands/export.js";
import { registerRetrievalRegression } from "./commands/retrieval-regression.js";
import { registerBackfill } from "./commands/backfill.js";

const program = new Command();

program
  .name("exo")
  .description("Exocortex — personal unified memory system")
  .version("0.1.0");

registerAdd(program);
registerSearch(program);
registerImport(program);
registerStats(program);
registerServe(program);
registerMcp(program);
registerConsolidate(program);
registerEntities(program);
registerContradictions(program);
registerExport(program);
registerRetrievalRegression(program);
registerBackfill(program);

program.parse();
