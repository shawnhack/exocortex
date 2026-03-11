import { z } from "zod";
import { GoalStore } from "@exocortex/core";
import type { ToolRegistrationContext } from "./types.js";

export function registerGoalTools(ctx: ToolRegistrationContext): void {
  const { server, db } = ctx;

  // goal_create
  server.tool(
    "goal_create",
    "Create a new goal to track. Goals are persistent objectives with progress monitoring — define what you're trying to achieve, and the system tracks progress and detects stalls.",
    {
      title: z.string().describe("Goal title"),
      description: z.string().optional().describe("Detailed description of the goal"),
      priority: z.enum(["low", "medium", "high", "critical"]).optional().describe("Priority level (default 'medium')"),
      deadline: z.string().optional().describe("Target deadline (ISO date YYYY-MM-DD)"),
      metadata: z.record(z.string(), z.any()).optional().describe("Arbitrary JSON metadata"),
    },
    async (args) => {
      try {
        const store = new GoalStore(db);
        const goal = store.create({
          title: args.title,
          description: args.description,
          priority: args.priority,
          deadline: args.deadline,
          metadata: args.metadata,
        });

        const meta: string[] = [`id: ${goal.id}`, `priority: ${goal.priority}`];
        if (goal.deadline) meta.push(`deadline: ${goal.deadline}`);

        return { content: [{ type: "text", text: `Created goal: "${goal.title}" (${meta.join(" | ")})` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // goal_list
  server.tool(
    "goal_list",
    "List goals, optionally filtered by status. Default: active goals only.",
    {
      status: z.enum(["active", "completed", "stalled", "abandoned"]).optional().describe("Filter by status (default: active)"),
      include_progress: z.boolean().optional().describe("Include recent progress entries (default false)"),
    },
    async (args) => {
      try {
        const store = new GoalStore(db);
        const status = args.status ?? "active";
        const goals = store.list(status);

        if (goals.length === 0) {
          return { content: [{ type: "text", text: `No ${status} goals found.` }] };
        }

        const lines = goals.map((goal) => {
          const meta: string[] = [`priority: ${goal.priority}`];
          if (goal.deadline) meta.push(`deadline: ${goal.deadline}`);
          meta.push(`created: ${goal.created_at}`);
          if (goal.completed_at) meta.push(`completed: ${goal.completed_at}`);

          const autoBadge = goal.metadata?.mode === "autonomous" ? "[AUTO] " : "";
          let line = `${autoBadge}[${goal.id}] ${goal.title}\n  ${goal.description ?? "(no description)"}\n  (${meta.join(" | ")})`;

          if (args.include_progress) {
            const withProgress = store.getWithProgress(goal.id, 5);
            if (withProgress) {
              if (withProgress.milestones.length > 0) {
                const completed = withProgress.milestones.filter((m) => m.status === "completed").length;
                line += `\n  Milestones: ${completed}/${withProgress.milestones.length} completed`;
              }
              if (withProgress.progress.length > 0) {
                const progressLines = withProgress.progress.map(
                  (p) => `    - ${p.content} (${p.created_at})`
                );
                line += `\n  Progress:\n${progressLines.join("\n")}`;
              } else {
                line += "\n  Progress: none";
              }
            }
          }

          return line;
        });

        return {
          content: [{ type: "text", text: `${status.charAt(0).toUpperCase() + status.slice(1)} goals (${goals.length}):\n\n${lines.join("\n\n")}` }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // goal_update
  server.tool(
    "goal_update",
    "Update an existing goal's title, description, status, priority, deadline, or metadata.",
    {
      id: z.string().describe("Goal ID"),
      title: z.string().optional().describe("New title"),
      description: z.string().nullable().optional().describe("New description"),
      status: z.enum(["active", "completed", "stalled", "abandoned"]).optional().describe("New status"),
      priority: z.enum(["low", "medium", "high", "critical"]).optional().describe("New priority"),
      deadline: z.string().nullable().optional().describe("New deadline (ISO date YYYY-MM-DD)"),
      metadata: z.record(z.string(), z.any()).optional().describe("Merge metadata (set value to null to delete a key)"),
    },
    async (args) => {
      try {
        const { id, ...updates } = args;

        if (
          updates.title === undefined &&
          updates.description === undefined &&
          updates.status === undefined &&
          updates.priority === undefined &&
          updates.deadline === undefined &&
          updates.metadata === undefined
        ) {
          return { content: [{ type: "text", text: "No update fields provided." }] };
        }

        const store = new GoalStore(db);
        const updated = store.update(id, updates);

        if (!updated) {
          return { content: [{ type: "text", text: `Goal ${id} not found.` }] };
        }

        const meta: string[] = [`status: ${updated.status}`, `priority: ${updated.priority}`];
        if (updated.deadline) meta.push(`deadline: ${updated.deadline}`);

        return { content: [{ type: "text", text: `Updated goal: "${updated.title}" (${meta.join(" | ")})` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // goal_log
  server.tool(
    "goal_log",
    "Log progress on a goal. Creates a memory tagged 'goal-progress' linked to the goal.",
    {
      id: z.string().describe("Goal ID"),
      content: z.string().describe("Progress note"),
      importance: z.number().min(0).max(1).optional().describe("Importance 0-1 (default 0.5)"),
    },
    async (args) => {
      try {
        const store = new GoalStore(db);

        const goal = store.getById(args.id);
        if (!goal) {
          return { content: [{ type: "text", text: `Goal ${args.id} not found.` }] };
        }

        const memoryId = await store.logProgress(args.id, args.content, args.importance);

        return {
          content: [{ type: "text", text: `Logged progress on "${goal.title}" (memory: ${memoryId})` }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // goal_get
  server.tool(
    "goal_get",
    "Get a goal's details including recent progress entries.",
    {
      id: z.string().describe("Goal ID"),
      progress_limit: z.number().optional().describe("Max progress entries to return (default 10)"),
    },
    async (args) => {
      try {
        const store = new GoalStore(db);
        const goal = store.getWithProgress(args.id, args.progress_limit ?? 10);

        if (!goal) {
          return { content: [{ type: "text", text: `Goal ${args.id} not found.` }] };
        }

        const meta: string[] = [
          `status: ${goal.status}`,
          `priority: ${goal.priority}`,
        ];
        if (goal.deadline) meta.push(`deadline: ${goal.deadline}`);
        meta.push(`created: ${goal.created_at}`);
        if (goal.completed_at) meta.push(`completed: ${goal.completed_at}`);

        const parts: string[] = [
          `[${goal.id}] ${goal.title}`,
          goal.description ?? "(no description)",
          `(${meta.join(" | ")})`,
        ];

        const displayMeta = { ...goal.metadata };
        delete displayMeta.milestones;
        if (Object.keys(displayMeta).length > 0) {
          parts.push(`Metadata: ${JSON.stringify(displayMeta)}`);
        }

        if (goal.milestones.length > 0) {
          const completed = goal.milestones.filter((m) => m.status === "completed").length;
          parts.push(`\nMilestones (${completed}/${goal.milestones.length} completed):`);
          for (const m of goal.milestones) {
            const statusIcon = m.status === "completed" ? "[x]" : m.status === "in_progress" ? "[~]" : "[ ]";
            const deadlineStr = m.deadline ? ` (deadline: ${m.deadline})` : "";
            parts.push(`  ${statusIcon} ${m.title}${deadlineStr}`);
          }
        }

        if (goal.metadata?.mode === "autonomous") {
          const approvedTools = goal.metadata.approved_tools as string[] | undefined;
          const maxActions = (goal.metadata.max_actions_per_cycle as number) ?? 10;
          const strategy = goal.metadata.strategy as string | undefined;
          parts.push(`\nAutonomy: ENABLED`);
          parts.push(`  Tools: ${approvedTools?.length ? approvedTools.join(", ") : "all"}`);
          parts.push(`  Max actions/cycle: ${maxActions}`);
          if (strategy) parts.push(`  Strategy: "${strategy}"`);
        }

        if (goal.progress.length > 0) {
          parts.push(`\nProgress (${goal.progress.length}):`);
          for (const p of goal.progress) {
            parts.push(`  - [${p.id}] ${p.content} (${p.created_at})`);
          }
        } else {
          parts.push("\nProgress: none");
        }

        return { content: [{ type: "text", text: parts.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // goal_add_milestone
  server.tool(
    "goal_add_milestone",
    "Add a milestone to a goal. Milestones break goals into trackable sub-objectives.",
    {
      id: z.string().describe("Goal ID"),
      title: z.string().describe("Milestone title"),
      order: z.number().optional().describe("Sort order (auto-increments if omitted)"),
      deadline: z.string().optional().describe("Milestone deadline (ISO date YYYY-MM-DD)"),
    },
    async (args) => {
      const store = new GoalStore(db);
      try {
        const milestone = store.addMilestone(args.id, {
          title: args.title,
          order: args.order,
          deadline: args.deadline,
        });
        const meta: string[] = [`id: ${milestone.id}`, `order: ${milestone.order}`];
        if (milestone.deadline) meta.push(`deadline: ${milestone.deadline}`);
        return { content: [{ type: "text", text: `Added milestone: "${milestone.title}" (${meta.join(" | ")})` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    }
  );

  // goal_update_milestone
  server.tool(
    "goal_update_milestone",
    "Update a milestone's title, status, order, or deadline.",
    {
      goal_id: z.string().describe("Goal ID"),
      milestone_id: z.string().describe("Milestone ID"),
      title: z.string().optional().describe("New title"),
      status: z.enum(["pending", "in_progress", "completed"]).optional().describe("New status"),
      order: z.number().optional().describe("New sort order"),
      deadline: z.string().optional().describe("New deadline (ISO date YYYY-MM-DD)"),
    },
    async (args) => {
      try {
        const { goal_id, milestone_id, ...updates } = args;

        if (!updates.title && !updates.status && updates.order === undefined && !updates.deadline) {
          return { content: [{ type: "text", text: "No update fields provided." }] };
        }

        const store = new GoalStore(db);
        const updated = store.updateMilestone(goal_id, milestone_id, updates);

        if (!updated) {
          return { content: [{ type: "text", text: `Goal or milestone not found.` }] };
        }

        const meta: string[] = [`status: ${updated.status}`, `order: ${updated.order}`];
        if (updated.deadline) meta.push(`deadline: ${updated.deadline}`);
        return { content: [{ type: "text", text: `Updated milestone: "${updated.title}" (${meta.join(" | ")})` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // goal_remove_milestone
  server.tool(
    "goal_remove_milestone",
    "Remove a milestone from a goal.",
    {
      goal_id: z.string().describe("Goal ID"),
      milestone_id: z.string().describe("Milestone ID"),
    },
    async (args) => {
      try {
        const store = new GoalStore(db);
        const removed = store.removeMilestone(args.goal_id, args.milestone_id);

        if (!removed) {
          return { content: [{ type: "text", text: `Goal or milestone not found.` }] };
        }

        return { content: [{ type: "text", text: `Removed milestone ${args.milestone_id}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );
}
