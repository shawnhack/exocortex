import { z } from "zod";
import { GoalStore } from "@exocortex/core";
import type { ToolRegistrationContext } from "./types.js";

export function registerGoalTools(ctx: ToolRegistrationContext): void {
  const { server, db } = ctx;

  server.tool(
    "goal",
    "Manage goals: create, list, update, get details, log progress, and manage milestones.",
    {
      action: z.enum(["create", "list", "update", "get", "log", "add_milestone", "update_milestone", "remove_milestone"]).describe("Action to perform"),
      id: z.string().optional().describe("Goal ID (required for get/update/log/milestone ops)"),
      title: z.string().optional().describe("Goal or milestone title"),
      description: z.string().nullable().optional().describe("Goal description"),
      status: z.enum(["active", "completed", "stalled", "abandoned"]).optional().describe("Goal status"),
      priority: z.enum(["low", "medium", "high", "critical"]).optional().describe("Priority level"),
      deadline: z.string().nullable().optional().describe("Deadline (ISO date YYYY-MM-DD)"),
      metadata: z.record(z.string(), z.any()).optional().describe("Arbitrary JSON metadata"),
      include_progress: z.boolean().optional().describe("Include progress entries in list"),
      progress_limit: z.number().optional().describe("Max progress entries for get (default 10)"),
      content: z.string().optional().describe("Progress note text (for log action)"),
      importance: z.number().min(0).max(1).optional().describe("Importance 0-1 (for log action)"),
      milestone_id: z.string().optional().describe("Milestone ID (for update/remove milestone)"),
      milestone_status: z.enum(["pending", "in_progress", "completed"]).optional().describe("Milestone status"),
      order: z.number().optional().describe("Milestone sort order"),
    },
    async (args) => {
      const store = new GoalStore(db);

      try {
        switch (args.action) {
          case "create": {
            if (!args.title) {
              return { content: [{ type: "text" as const, text: "Error: title is required for create" }], isError: true };
            }
            const goal = store.create({
              title: args.title,
              description: args.description ?? undefined,
              priority: args.priority,
              deadline: args.deadline ?? undefined,
              metadata: args.metadata,
            });
            const meta: string[] = [`id: ${goal.id}`, `priority: ${goal.priority}`];
            if (goal.deadline) meta.push(`deadline: ${goal.deadline}`);
            return { content: [{ type: "text" as const, text: `Created goal: "${goal.title}" (${meta.join(" | ")})` }] };
          }

          case "list": {
            const status = args.status ?? "active";
            const goals = store.list(status);

            if (goals.length === 0) {
              return { content: [{ type: "text" as const, text: `No ${status} goals found.` }] };
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
              content: [{ type: "text" as const, text: `${status.charAt(0).toUpperCase() + status.slice(1)} goals (${goals.length}):\n\n${lines.join("\n\n")}` }],
            };
          }

          case "update": {
            if (!args.id) {
              return { content: [{ type: "text" as const, text: "Error: id is required for update" }], isError: true };
            }
            const updates: Record<string, unknown> = {};
            if (args.title !== undefined) updates.title = args.title;
            if (args.description !== undefined) updates.description = args.description;
            if (args.status !== undefined) updates.status = args.status;
            if (args.priority !== undefined) updates.priority = args.priority;
            if (args.deadline !== undefined) updates.deadline = args.deadline;
            if (args.metadata !== undefined) updates.metadata = args.metadata;

            if (Object.keys(updates).length === 0) {
              return { content: [{ type: "text" as const, text: "No update fields provided." }] };
            }

            const updated = store.update(args.id, updates);
            if (!updated) {
              return { content: [{ type: "text" as const, text: `Goal ${args.id} not found.` }] };
            }

            const meta: string[] = [`status: ${updated.status}`, `priority: ${updated.priority}`];
            if (updated.deadline) meta.push(`deadline: ${updated.deadline}`);
            return { content: [{ type: "text" as const, text: `Updated goal: "${updated.title}" (${meta.join(" | ")})` }] };
          }

          case "get": {
            if (!args.id) {
              return { content: [{ type: "text" as const, text: "Error: id is required for get" }], isError: true };
            }
            const goal = store.getWithProgress(args.id, args.progress_limit ?? 10);
            if (!goal) {
              return { content: [{ type: "text" as const, text: `Goal ${args.id} not found.` }] };
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

            return { content: [{ type: "text" as const, text: parts.join("\n") }] };
          }

          case "log": {
            if (!args.id) {
              return { content: [{ type: "text" as const, text: "Error: id is required for log" }], isError: true };
            }
            if (!args.content) {
              return { content: [{ type: "text" as const, text: "Error: content is required for log" }], isError: true };
            }
            const goal = store.getById(args.id);
            if (!goal) {
              return { content: [{ type: "text" as const, text: `Goal ${args.id} not found.` }] };
            }

            const memoryId = await store.logProgress(args.id, args.content, args.importance);
            return {
              content: [{ type: "text" as const, text: `Logged progress on "${goal.title}" (memory: ${memoryId})` }],
            };
          }

          case "add_milestone": {
            if (!args.id) {
              return { content: [{ type: "text" as const, text: "Error: id is required for add_milestone" }], isError: true };
            }
            if (!args.title) {
              return { content: [{ type: "text" as const, text: "Error: title is required for add_milestone" }], isError: true };
            }
            const milestone = store.addMilestone(args.id, {
              title: args.title,
              order: args.order,
              deadline: args.deadline ?? undefined,
            });
            const meta: string[] = [`id: ${milestone.id}`, `order: ${milestone.order}`];
            if (milestone.deadline) meta.push(`deadline: ${milestone.deadline}`);
            return { content: [{ type: "text" as const, text: `Added milestone: "${milestone.title}" (${meta.join(" | ")})` }] };
          }

          case "update_milestone": {
            if (!args.id) {
              return { content: [{ type: "text" as const, text: "Error: id (goal_id) is required for update_milestone" }], isError: true };
            }
            if (!args.milestone_id) {
              return { content: [{ type: "text" as const, text: "Error: milestone_id is required for update_milestone" }], isError: true };
            }

            const milestoneUpdates: Record<string, unknown> = {};
            if (args.title !== undefined) milestoneUpdates.title = args.title;
            if (args.milestone_status !== undefined) milestoneUpdates.status = args.milestone_status;
            if (args.order !== undefined) milestoneUpdates.order = args.order;
            if (args.deadline !== undefined) milestoneUpdates.deadline = args.deadline;

            if (Object.keys(milestoneUpdates).length === 0) {
              return { content: [{ type: "text" as const, text: "No update fields provided." }] };
            }

            const updatedMilestone = store.updateMilestone(args.id, args.milestone_id, milestoneUpdates);
            if (!updatedMilestone) {
              return { content: [{ type: "text" as const, text: `Goal or milestone not found.` }] };
            }

            const mMeta: string[] = [`status: ${updatedMilestone.status}`, `order: ${updatedMilestone.order}`];
            if (updatedMilestone.deadline) mMeta.push(`deadline: ${updatedMilestone.deadline}`);
            return { content: [{ type: "text" as const, text: `Updated milestone: "${updatedMilestone.title}" (${mMeta.join(" | ")})` }] };
          }

          case "remove_milestone": {
            if (!args.id) {
              return { content: [{ type: "text" as const, text: "Error: id (goal_id) is required for remove_milestone" }], isError: true };
            }
            if (!args.milestone_id) {
              return { content: [{ type: "text" as const, text: "Error: milestone_id is required for remove_milestone" }], isError: true };
            }

            const removed = store.removeMilestone(args.id, args.milestone_id);
            if (!removed) {
              return { content: [{ type: "text" as const, text: `Goal or milestone not found.` }] };
            }

            return { content: [{ type: "text" as const, text: `Removed milestone ${args.milestone_id}` }] };
          }
        }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );
}
