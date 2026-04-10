import { z } from "zod";
import { AgentTaskStore } from "@exocortex/core";
import type { ToolRegistrationContext } from "./types.js";

export function registerAgentTaskTools(ctx: ToolRegistrationContext): void {
  const { server, db } = ctx;

  server.tool(
    "agent_task",
    "Manage the shared agent task queue. Create tasks for other agents, claim your assigned tasks, report results, or check task status. This enables inter-agent coordination — agents can delegate work and track outcomes.",
    {
      action: z.enum(["create", "list", "claim", "complete", "fail", "update", "get"]).describe("Action to perform"),
      id: z.string().optional().describe("Task ID (for get/complete/fail/update)"),
      title: z.string().optional().describe("Task title (for create)"),
      description: z.string().optional().describe("Task description with context and success criteria (for create)"),
      assignee: z.string().optional().describe("Agent name to assign to (for create/update). Use sentinel job names like 'sentinel:crypto-alpha'"),
      created_by: z.string().optional().describe("Who is creating this task (for create)"),
      priority: z.enum(["low", "medium", "high", "critical"]).optional().describe("Task priority"),
      goal_id: z.string().optional().describe("Link to a goal ID (for create, or filter for list)"),
      parent_task_id: z.string().optional().describe("Parent task ID for subtasks (for create)"),
      dependencies: z.array(z.string()).optional().describe("Task IDs that must complete first (for create)"),
      status: z.enum(["pending", "assigned", "in_progress", "completed", "failed", "blocked"]).optional().describe("Filter by status (for list) or new status (for update)"),
      result: z.string().optional().describe("Task result or output (for complete/fail)"),
      metadata: z.record(z.string(), z.any()).optional().describe("Arbitrary metadata"),
      deadline: z.string().optional().describe("Deadline (ISO date)"),
      limit: z.number().optional().describe("Max results for list (default 50)"),
    },
    async (args) => {
      const store = new AgentTaskStore(db);

      try {
        switch (args.action) {
          case "create": {
            if (!args.title) {
              return { content: [{ type: "text" as const, text: "Error: title is required" }], isError: true };
            }
            if (!args.created_by) {
              return { content: [{ type: "text" as const, text: "Error: created_by is required" }], isError: true };
            }
            const task = store.create({
              title: args.title,
              description: args.description,
              assignee: args.assignee,
              created_by: args.created_by,
              priority: args.priority,
              goal_id: args.goal_id,
              parent_task_id: args.parent_task_id,
              dependencies: args.dependencies,
              metadata: args.metadata,
              deadline: args.deadline,
            });

            const parts = [`Created task ${task.id}: "${task.title}"`];
            if (task.assignee) parts.push(`assigned to: ${task.assignee}`);
            parts.push(`priority: ${task.priority}`, `status: ${task.status}`);
            return { content: [{ type: "text" as const, text: parts.join(" | ") }] };
          }

          case "list": {
            const tasks = store.list({
              assignee: args.assignee,
              created_by: args.created_by,
              status: args.status,
              goal_id: args.goal_id,
              priority: args.priority,
              limit: args.limit,
            });

            if (tasks.length === 0) {
              return { content: [{ type: "text" as const, text: "No tasks found matching filters." }] };
            }

            const lines = tasks.map((t) => {
              const parts = [`[${t.status}] ${t.title}`];
              if (t.assignee) parts.push(`→ ${t.assignee}`);
              parts.push(`(${t.priority})`);
              if (t.goal_id) parts.push(`goal:${t.goal_id.slice(0, 8)}`);
              return `- ${t.id}: ${parts.join(" ")}`;
            });

            return { content: [{ type: "text" as const, text: `Tasks (${tasks.length}):\n${lines.join("\n")}` }] };
          }

          case "claim": {
            if (!args.assignee) {
              return { content: [{ type: "text" as const, text: "Error: assignee is required to claim a task" }], isError: true };
            }
            const claimed = store.claim(args.assignee);
            if (!claimed) {
              return { content: [{ type: "text" as const, text: `No pending tasks for ${args.assignee}.` }] };
            }
            return { content: [{ type: "text" as const, text: `Claimed task ${claimed.id}: "${claimed.title}" (${claimed.priority})\n${claimed.description ?? "No description."}` }] };
          }

          case "complete": {
            if (!args.id) {
              return { content: [{ type: "text" as const, text: "Error: id is required" }], isError: true };
            }
            const completed = store.complete(args.id, args.result ?? "Completed without details.");
            if (!completed) {
              return { content: [{ type: "text" as const, text: `Task ${args.id} not found.` }], isError: true };
            }
            return { content: [{ type: "text" as const, text: `Completed task ${completed.id}: "${completed.title}"` }] };
          }

          case "fail": {
            if (!args.id) {
              return { content: [{ type: "text" as const, text: "Error: id is required" }], isError: true };
            }
            const failed = store.fail(args.id, args.result ?? "Failed without details.");
            if (!failed) {
              return { content: [{ type: "text" as const, text: `Task ${args.id} not found.` }], isError: true };
            }
            return { content: [{ type: "text" as const, text: `Failed task ${failed.id}: "${failed.title}" — ${args.result ?? "no reason"}` }] };
          }

          case "update": {
            if (!args.id) {
              return { content: [{ type: "text" as const, text: "Error: id is required" }], isError: true };
            }
            const updated = store.update(args.id, {
              title: args.title,
              description: args.description,
              assignee: args.assignee,
              status: args.status,
              priority: args.priority,
              result: args.result,
              metadata: args.metadata,
              deadline: args.deadline,
            });
            if (!updated) {
              return { content: [{ type: "text" as const, text: `Task ${args.id} not found.` }], isError: true };
            }
            return { content: [{ type: "text" as const, text: `Updated task ${updated.id}: "${updated.title}" (${updated.status})` }] };
          }

          case "get": {
            if (!args.id) {
              return { content: [{ type: "text" as const, text: "Error: id is required" }], isError: true };
            }
            const task = store.getById(args.id);
            if (!task) {
              return { content: [{ type: "text" as const, text: `Task ${args.id} not found.` }], isError: true };
            }

            const lines = [
              `Task: ${task.title}`,
              `ID: ${task.id}`,
              `Status: ${task.status} | Priority: ${task.priority}`,
              `Assignee: ${task.assignee ?? "unassigned"} | Created by: ${task.created_by}`,
            ];
            if (task.description) lines.push(`Description: ${task.description}`);
            if (task.goal_id) lines.push(`Goal: ${task.goal_id}`);
            if (task.result) lines.push(`Result: ${task.result}`);
            if (task.deadline) lines.push(`Deadline: ${task.deadline}`);
            if (task.dependencies.length > 0) lines.push(`Dependencies: ${task.dependencies.join(", ")}`);
            lines.push(`Created: ${task.created_at}`);
            if (task.started_at) lines.push(`Started: ${task.started_at}`);
            if (task.completed_at) lines.push(`Completed: ${task.completed_at}`);

            return { content: [{ type: "text" as const, text: lines.join("\n") }] };
          }

          default:
            return { content: [{ type: "text" as const, text: `Unknown action: ${args.action}` }], isError: true };
        }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );
}
