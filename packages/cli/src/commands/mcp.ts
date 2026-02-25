import type { Command } from "commander";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

export function registerMcp(program: Command): void {
  program
    .command("mcp")
    .description("Start the Exocortex MCP server (stdio)")
    .action(() => {
      // Resolve the MCP entry point relative to this package
      const mcpEntry = path.resolve(
        import.meta.dirname ?? ".",
        "../../mcp/src/index.ts"
      );

      // Resolve tsx CLI from the monorepo so it works regardless of cwd
      const require = createRequire(import.meta.url);
      const tsxCli = path.join(
        path.dirname(require.resolve("tsx/package.json")),
        "dist",
        "cli.mjs"
      );

      const child = spawn(process.execPath, [
        tsxCli,
        mcpEntry,
      ], { stdio: "inherit" });

      child.on("error", (err) => {
        console.error("Failed to start MCP server:", err.message);
        process.exit(1);
      });

      child.on("exit", (code) => {
        process.exit(code ?? 0);
      });
    });
}
