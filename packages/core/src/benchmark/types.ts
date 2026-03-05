/** Benchmark question category */
export type BenchmarkCategory =
  | "factual_recall"
  | "decision_continuity"
  | "context_awareness"
  | "cross_reference"
  | "technique_application";

/** A single benchmark question with ground truth */
export interface BenchmarkQuestion {
  id: string;
  category: BenchmarkCategory;
  question: string;
  /** Expected facts that should appear in the answer */
  required_facts: string[];
  /** Facts that should NOT appear (hallucination traps) */
  forbidden_facts: string[];
  /** Full ground truth answer for judge reference */
  ground_truth: string;
}

/** Synthetic memory to seed into the benchmark DB */
export interface SeedMemory {
  content: string;
  content_type: "text" | "note" | "summary";
  importance: number;
  tags: string[];
  /** Which question IDs this memory is relevant to */
  relevant_to: string[];
}

/** Synthetic entity for the benchmark dataset */
export interface SeedEntity {
  name: string;
  type: "project" | "technology" | "person" | "concept";
  aliases: string[];
}

/** Synthetic goal for the benchmark dataset */
export interface SeedGoal {
  title: string;
  description: string;
  status: "active" | "completed";
  priority: "low" | "medium" | "high" | "critical";
  milestones: { title: string; status: "pending" | "in_progress" | "completed" }[];
}

/** The full synthetic benchmark dataset */
export interface BenchmarkDataset {
  memories: SeedMemory[];
  entities: SeedEntity[];
  goals: SeedGoal[];
  questions: BenchmarkQuestion[];
}

/** Scores for a single answer across 4 dimensions */
export interface DimensionScores {
  accuracy: number;
  specificity: number;
  continuity: number;
  hallucination: number;
}

/** Result of running a single question */
export interface QuestionResult {
  question: BenchmarkQuestion;
  with_memory: {
    answer: string;
    scores: DimensionScores;
    composite: number;
    latency_ms: number;
    tokens: { input: number; output: number };
  };
  without_memory: {
    answer: string;
    scores: DimensionScores;
    composite: number;
    latency_ms: number;
    tokens: { input: number; output: number };
  };
}

/** Aggregated category results */
export interface CategoryResult {
  category: BenchmarkCategory;
  with_memory_avg: number;
  without_memory_avg: number;
  improvement_pct: number;
  question_count: number;
}

/** Full benchmark report */
export interface BenchmarkReport {
  timestamp: string;
  model: string;
  overall: {
    with_memory: number;
    without_memory: number;
    improvement_pct: number;
    total_tokens: { input: number; output: number };
    avg_latency_ms: { with_memory: number; without_memory: number };
  };
  by_category: CategoryResult[];
  questions: QuestionResult[];
}

/** Options for running the benchmark */
export interface BenchmarkOptions {
  model?: string;
  verbose?: boolean;
  apiKey?: string;
}
