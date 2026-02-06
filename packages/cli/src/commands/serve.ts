import type { Command } from "commander";

export function registerServe(program: Command): void {
  program
    .command("serve")
    .description("Start the Exocortex HTTP server")
    .option("-p, --port <port>", "Port number", "3210")
    .action(async (opts) => {
      const { startServer } = await import("@exocortex/server");
      const port = parseInt(opts.port, 10);
      startServer(port);
    });
}
