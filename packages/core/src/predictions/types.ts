export type PredictionStatus = 'open' | 'resolved' | 'voided';
export type PredictionResolution = 'true' | 'false' | 'partial';
export type PredictionDomain = 'technical' | 'product' | 'market' | 'personal' | 'political' | 'scientific' | 'general';
export type PredictionSource = 'user' | 'sentinel' | 'agent' | 'mcp';

export interface Prediction {
  id: string;
  claim: string;
  confidence: number;
  domain: PredictionDomain;
  status: PredictionStatus;
  resolution: PredictionResolution | null;
  resolution_notes: string | null;
  resolution_memory_id: string | null;
  source: PredictionSource;
  goal_id: string | null;
  deadline: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface CreatePredictionInput {
  claim: string;
  confidence: number;
  domain?: PredictionDomain;
  source?: PredictionSource;
  deadline?: string;
  goal_id?: string;
  metadata?: Record<string, unknown>;
}

export interface ResolvePredictionInput {
  resolution: PredictionResolution;
  resolution_notes?: string;
  resolution_memory_id?: string;
}

export interface PredictionListFilter {
  status?: PredictionStatus;
  domain?: PredictionDomain;
  source?: PredictionSource;
  overdue?: boolean;
  limit?: number;
}

export interface CalibrationBucket {
  range_start: number;
  range_end: number;
  predicted_avg: number;
  actual_freq: number;
  count: number;
}

export interface DomainStats {
  domain: PredictionDomain;
  brier_score: number;
  accuracy: number;
  count: number;
}

export interface CalibrationTrend {
  month: string;
  brier_score: number;
  count: number;
}

export interface CalibrationStats {
  total_predictions: number;
  resolved_count: number;
  brier_score: number;
  overconfidence_bias: number;
  calibration_curve: CalibrationBucket[];
  domain_breakdown: DomainStats[];
  trend: CalibrationTrend[];
}
