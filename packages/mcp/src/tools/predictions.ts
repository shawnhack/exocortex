import { z } from "zod";
import { PredictionStore } from "@exocortex/core";
import type { ToolRegistrationContext } from "./types.js";

export function registerPredictionTools(ctx: ToolRegistrationContext): void {
  const { server, db } = ctx;

  // prediction_create
  server.tool(
    "prediction_create",
    "Create a new prediction with a specific claim and confidence level. Predictions are explicit forecasts that can be tracked, resolved, and calibrated over time.",
    {
      claim: z.string().describe("The specific claim being predicted"),
      confidence: z.number().min(0).max(1).describe("Confidence level 0-1 (e.g. 0.75 = 75% confident this will happen)"),
      domain: z.enum(["technical", "product", "market", "personal", "political", "scientific", "general"]).optional().describe("Domain category (default 'general')"),
      source: z.enum(["user", "sentinel", "agent", "mcp"]).optional().describe("Who made this prediction (default 'user')"),
      deadline: z.string().optional().describe("When this prediction should be resolved by (ISO date YYYY-MM-DD)"),
      goal_id: z.string().optional().describe("Optional linked goal ID"),
      metadata: z.record(z.string(), z.any()).optional().describe("Arbitrary JSON metadata"),
    },
    async (args) => {
      try {
        const store = new PredictionStore(db);
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

        return { content: [{ type: "text", text: `Created prediction: "${prediction.claim}" (${meta.join(" | ")})` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // prediction_list
  server.tool(
    "prediction_list",
    "List predictions with optional filters by status, domain, source, or overdue.",
    {
      status: z.enum(["open", "resolved", "voided"]).optional().describe("Filter by status (default: all)"),
      domain: z.enum(["technical", "product", "market", "personal", "political", "scientific", "general"]).optional().describe("Filter by domain"),
      source: z.enum(["user", "sentinel", "agent", "mcp"]).optional().describe("Filter by source"),
      overdue: z.boolean().optional().describe("Only show overdue predictions (past deadline, still open)"),
      limit: z.number().optional().describe("Max results (default 50)"),
    },
    async (args) => {
      try {
        const store = new PredictionStore(db);
        const predictions = store.list({
          status: args.status,
          domain: args.domain,
          source: args.source,
          overdue: args.overdue,
          limit: args.limit,
        });

        if (predictions.length === 0) {
          return { content: [{ type: "text", text: "No predictions found matching filters." }] };
        }

        const lines = predictions.map((p) => {
          const meta: string[] = [`${(p.confidence * 100).toFixed(0)}%`, p.domain, p.status];
          if (p.deadline) meta.push(`deadline: ${p.deadline}`);
          if (p.resolution) meta.push(`resolution: ${p.resolution}`);
          return `[${p.id}] ${p.claim}\n  (${meta.join(" | ")})`;
        });

        return { content: [{ type: "text", text: `Predictions (${predictions.length}):\n\n${lines.join("\n\n")}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // prediction_resolve
  server.tool(
    "prediction_resolve",
    "Resolve a prediction as true, false, or partial. Creates a resolution memory for tracking.",
    {
      id: z.string().describe("Prediction ID"),
      resolution: z.enum(["true", "false", "partial"]).describe("Resolution: true (happened), false (didn't happen), partial (partially happened)"),
      resolution_notes: z.string().optional().describe("Notes explaining the resolution"),
      resolution_memory_id: z.string().optional().describe("Optional memory ID with evidence for this resolution"),
    },
    async (args) => {
      try {
        const store = new PredictionStore(db);
        const updated = store.resolve(args.id, {
          resolution: args.resolution,
          resolution_notes: args.resolution_notes,
          resolution_memory_id: args.resolution_memory_id,
        });

        if (!updated) {
          return { content: [{ type: "text", text: "Prediction not found." }] };
        }

        const outcomeLabel = args.resolution === "true" ? "CORRECT" : args.resolution === "false" ? "WRONG" : "PARTIAL";
        return { content: [{ type: "text", text: `Resolved prediction as ${outcomeLabel}: "${updated.claim}" (was ${(updated.confidence * 100).toFixed(0)}% confident)` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // prediction_get
  server.tool(
    "prediction_get",
    "Get full details of a specific prediction by ID.",
    {
      id: z.string().describe("Prediction ID"),
    },
    async (args) => {
      try {
        const store = new PredictionStore(db);
        const prediction = store.getById(args.id);

        if (!prediction) {
          return { content: [{ type: "text", text: "Prediction not found." }] };
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

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // prediction_stats
  server.tool(
    "prediction_stats",
    "Get calibration statistics: Brier score, calibration curve, overconfidence bias, domain breakdown, and monthly trend.",
    {
      domain: z.string().optional().describe("Filter by domain"),
      source: z.string().optional().describe("Filter by source"),
    },
    async (args) => {
      try {
        const store = new PredictionStore(db);
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

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );
}
