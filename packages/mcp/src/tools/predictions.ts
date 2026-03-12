import { z } from "zod";
import { PredictionStore } from "@exocortex/core";
import type { ToolRegistrationContext } from "./types.js";

export function registerPredictionTools(ctx: ToolRegistrationContext): void {
  const { server, db } = ctx;

  server.tool(
    "prediction",
    "Manage predictions: create forecasts, list/filter, resolve outcomes, get details, or view calibration stats.",
    {
      action: z.enum(["create", "list", "resolve", "get", "stats"]).describe("Action to perform"),
      id: z.string().optional().describe("Prediction ID (required for get/resolve)"),
      claim: z.string().optional().describe("Prediction claim text (required for create)"),
      confidence: z.number().min(0).max(1).optional().describe("Confidence 0-1 (required for create)"),
      domain: z.enum(["technical", "product", "market", "personal", "political", "scientific", "general"]).optional().describe("Domain category"),
      source: z.enum(["user", "sentinel", "agent", "mcp"]).optional().describe("Who made the prediction"),
      deadline: z.string().optional().describe("Deadline (ISO date YYYY-MM-DD)"),
      goal_id: z.string().optional().describe("Linked goal ID"),
      metadata: z.record(z.string(), z.any()).optional().describe("Arbitrary JSON metadata"),
      status: z.enum(["open", "resolved", "voided"]).optional().describe("Filter by status (for list)"),
      overdue: z.boolean().optional().describe("Only show overdue predictions (for list)"),
      limit: z.number().optional().describe("Max results for list (default 50)"),
      resolution: z.enum(["true", "false", "partial"]).optional().describe("Resolution outcome (for resolve)"),
      resolution_notes: z.string().optional().describe("Notes explaining resolution"),
      resolution_memory_id: z.string().optional().describe("Memory ID with evidence for resolution"),
    },
    async (args) => {
      const store = new PredictionStore(db);

      try {
        switch (args.action) {
          case "create": {
            if (!args.claim) {
              return { content: [{ type: "text" as const, text: "Error: claim is required for create" }], isError: true };
            }
            if (args.confidence === undefined) {
              return { content: [{ type: "text" as const, text: "Error: confidence is required for create" }], isError: true };
            }
            const prediction = store.create({
              claim: args.claim,
              confidence: args.confidence,
              domain: args.domain,
              source: args.source,
              deadline: args.deadline,
              goal_id: args.goal_id,
              metadata: args.metadata,
            });

            const meta: string[] = [`id: ${prediction.id}`, `confidence: ${(prediction.confidence * 100).toFixed(0)}%`, `domain: ${prediction.domain}`];
            if (prediction.deadline) meta.push(`deadline: ${prediction.deadline}`);
            return { content: [{ type: "text" as const, text: `Created prediction: "${prediction.claim}" (${meta.join(" | ")})` }] };
          }

          case "list": {
            const predictions = store.list({
              status: args.status,
              domain: args.domain,
              source: args.source,
              overdue: args.overdue,
              limit: args.limit,
            });

            if (predictions.length === 0) {
              return { content: [{ type: "text" as const, text: "No predictions found matching filters." }] };
            }

            const lines = predictions.map((p) => {
              const meta: string[] = [`${(p.confidence * 100).toFixed(0)}%`, p.domain, p.status];
              if (p.deadline) meta.push(`deadline: ${p.deadline}`);
              if (p.resolution) meta.push(`resolution: ${p.resolution}`);
              return `[${p.id}] ${p.claim}\n  (${meta.join(" | ")})`;
            });

            return { content: [{ type: "text" as const, text: `Predictions (${predictions.length}):\n\n${lines.join("\n\n")}` }] };
          }

          case "resolve": {
            if (!args.id) {
              return { content: [{ type: "text" as const, text: "Error: id is required for resolve" }], isError: true };
            }
            if (!args.resolution) {
              return { content: [{ type: "text" as const, text: "Error: resolution is required for resolve" }], isError: true };
            }
            const updated = store.resolve(args.id, {
              resolution: args.resolution,
              resolution_notes: args.resolution_notes,
              resolution_memory_id: args.resolution_memory_id,
            });

            if (!updated) {
              return { content: [{ type: "text" as const, text: "Prediction not found." }] };
            }

            const outcomeLabel = args.resolution === "true" ? "CORRECT" : args.resolution === "false" ? "WRONG" : "PARTIAL";
            return { content: [{ type: "text" as const, text: `Resolved prediction as ${outcomeLabel}: "${updated.claim}" (was ${(updated.confidence * 100).toFixed(0)}% confident)` }] };
          }

          case "get": {
            if (!args.id) {
              return { content: [{ type: "text" as const, text: "Error: id is required for get" }], isError: true };
            }
            const prediction = store.getById(args.id);
            if (!prediction) {
              return { content: [{ type: "text" as const, text: "Prediction not found." }] };
            }

            const lines = [
              `ID: ${prediction.id}`,
              `Claim: ${prediction.claim}`,
              `Confidence: ${(prediction.confidence * 100).toFixed(0)}%`,
              `Domain: ${prediction.domain}`,
              `Status: ${prediction.status}`,
              `Source: ${prediction.source}`,
            ];
            if (prediction.deadline) lines.push(`Deadline: ${prediction.deadline}`);
            if (prediction.goal_id) lines.push(`Goal: ${prediction.goal_id}`);
            if (prediction.resolution) lines.push(`Resolution: ${prediction.resolution}`);
            if (prediction.resolution_notes) lines.push(`Notes: ${prediction.resolution_notes}`);
            if (prediction.resolved_at) lines.push(`Resolved at: ${prediction.resolved_at}`);
            lines.push(`Created: ${prediction.created_at}`);
            if (Object.keys(prediction.metadata).length > 0) {
              lines.push(`Metadata: ${JSON.stringify(prediction.metadata)}`);
            }

            return { content: [{ type: "text" as const, text: lines.join("\n") }] };
          }

          case "stats": {
            const stats = store.getStats({
              domain: args.domain,
              source: args.source,
            });

            const lines = [
              `Total predictions: ${stats.total_predictions}`,
              `Resolved: ${stats.resolved_count}`,
              `Brier score: ${stats.brier_score.toFixed(4)} (lower is better; 0 = perfect, 0.25 = random)`,
              `Overconfidence bias: ${stats.overconfidence_bias.toFixed(4)} (positive = overconfident, negative = underconfident)`,
            ];

            if (stats.calibration_curve.length > 0) {
              lines.push("", "Calibration curve:");
              for (const bucket of stats.calibration_curve) {
                lines.push(`  ${(bucket.range_start * 100).toFixed(0)}-${(bucket.range_end * 100).toFixed(0)}%: predicted ${(bucket.predicted_avg * 100).toFixed(1)}%, actual ${(bucket.actual_freq * 100).toFixed(1)}% (n=${bucket.count})`);
              }
            }

            if (stats.domain_breakdown.length > 0) {
              lines.push("", "Domain breakdown:");
              for (const d of stats.domain_breakdown) {
                lines.push(`  ${d.domain}: Brier=${d.brier_score.toFixed(4)}, accuracy=${(d.accuracy * 100).toFixed(1)}% (n=${d.count})`);
              }
            }

            if (stats.trend.length > 0) {
              lines.push("", "Monthly trend:");
              for (const t of stats.trend) {
                lines.push(`  ${t.month}: Brier=${t.brier_score.toFixed(4)} (n=${t.count})`);
              }
            }

            return { content: [{ type: "text" as const, text: lines.join("\n") }] };
          }
        }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );
}
