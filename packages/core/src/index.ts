// Database
export { getDb, closeDb, getDbForTesting } from "./db/connection.js";
export type { DatabaseSync } from "./db/connection.js";
export {
  initializeSchema,
  getSetting,
  setSetting,
  getAllSettings,
  safeJsonParse,
} from "./db/schema.js";

// Memory
// MemoryRow is intentionally NOT re-exported — it models raw SQLite rows
// (is_active: number, embedding: Uint8Array, metadata: JSON string) and should
// only flow through rowToMemory/MemoryStore. External callers want Memory.
export type {
  Memory,
  CreateMemoryInput,
  CreateMemoryResult,
  UpdateMemoryInput,
  SearchQuery,
  SearchResult,
  MemoryStats,
  ContentType,
  MemorySource,
  MemoryTier,
} from "./memory/types.js";
export { MemoryStore, stripPrivateContent, validateStorageGate } from "./memory/store.js";
export { MemorySearch, getSearchMisses } from "./memory/search.js";
export type { SearchMissAggregate } from "./memory/search.js";
export { autoGenerateTags } from "./memory/auto-tags.js";
export { generateKeywords } from "./memory/keywords.js";
export {
  cosineSimilarity,
  recencyScore,
  frequencyScore,
  usefulnessScore,
  qualityScore,
  tierBoost,
  computeHybridScore,
  getWeights,
  getRRFConfig,
  reciprocalRankFusion,
} from "./memory/scoring.js";
export type { ScoringWeights, RRFConfig } from "./memory/scoring.js";
export { MemoryLinkStore } from "./memory/links.js";
export type { LinkType, MemoryLink, LinkedMemoryRef } from "./memory/links.js";
export { splitIntoChunks } from "./memory/chunking.js";
export type { ChunkOptions } from "./memory/chunking.js";
export { detectTemporalExpiry } from "./memory/temporal-expiry.js";
export { rerankResults, isRerankEnabled, getRerankLimit } from "./memory/reranker.js";
export type { RerankerProvider, RerankedResult } from "./memory/reranker.js";
export {
  splitMarkdownSections,
  ingestMarkdownFile,
  ingestFiles,
} from "./memory/ingest.js";
export type {
  IngestOptions,
  IngestFileResult,
  IngestResult,
} from "./memory/ingest.js";
export {
  htmlToText,
  ingestUrl,
  ingestUrls,
} from "./memory/ingest-url.js";
export type {
  IngestUrlOptions,
  IngestUrlResult,
} from "./memory/ingest-url.js";
export {
  searchWeb,
  researchTopic,
} from "./memory/research.js";
export type {
  SearchHit,
  ResearchOptions,
  ResearchSourceResult,
  ResearchResult,
} from "./memory/research.js";
export { deepContext } from "./memory/deep-context.js";
export type {
  DeepContextOptions,
  DeepContextResult,
} from "./memory/deep-context.js";
export { digestTranscript, extractFacts as extractDigestFacts } from "./memory/digest.js";
export type { DigestResult, DigestAction, ExtractedFact as DigestExtractedFact, FactType } from "./memory/digest.js";
export { extractFacts, storeFacts, searchFacts } from "./memory/facts.js";
export type { ExtractedFact, StoredFact, SearchFactsOptions } from "./memory/facts.js";

// Embedding
export type { EmbeddingProvider } from "./embedding/types.js";
export { LocalEmbeddingProvider } from "./embedding/local.js";
export {
  getEmbeddingProvider,
  setEmbeddingProvider,
  resetEmbeddingProvider,
} from "./embedding/manager.js";

// Entities
export type { Entity, EntityType, CreateEntityInput, EntityRelationship, ExtractedRelationship } from "./entities/types.js";
export { EntityStore } from "./entities/store.js";
export { extractEntities, extractRelationships } from "./entities/extractor.js";
export type { ExtractedEntity } from "./entities/extractor.js";
export { computeGraphStats, computeCentrality, getTopBridgeEntities, detectCommunities, getCommunitySummaries } from "./entities/graph.js";
export type { GraphStats, EntityCentrality, Community, CommunityWithSummary } from "./entities/graph.js";
export { generateEntityProfile, recomputeEntityProfiles, getCachedProfiles } from "./entities/profile.js";
export type { RecomputeProfilesResult } from "./entities/profile.js";

