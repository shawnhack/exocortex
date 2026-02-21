import type { Command } from "commander";
import {
  getDb,
  initializeSchema,
  MemoryStore,
} from "@exocortex/core";
import type { MemorySource } from "@exocortex/core";

export function registerAdd(program: Command): void {
  program
    .command("add <content>")
    .description("Add a new memory")
    .option("-t, --tags <tags>", "Comma-separated tags")
    .option("-i, --importance <n>", "Importance 0-1", parseFloat)
    .option(
      "--type <type>",
      "Content type: text|conversation|note|summary",
      "text"
    )
    .option("--source <source>", "Source: manual|cli|api|mcp|import", "cli")
    .option("--provider <provider>", "Model provider (e.g. openai)")
    .option("--model-id <id>", "Canonical model identifier (e.g. gpt-5-codex)")
    .option("--model-name <name>", "Model display name (e.g. GPT-5.3-Codex)")
    .option("--agent <agent>", "Agent/runtime identifier (e.g. codex)")
    .option("--session-id <id>", "Optional session/thread identifier")
    .option("--conversation-id <id>", "Optional conversation identifier")
    .option("--metadata", "Mark memory as metadata/system artifact")
    .option("--benchmark", "Store as benchmark artifact (low importance, reduced indexing)")
    .action(async (content: string, opts) => {
      const ora = (await import("ora")).default;
      const chalk = (await import("chalk")).default;

      const spinner = ora("Storing memory...").start();

      try {
        const db = getDb();
        initializeSchema(db);
        const store = new MemoryStore(db);

        const result = await store.create({
          content,
          content_type: opts.type,
          source: opts.source as MemorySource,
          importance: opts.importance,
          provider: opts.provider,
          model_id: opts.modelId,
          model_name: opts.modelName,
          agent: opts.agent,
          session_id: opts.sessionId,
          conversation_id: opts.conversationId,
          tags: opts.tags
            ? opts.tags.split(",").map((t: string) => t.trim())
            : undefined,
          is_metadata: opts.metadata === true,
          benchmark: opts.benchmark === true,
        });
        const { memory } = result;

        spinner.succeed(chalk.green("Memory stored"));
        console.log(`  ID: ${chalk.cyan(memory.id)}`);
        console.log(`  Type: ${memory.content_type}`);
        if (memory.tags?.length) {
          console.log(`  Tags: ${memory.tags.join(", ")}`);
        }
        if (result.dedup_action === "skipped" && result.superseded_id) {
          console.log(
            `  Dedup: reused ${chalk.cyan(result.superseded_id)} (${Math.round(
              (result.dedup_similarity ?? 0) * 100
            )}% similar)`
          );
        }
        console.log(
          `  Embedding: ${memory.embedding ? "yes" : chalk.yellow("pending")}`
        );
      } catch (err) {
        spinner.fail(
          `Failed: ${err instanceof Error ? err.message : String(err)}`
        );
        process.exit(1);
      }
    });
}
