import type { Command } from "commander";
import { spawn } from "node:child_process";
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

      const child = spawn("npx", ["tsx", mcpEntry], {
        stdio: "inherit",
        shell: true,
      });

      child.on("error", (err) => {
        console.error("Failed to start MCP server:", err.message);
        process.exit(1);
      });

      child.on("exit", (code) => {
        process.exit(code ?? 0);
      });
    });
}