// Intelligence
export {
  findClusters,
  consolidateCluster,
  generateBasicSummary,
  generateLLMSummary,
  validateSummary,
  getConsolidations,
  autoConsolidate,
  applyCommunityAwareFiltering,
} from "./intelligence/consolidation.js";
export type {
  ConsolidationCluster,
  ConsolidationResult,
  AutoConsolidateResult,
  CommunityAwareResult,
  LLMSummarizer,
} from "./intelligence/consolidation.js";
export {
  detectContradictions,
  recordContradiction,
  getContradictions,
  updateContradiction,
  autoDismissContradictions,
} from "./intelligence/contradictions.js";
export type {
  Contradiction,
  ContradictionCandidate,
  AutoDismissResult,
} from "./intelligence/contradictions.js";
export { getTimeline, getTemporalStats, getMemoryLineage, getDecisionTimeline, getTemporalHierarchy } from "./intelligence/temporal.js";
export type { TimelineEntry, TemporalStats, LineageEntry, DecisionTimelineEntry, HierarchyEpoch, HierarchyTheme, HierarchyEpisode, TemporalHierarchy, TemporalHierarchyOptions } from "./intelligence/temporal.js";
export {
  getArchiveCandidates,
  archiveStaleMemories,
  archiveExpired,
  expireSentinelReports,
} from "./intelligence/decay.js";
export type {
  ArchiveOptions,
  ArchiveCandidate,
  ArchiveResult,
  ExpireSentinelReportsResult,
} from "./intelligence/decay.js";
export {
  getPurgeCandidates,
  purgeTrash,
} from "./intelligence/purge.js";
export type {
  PurgeOptions,
  PurgeCandidate,
  PurgeResult,
} from "./intelligence/purge.js";
export { adjustImportance } from "./intelligence/importance.js";
export type {
  ImportanceAdjustOptions,
  ImportanceAdjustResult,
} from "./intelligence/importance.js";
export { runHealthChecks } from "./intelligence/health.js";
export type { HealthCheck, HealthReport } from "./intelligence/health.js";
export { runLint } from "./intelligence/lint.js";
export type { LintIssue, LintReport } from "./intelligence/lint.js";
export { generateSynthesis } from "./intelligence/synthesis.js";
export type { SynthesisOptions } from "./intelligence/synthesis.js";
export {
  reembedMissing,
  reembedAll,
  backfillEntities,
  recalibrateImportance,
  tuneWeights,
  backfillMemoryCanonicalization,
  pruneOldData,
  recomputeQualityScores,
  promoteMemoryTiers,
} from "./intelligence/maintenance.js";
export type {
  ReembedResult,
  ReembedAllResult,
  BackfillEntitiesResult,
  RecalibrateResult,
  TuneWeightsResult,
  CanonicalBackfillResult,
  PruneResult,
  RecomputeQualityResult,
  TierPromotionResult,
} from "./intelligence/maintenance.js";
export { densifyEntityGraph } from "./intelligence/graph-densify.js";
export type { DensifyOptions, DensifyResult } from "./intelligence/graph-densify.js";
export { buildCoRetrievalLinks } from "./intelligence/co-retrieval.js";
export type { CoRetrievalLinkOptions, CoRetrievalLinkResult } from "./intelligence/co-retrieval.js";
export {
  optimizeRetrieval,
  mineBenchmarkQueries,
} from "./intelligence/retrieval-optimizer.js";
export type {
  OptimizationConfig,
  OptimizationResult,
  BenchmarkQuery,
} from "./intelligence/retrieval-optimizer.js";
export {
  getGoldenQueries,
  setGoldenQueries,
  getLatestRetrievalRegressionRunId,
  resetGoldenBaselines,
  promoteGoldenBaselinesFromRun,
  compareRetrievalAgainstRun,
  runRetrievalRegression,
} from "./intelligence/retrieval-regression.js";
export type {
  GoldenQueryDefinition,
  RetrievalRegressionOptions,
  RetrievalRegressionCompareOptions,
  RetrievalRegressionCompareResult,
  RetrievalBaselineResetResult,
  RetrievalBaselinePromoteResult,
  RetrievalRunSnapshot,
  RetrievalRegressionQueryResult,
  RetrievalRegressionResult,
} from "./intelligence/retrieval-regression.js";

// Goals
export type {
  Goal,
  GoalStatus,
  GoalPriority,
  CreateGoalInput,
  UpdateGoalInput,
  GoalWithProgress,
  GoalProgressEntry,
  Milestone,
  CreateMilestoneInput,
} from "./goals/types.js";
export { GoalStore } from "./goals/store.js";

