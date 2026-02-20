// Database
export { getDb, closeDb, getDbForTesting } from "./db/connection.js";
export type { DatabaseSync } from "./db/connection.js";
export {
  initializeSchema,
  getSetting,
  setSetting,
  getAllSettings,
} from "./db/schema.js";

// Memory
export type {
  Memory,
  MemoryRow,
  CreateMemoryInput,
  CreateMemoryResult,
  UpdateMemoryInput,
  SearchQuery,
  SearchResult,
  MemoryStats,
  ContentType,
  MemorySource,
} from "./memory/types.js";
export { MemoryStore, stripPrivateContent } from "./memory/store.js";
export { MemorySearch, getSearchMisses } from "./memory/search.js";
export type { SearchMissAggregate } from "./memory/search.js";
export { autoGenerateTags } from "./memory/auto-tags.js";
export { generateKeywords } from "./memory/keywords.js";
export {
  cosineSimilarity,
  recencyScore,
  frequencyScore,
  usefulnessScore,
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
export { digestTranscript, extractFacts } from "./memory/digest.js";
export type { DigestResult, DigestAction, ExtractedFact, FactType } from "./memory/digest.js";

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
export { computeGraphStats, computeCentrality, getTopBridgeEntities, detectCommunities } from "./entities/graph.js";
export type { GraphStats, EntityCentrality, Community } from "./entities/graph.js";

// Intelligence
export {
  findClusters,
  consolidateCluster,
  generateBasicSummary,
  getConsolidations,
} from "./intelligence/consolidation.js";
export type {
  ConsolidationCluster,
  ConsolidationResult,
} from "./intelligence/consolidation.js";
export {
  detectContradictions,
  recordContradiction,
  getContradictions,
  updateContradiction,
} from "./intelligence/contradictions.js";
export type {
  Contradiction,
  ContradictionCandidate,
} from "./intelligence/contradictions.js";
export { getTimeline, getTemporalStats, getMemoryLineage, getDecisionTimeline } from "./intelligence/temporal.js";
export type { TimelineEntry, TemporalStats, LineageEntry, DecisionTimelineEntry } from "./intelligence/temporal.js";
export {
  getArchiveCandidates,
  archiveStaleMemories,
} from "./intelligence/decay.js";
export type {
  ArchiveOptions,
  ArchiveCandidate,
  ArchiveResult,
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
export { generateSynthesis } from "./intelligence/synthesis.js";
export type { SynthesisOptions } from "./intelligence/synthesis.js";
export { reembedMissing, backfillEntities, recalibrateImportance, tuneWeights, pruneOldData } from "./intelligence/maintenance.js";
export type { ReembedResult, BackfillEntitiesResult, RecalibrateResult, TuneWeightsResult, PruneResult } from "./intelligence/maintenance.js";
export { densifyEntityGraph } from "./intelligence/graph-densify.js";
export type { DensifyOptions, DensifyResult } from "./intelligence/graph-densify.js";
export { buildCoRetrievalLinks } from "./intelligence/co-retrieval.js";
export type { CoRetrievalLinkOptions, CoRetrievalLinkResult } from "./intelligence/co-retrieval.js";

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

// Backup
export {
  exportData,
  encryptBackup,
  decryptBackup,
  importData,
  backupDatabase,
} from "./backup.js";
export type { BackupData, BackupDatabaseOptions, BackupDatabaseResult } from "./backup.js";
