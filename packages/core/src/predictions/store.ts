import type { DatabaseSync } from "node:sqlite";
import { ulid } from "ulid";
import { MemoryStore } from "../memory/store.js";
import { safeJsonParse } from "../db/schema.js";
import type {
  Prediction,
  PredictionStatus,
  PredictionDomain,
  PredictionResolution,
  PredictionSource,
  CreatePredictionInput,
  ResolvePredictionInput,
  PredictionListFilter,
  CalibrationStats,
  CalibrationBucket,
  DomainStats,
  CalibrationTrend,
} from "./types.js";

interface PredictionRow {
  id: string;
  claim: string;
  confidence: number;
  domain: string;
  status: string;
  resolution: string | null;
  resolution_notes: string | null;
  resolution_memory_id: string | null;
  source: string;
  goal_id: string | null;
  deadline: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

function rowToPrediction(row: PredictionRow): Prediction {
  return {
    id: row.id,
    claim: row.claim,
    confidence: row.confidence,
    domain: row.domain as PredictionDomain,
    status: row.status as PredictionStatus,
    resolution: row.resolution as PredictionResolution | null,
    resolution_notes: row.resolution_notes,
    resolution_memory_id: row.resolution_memory_id,
    source: row.source as PredictionSource,
    goal_id: row.goal_id,
    deadline: row.deadline,
    metadata: safeJsonParse<Record<string, unknown>>(row.metadata, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
    resolved_at: row.resolved_at,
  };
}

function resolutionToOutcome(resolution: PredictionResolution): number {
  switch (resolution) {
    case "true": return 1.0;
    case "false": return 0.0;
    case "partial": return 0.5;
  }
}

export class PredictionStore {
  constructor(private db: DatabaseSync) {}

  create(input: CreatePredictionInput): Prediction {
    const id = ulid();
    const now = new Date().toISOString().replace("T", " ").replace("Z", "");

    if (input.confidence < 0 || input.confidence > 1) {
      throw new Error("Confidence must be between 0 and 1");
    }

    this.db
      .prepare(
        `INSERT INTO predictions (id, claim, confidence, domain, source, deadline, goal_id, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.claim,
        input.confidence,
        input.domain ?? "general",
        input.source ?? "user",
        input.deadline ?? null,
        input.goal_id ?? null,
        JSON.stringify(input.metadata ?? {}),
        now,
        now
      );

    return this.getById(id)!;
  }

  getById(id: string): Prediction | null {
    const row = this.db
      .prepare("SELECT * FROM predictions WHERE id = ?")
      .get(id) as PredictionRow | undefined;

    return row ? rowToPrediction(row) : null;
  }

  list(filter?: PredictionListFilter): Prediction[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter?.status) {
      conditions.push("status = ?");
      params.push(filter.status);
    }

    if (filter?.domain) {
      conditions.push("domain = ?");
      params.push(filter.domain);
    }

    if (filter?.source) {
      conditions.push("source = ?");
      params.push(filter.source);
    }

    if (filter?.overdue) {
      conditions.push("status = 'open' AND deadline IS NOT NULL AND deadline < datetime('now')");
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filter?.limit ?? 50;

    const rows = this.db
      .prepare(`SELECT * FROM predictions ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, limit) as unknown as PredictionRow[];

    return rows.map(rowToPrediction);
  }

  resolve(id: string, input: ResolvePredictionInput): Prediction | null {
    const existing = this.getById(id);
    if (!existing) return null;

    if (existing.status !== "open") {
      throw new Error(`Prediction ${id} is already ${existing.status}`);
    }

    const now = new Date().toISOString().replace("T", " ").replace("Z", "");

    this.db
      .prepare(
        `UPDATE predictions
         SET status = 'resolved',
             resolution = ?,
             resolution_notes = ?,
             resolution_memory_id = ?,
             resolved_at = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(
        input.resolution,
        input.resolution_notes ?? null,
        input.resolution_memory_id ?? null,
        now,
        now,
        id
      );

    // Create a resolution memory (fire-and-forget, non-critical)
    try {
      const store = new MemoryStore(this.db);
      const outcomeLabel = input.resolution === "true" ? "CORRECT" : input.resolution === "false" ? "WRONG" : "PARTIAL";
      const content = `Prediction resolved: ${outcomeLabel} (${existing.confidence * 100}% confidence)\nClaim: ${existing.claim}${input.resolution_notes ? `\nNotes: ${input.resolution_notes}` : ""}`;
      store.create({
        content,
        content_type: "note",
        source: "mcp",
        importance: 0.4,
        tags: ["prediction-resolution"],
        metadata: { prediction_id: id, resolution: input.resolution },
      }).catch(() => { /* non-critical */ });
    } catch {
      // Non-critical — resolution still recorded
    }

    return this.getById(id);
  }

  void(id: string, reason?: string): Prediction | null {
    const existing = this.getById(id);
    if (!existing) return null;

    if (existing.status !== "open") {
      throw new Error(`Prediction ${id} is already ${existing.status}`);
    }

    const now = new Date().toISOString().replace("T", " ").replace("Z", "");

    this.db
      .prepare(
        `UPDATE predictions
         SET status = 'voided',
             resolution_notes = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(reason ?? null, now, id);

    return this.getById(id);
  }

  delete(id: string): boolean {
    const result = this.db.prepare("DELETE FROM predictions WHERE id = ?").run(id);
    return (result as { changes: number }).changes > 0;
  }

  findOverdue(): Prediction[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM predictions
         WHERE status = 'open'
           AND deadline IS NOT NULL
           AND deadline < datetime('now')
         ORDER BY deadline ASC`
      )
      .all() as unknown as PredictionRow[];

    return rows.map(rowToPrediction);
  }

  getStats(filter?: { domain?: string; source?: string }): CalibrationStats {
    const conditions: string[] = ["status = 'resolved'"];
    const params: string[] = [];

    if (filter?.domain) {
      conditions.push("domain = ?");
      params.push(filter.domain);
    }

    if (filter?.source) {
      conditions.push("source = ?");
      params.push(filter.source);
    }

    const where = conditions.join(" AND ");

    // Get all resolved predictions matching filter
    const resolved = this.db
      .prepare(`SELECT * FROM predictions WHERE ${where} ORDER BY resolved_at ASC`)
      .all(...params) as unknown as PredictionRow[];

    // Total predictions count (all statuses matching domain/source filter)
    const totalConditions: string[] = [];
    const totalParams: string[] = [];
    if (filter?.domain) {
      totalConditions.push("domain = ?");
      totalParams.push(filter.domain);
    }
    if (filter?.source) {
      totalConditions.push("source = ?");
      totalParams.push(filter.source);
    }
    const totalWhere = totalConditions.length > 0 ? `WHERE ${totalConditions.join(" AND ")}` : "";
    const totalCount = (
      this.db.prepare(`SELECT COUNT(*) as count FROM predictions ${totalWhere}`).get(...totalParams) as { count: number }
    ).count;

    if (resolved.length === 0) {
      return {
        total_predictions: totalCount,
        resolved_count: 0,
        brier_score: 0,
        overconfidence_bias: 0,
        calibration_curve: [],
        domain_breakdown: [],
        trend: [],
      };
    }

    // Brier score: mean((confidence - outcome)^2)
    let brierSum = 0;
    let biasSum = 0;

    for (const row of resolved) {
      const outcome = resolutionToOutcome(row.resolution as PredictionResolution);
      const diff = row.confidence - outcome;
      brierSum += diff * diff;
      biasSum += row.confidence - outcome;
    }

    const brierScore = brierSum / resolved.length;
    const overconfidenceBias = biasSum / resolved.length;

    // Calibration curve: 10 decile buckets
    const buckets: CalibrationBucket[] = [];
    for (let i = 0; i < 10; i++) {
      const rangeStart = i * 0.1;
      const rangeEnd = (i + 1) * 0.1;

      const inBucket = resolved.filter((r) => {
        if (i === 9) return r.confidence >= rangeStart && r.confidence <= rangeEnd;
        return r.confidence >= rangeStart && r.confidence < rangeEnd;
      });

      if (inBucket.length > 0) {
        const predictedAvg = inBucket.reduce((s, r) => s + r.confidence, 0) / inBucket.length;
        const actualFreq = inBucket.reduce(
          (s, r) => s + resolutionToOutcome(r.resolution as PredictionResolution),
          0
        ) / inBucket.length;

        buckets.push({
          range_start: rangeStart,
          range_end: rangeEnd,
          predicted_avg: Math.round(predictedAvg * 1000) / 1000,
          actual_freq: Math.round(actualFreq * 1000) / 1000,
          count: inBucket.length,
        });
      }
    }

    // Domain breakdown
    const domainMap = new Map<string, PredictionRow[]>();
    for (const row of resolved) {
      const arr = domainMap.get(row.domain) ?? [];
      arr.push(row);
      domainMap.set(row.domain, arr);
    }

    const domainBreakdown: DomainStats[] = [];
    for (const [domain, rows] of domainMap) {
      let dBrierSum = 0;
      let correctCount = 0;

      for (const row of rows) {
        const outcome = resolutionToOutcome(row.resolution as PredictionResolution);
        dBrierSum += (row.confidence - outcome) ** 2;
        if (row.resolution === "true") correctCount++;
      }

      domainBreakdown.push({
        domain: domain as PredictionDomain,
        brier_score: Math.round((dBrierSum / rows.length) * 10000) / 10000,
        accuracy: Math.round((correctCount / rows.length) * 1000) / 1000,
        count: rows.length,
      });
    }

    // Monthly trend
    const monthMap = new Map<string, PredictionRow[]>();
    for (const row of resolved) {
      const month = (row.resolved_at ?? row.updated_at).substring(0, 7); // YYYY-MM
      const arr = monthMap.get(month) ?? [];
      arr.push(row);
      monthMap.set(month, arr);
    }

    const trend: CalibrationTrend[] = [];
    for (const [month, rows] of monthMap) {
      let mBrierSum = 0;
      for (const row of rows) {
        const outcome = resolutionToOutcome(row.resolution as PredictionResolution);
        mBrierSum += (row.confidence - outcome) ** 2;
      }

      trend.push({
        month,
        brier_score: Math.round((mBrierSum / rows.length) * 10000) / 10000,
        count: rows.length,
      });
    }

    trend.sort((a, b) => a.month.localeCompare(b.month));

    return {
      total_predictions: totalCount,
      resolved_count: resolved.length,
      brier_score: Math.round(brierScore * 10000) / 10000,
      overconfidence_bias: Math.round(overconfidenceBias * 10000) / 10000,
      calibration_curve: buckets,
      domain_breakdown: domainBreakdown,
      trend,
    };
  }
}