// Agent Tasks
export type {
  AgentTask,
  AgentTaskStatus,
  AgentTaskPriority,
  CreateAgentTaskInput,
  UpdateAgentTaskInput,
  AgentTaskFilter,
} from "./tasks/types.js";
export { AgentTaskStore } from "./tasks/store.js";

// Predictions
export type {
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
} from "./predictions/types.js";
export { PredictionStore } from "./predictions/store.js";

// Tag normalization
export {
  DEFAULT_TAG_ALIAS_MAP,
  parseTagAliasMap,
  getTagAliasMap,
  normalizeTag,
  normalizeTags,
  stringSimilarity,
  suggestTagMerges,
  applyTagMerge,
  parseCanonicalMap,
  getCanonicalMap,
  canonicalizeTags,
} from "./memory/tag-normalization.js";
export type { TagMergeSuggestion } from "./memory/tag-normalization.js";

// Analytics
export {
  getAnalyticsSummary,
  getAccessDistribution,
  getTagEffectiveness,
  getProducerQuality,
  getQualityTrend,
  getQualityDistribution,
  getQualityHistogram,
  getQueryOutcomes,
  getRetrievalStats,
} from "./memory/analytics.js";
export type {
  AnalyticsSummary,
  AccessBucket,
  TagEffectiveness,
  ProducerQuality,
  QualityTrendEntry,
  QualityDistribution,
  QualityHistogramBucket,
  QueryOutcome,
  RetrievalStats,
} from "./memory/analytics.js";

// Observability
export {
  incrementCounter,
  getCounter,
  getCounters,
} from "./observability/counters.js";
export type { CounterRow } from "./observability/counters.js";
export {
  recordJobOutcome,
  getJobHealth,
  getJobAlerts,
} from "./observability/job-health.js";
export type { JobOutcome, JobHealthSummary } from "./observability/job-health.js";

// Backup
export {
  exportData,
  encryptBackup,
  decryptBackup,
  importData,
  backupDatabase,
  verifyBackup,
} from "./backup.js";
export type { BackupData, BackupDatabaseOptions, BackupDatabaseResult, VerifyBackupResult } from "./backup.js";

// Obsidian export
export { exportToObsidian } from "./export/obsidian.js";
export type { ObsidianExportOptions, ObsidianExportResult } from "./export/obsidian.js";
export { syncToObsidian } from "./export/obsidian-sync.js";
export type { SyncOptions, SyncResult } from "./export/obsidian-sync.js";

// Wiki compilation
export { compileWiki, refreshWiki } from "./intelligence/wiki-compile.js";
export type { WikiCompileOptions, WikiCompileResult, WikiArticle, WikiRefreshResult } from "./intelligence/wiki-compile.js";

// Hierarchical navigation
export { buildPalace, compactPalace, buildWakeUpContext } from "./intelligence/hierarchy.js";
export type { Palace, Wing, Hall, Room, Tunnel, PalaceStats } from "./intelligence/hierarchy.js";

// Benchmarks
export { runBenchmark } from "./intelligence/benchmark.js";
export type { BenchmarkResult, BenchmarkOptions, QueryResult } from "./intelligence/benchmark.js";

// Embedding models
export { EMBEDDING_MODELS, DEFAULT_MODEL, getModelInfo, getDefaultModel } from "./embedding/models.js";
export type { EmbeddingModelInfo } from "./embedding/models.js";

// Agent Diary
export { writeDiaryEntry, readDiary, listDiaryAgents, ensureDiarySchema } from "./intelligence/diary.js";
export type { DiaryEntry, DiaryWriteResult } from "./intelligence/diary.js";

// Security
export {
  sanitizeContent,
  hasHighSeverityThreats,
  checkUrl,
  filterUrls,
  wrapExternalContent,
  stripBoundaryMarkers,
  buildProvenanceMetadata,
  classifyTrust,
  validateContent,
  redactSensitiveData,
  detectInfluence,
  buildProvenance,
  extractProvenance,
  mergeProvenance,
  aggregateTrust,
  runBehavioralAudit,
} from "./security/index.js";
export type {
  SanitizeResult,
  ThreatDetection,
  ThreatType,
  UrlCheckResult,
  BoundaryOptions,
  TrustLevel,
  ValidationResult,
  ValidationWarning,
  InfluenceScore,
  InfluenceSignal,
  ProvenanceRecord,
  AnomalyReport,
  Anomaly,
  AnomalyType,
  MonitorStats,
} from "./security/index.js";
