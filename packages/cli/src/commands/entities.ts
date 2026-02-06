import type { Command } from "commander";
import { getDb, initializeSchema, EntityStore } from "@exocortex/core";
import type { EntityType } from "@exocortex/core";

export function registerEntities(program: Command): void {
  program
    .command("entities")
    .description("List and manage entities")
    .option("--type <type>", "Filter by type (person/project/technology/organization/concept)")
    .option("--search <name>", "Search for an entity by name")
    .option("--memories <id>", "Show memories linked to an entity")
    .action(async (opts) => {
      const chalk = (await import("chalk")).default;

      const db = getDb();
      initializeSchema(db);
      const entityStore = new EntityStore(db);

      if (opts.memories) {
        const entity = entityStore.getById(opts.memories);
        if (!entity) {
          console.error(chalk.red(`Entity not found: ${opts.memories}`));
          process.exit(1);
        }

        const memoryIds = entityStore.getMemoriesForEntity(entity.id);
        console.log(chalk.bold(`\nMemories linked to ${chalk.cyan(entity.name)} (${entity.type}):\n`));

        if (memoryIds.length === 0) {
          console.log(chalk.dim("  No linked memories."));
        } else {
          for (const mid of memoryIds) {
            const row = db
              .prepare("SELECT id, content, created_at FROM memories WHERE id = ?")
              .get(mid) as { id: string; content: string; created_at: string } | undefined;
            if (row) {
              const preview = row.content.slice(0, 80).replace(/\n/g, " ");
              console.log(`  ${chalk.dim(row.id)} ${preview}${row.content.length > 80 ? "..." : ""}`);
            }
          }
        }
        console.log();
        return;
      }

      if (opts.search) {
        const entity = entityStore.getByName(opts.search);
        if (!entity) {
          console.log(chalk.dim(`No entity found matching "${opts.search}"`));
          return;
        }

        console.log(chalk.bold(`\n  ${chalk.cyan(entity.name)}`));
        console.log(`  Type: ${entity.type}`);
        if (entity.aliases.length > 0) {
          console.log(`  Aliases: ${entity.aliases.join(", ")}`);
        }
        console.log(`  Created: ${chalk.dim(entity.created_at)}`);
        console.log();
        return;
      }

      const type = opts.type as EntityType | undefined;
      const entities = entityStore.list(type);

      if (entities.length === 0) {
        console.log(chalk.dim("\nNo entities found." + (type ? ` (filter: ${type})` : "")));
        return;
      }

      console.log(chalk.bold(`\nEntities${type ? ` (${type})` : ""}: ${entities.length}\n`));

      const grouped = new Map<string, typeof entities>();
      for (const entity of entities) {
        const group = grouped.get(entity.type) ?? [];
        group.push(entity);
        grouped.set(entity.type, group);
      }

      for (const [entityType, group] of grouped) {
        console.log(chalk.bold(`  ${entityType} (${group.length})`));
        for (const entity of group) {
          const aliases = entity.aliases.length > 0 ? chalk.dim(` (${entity.aliases.join(", ")})`) : "";
          console.log(`    ${chalk.cyan(entity.name)}${aliases}`);
        }
        console.log();
      }
    });
}
