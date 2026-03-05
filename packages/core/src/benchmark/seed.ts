import type { BenchmarkDataset } from "./types.js";

/**
 * Synthetic benchmark dataset for "Nexara" — a fictional data analytics platform.
 * ~27 memories, 4 entities, 2 goals, 15 questions across 5 categories.
 */
export const BENCHMARK_DATASET: BenchmarkDataset = {
  entities: [
    {
      name: "Nexara",
      type: "project",
      aliases: ["nexara-platform", "nexara-analytics"],
    },
    {
      name: "ClickHouse",
      type: "technology",
      aliases: ["clickhouse-db"],
    },
    {
      name: "Kafka",
      type: "technology",
      aliases: ["apache-kafka", "kafka-streams"],
    },
    {
      name: "DataVault",
      type: "concept",
      aliases: ["data-vault", "vault-layer"],
    },
  ],

  goals: [
    {
      title: "Launch Nexara v2.0 real-time dashboard",
      description:
        "Ship the real-time analytics dashboard with sub-second query latency on ClickHouse, replacing the legacy batch-based Postgres reporting layer.",
      status: "active",
      priority: "high",
      milestones: [
        { title: "Migrate historical data to ClickHouse", status: "completed" },
        { title: "Build Kafka ingestion pipeline", status: "completed" },
        { title: "Implement dashboard query layer", status: "in_progress" },
        { title: "Load testing at 50k events/sec", status: "pending" },
        { title: "GA release with monitoring", status: "pending" },
      ],
    },
    {
      title: "Reduce Nexara infrastructure cost by 30%",
      description:
        "Optimize compute and storage costs across the Nexara platform by consolidating services and right-sizing instances.",
      status: "active",
      priority: "medium",
      milestones: [
        { title: "Audit current cloud spend", status: "completed" },
        { title: "Consolidate staging environments", status: "completed" },
        { title: "Implement auto-scaling policies", status: "pending" },
      ],
    },
  ],

  memories: [
    // === FACTUAL RECALL (6 memories) ===
    {
      content:
        "Nexara platform infrastructure: API gateway on port 8443 (TLS), ClickHouse analytics DB on port 9440 (native TLS) and 8443 (HTTP), Kafka brokers on ports 9092-9094 (3-node cluster), Redis cache on port 6380 (TLS enabled), Postgres metadata DB on port 5432. All services run in the us-east-1 region on AWS EKS.",
      content_type: "note",
      importance: 0.7,
      tags: ["infrastructure", "nexara", "ports"],
      relevant_to: ["factual_1"],
    },
    {
      content:
        "Nexara version history: v1.0 launched 2024-03 (batch Postgres reports), v1.5 launched 2024-09 (added Kafka ingestion, kept Postgres), v2.0-beta started 2025-01 (ClickHouse migration, real-time dashboard). Current production is v1.5.12. ClickHouse cluster version is 24.3 LTS.",
      content_type: "note",
      importance: 0.6,
      tags: ["nexara", "versions", "history"],
      relevant_to: ["factual_2"],
    },
    {
      content:
        "Nexara authentication configuration: OAuth2 with Auth0 as IdP, JWT tokens with RS256 signing, access token TTL 15 minutes, refresh token TTL 7 days. API rate limit: 1000 req/min per tenant (burst: 2000). RBAC with 4 roles: viewer, analyst, admin, super-admin. MFA required for admin and super-admin roles.",
      content_type: "note",
      importance: 0.7,
      tags: ["nexara", "auth", "security"],
      relevant_to: ["factual_3"],
    },
    {
      content:
        "Nexara ClickHouse cluster sizing: 3 shards, 2 replicas each (6 nodes total). Each node: 32 vCPU, 128GB RAM, 2TB NVMe SSD. Total cluster storage: 12TB raw, ~4TB after compression (3:1 ratio). Current data volume: 2.1TB compressed. Daily ingestion rate: ~15GB compressed.",
      content_type: "note",
      importance: 0.6,
      tags: ["nexara", "clickhouse", "infrastructure"],
      relevant_to: ["factual_4"],
    },
    {
      content:
        "Nexara API rate limiting implementation: Token bucket algorithm with Redis backend. Default: 1000 req/min per tenant. Enterprise tier: 5000 req/min. Burst allowance: 2x sustained rate for 10 seconds. Rate limit headers: X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset. 429 responses include Retry-After header.",
      content_type: "note",
      importance: 0.5,
      tags: ["nexara", "api", "rate-limiting"],
      relevant_to: ["factual_5"],
    },
    {
      content:
        "Nexara deployment pipeline: GitHub Actions CI/CD. Build → unit tests → integration tests (Testcontainers) → staging deploy → smoke tests → canary (10% traffic for 30 min) → full production rollout. Rollback: automated on error rate >1% or p99 latency >500ms. Deploy frequency: ~3 times/week.",
      content_type: "note",
      importance: 0.5,
      tags: ["nexara", "deployment", "ci-cd"],
      relevant_to: ["factual_6"],
    },

    // === DECISION CONTINUITY (5 memories) ===
    {
      content:
        "Decision: Chose ClickHouse over TimescaleDB for Nexara analytics (2024-11). Rationale: 10x faster aggregation queries on wide tables, columnar storage reduces scan time for dashboard queries, native support for materialized views with automatic refresh. TimescaleDB was strong on time-series but Nexara needs ad-hoc dimensional analysis, not just time-series. Tradeoff: ClickHouse has weaker transactional guarantees, mitigated by keeping Postgres for metadata/config.",
      content_type: "text",
      importance: 0.8,
      tags: ["nexara", "decision", "clickhouse", "architecture"],
      relevant_to: ["decision_1"],
    },
    {
      content:
        "Decision: Adopted Kafka over RabbitMQ for event streaming (2024-08). Rationale: Nexara needs replay capability for reprocessing historical events when schema evolves, Kafka's log-based architecture preserves event ordering per partition, and consumer groups allow independent read positions for different services. RabbitMQ was simpler but lacks replay and has lower throughput at our scale (50k events/sec target).",
      content_type: "text",
      importance: 0.8,
      tags: ["nexara", "decision", "kafka", "architecture"],
      relevant_to: ["decision_2"],
    },
    {
      content:
        "Decision: Kept Postgres for metadata despite ClickHouse migration (2025-01). Rationale: user accounts, permissions, tenant config, and billing data need ACID transactions and complex joins. ClickHouse is append-optimized and lacks UPDATE/DELETE efficiency. The DataVault pattern separates hot analytics data (ClickHouse) from warm operational data (Postgres). Syncing happens via CDC with Debezium.",
      content_type: "text",
      importance: 0.7,
      tags: ["nexara", "decision", "postgres", "data-vault"],
      relevant_to: ["decision_3"],
    },
    {
      content:
        "Decision: Selected RS256 over HS256 for JWT signing (2024-06). Rationale: RS256 allows public key verification without sharing secrets — critical for Nexara's multi-service architecture where 8 microservices need to verify tokens independently. HS256 would require distributing the shared secret to every service, increasing attack surface. Performance overhead of RS256 is negligible with key caching.",
      content_type: "text",
      importance: 0.6,
      tags: ["nexara", "decision", "auth", "security"],
      relevant_to: ["decision_4"],
    },
    {
      content:
        "Decision: Rejected GraphQL in favor of REST for Nexara public API (2024-07). Rationale: analytics queries return large tabular datasets poorly suited to GraphQL's nested object model. REST with streaming JSON (NDJSON) gives better performance for bulk data export. Internal services use gRPC for low-latency inter-service calls. GraphQL would add complexity without clear benefit for our data-heavy use case.",
      content_type: "text",
      importance: 0.6,
      tags: ["nexara", "decision", "api", "architecture"],
      relevant_to: ["decision_5"],
    },

    // === CONTEXT AWARENESS (5 memories) ===
    {
      content:
        "Nexara v2.0 dashboard sprint 4 status (2025-02-15): Query layer 80% complete — 12 of 15 dashboard widgets migrated from Postgres to ClickHouse. Remaining: funnel analysis widget (complex multi-step query), retention cohort widget, and custom SQL editor. Blocker: ClickHouse doesn't support window functions with RANGE BETWEEN for the retention calculation — evaluating workaround with array functions.",
      content_type: "note",
      importance: 0.7,
      tags: ["nexara", "status", "dashboard", "sprint"],
      relevant_to: ["context_1"],
    },
    {
      content:
        "Nexara production incident 2025-02-10: Kafka consumer lag spiked to 2M messages (normal: <10k). Root cause: ClickHouse MergeTree compaction running during peak hours consumed all disk I/O. Fix: scheduled compaction to 2-4 AM UTC, added disk I/O monitoring alert. Impact: ~45 min of delayed dashboard updates, no data loss. Post-mortem action: implement backpressure signaling from ClickHouse to Kafka consumers.",
      content_type: "text",
      importance: 0.8,
      tags: ["nexara", "incident", "kafka", "clickhouse"],
      relevant_to: ["context_2"],
    },
    {
      content:
        "Nexara team capacity planning (2025-02): 4 backend engineers, 2 frontend engineers, 1 SRE, 1 data engineer. The data engineer (role filled 2025-01) is ramping up on ClickHouse schema design. Frontend team is blocked waiting for query layer API contracts — estimated unblock by sprint 5 (2025-03-01). Hiring: approved headcount for 1 additional SRE, interviews in progress.",
      content_type: "note",
      importance: 0.5,
      tags: ["nexara", "team", "planning"],
      relevant_to: ["context_3"],
    },
    {
      content:
        "Nexara cost analysis (2025-02): Current monthly AWS bill $47,200. Breakdown: EKS compute $18,500, ClickHouse nodes $15,800, Kafka MSK $6,200, RDS Postgres $3,100, S3/networking $3,600. Projected v2.0 steady-state: $52,000/month (+10%). Cost optimization target: reduce to $37,000/month (-30% from projected) by right-sizing ClickHouse replicas and using spot instances for non-critical workloads.",
      content_type: "note",
      importance: 0.6,
      tags: ["nexara", "cost", "infrastructure"],
      relevant_to: ["context_4"],
    },
    {
      content:
        "Nexara customer feedback summary (2025-02): Top 3 requests: (1) Real-time dashboard refresh <5 sec (currently 15 min batch), (2) Custom SQL query builder for power users, (3) Slack/Teams alert integration for threshold breaches. Enterprise customers (Acme Corp, Globex) threatening churn if real-time isn't delivered by Q2 2025. 2 new enterprise leads conditional on v2.0 GA.",
      content_type: "summary",
      importance: 0.7,
      tags: ["nexara", "feedback", "customers"],
      relevant_to: ["context_5"],
    },

    // === CROSS-REFERENCE (6 memories) ===
    {
      content:
        "Nexara DataVault architecture: Three layers — (1) Raw Vault: immutable event log in Kafka topics (retained 30 days), (2) Business Vault: cleaned/enriched data in ClickHouse materialized views, (3) Operational Vault: user/tenant/config data in Postgres. Data flows: Kafka → ClickHouse (streaming insert via Kafka Engine), Postgres → ClickHouse (CDC via Debezium for dimension tables). The DataVault pattern ensures each layer can evolve independently.",
      content_type: "text",
      importance: 0.7,
      tags: ["nexara", "data-vault", "architecture"],
      relevant_to: ["cross_1"],
    },
    {
      content:
        "Nexara ClickHouse table design: Primary analytics table `events` uses ReplacingMergeTree ordered by (tenant_id, event_time, event_id). Dimension tables (users, products, campaigns) synced from Postgres via Debezium → Kafka → ClickHouse Dictionary. Materialized views: `mv_hourly_aggregates` (pre-aggregated metrics), `mv_funnel_steps` (conversion funnels), `mv_retention_daily` (daily active cohorts).",
      content_type: "note",
      importance: 0.6,
      tags: ["nexara", "clickhouse", "schema"],
      relevant_to: ["cross_2"],
    },
    {
      content:
        "Nexara Kafka topic design: 6 topics — `nexara.events.raw` (main event stream, 12 partitions, partitioned by tenant_id), `nexara.events.enriched` (post-processing, 12 partitions), `nexara.cdc.postgres` (Debezium CDC from Postgres), `nexara.alerts` (threshold breach notifications), `nexara.dlq` (dead letter queue for failed processing), `nexara.audit` (system audit log). Retention: raw 30 days, enriched 7 days, CDC 3 days.",
      content_type: "note",
      importance: 0.6,
      tags: ["nexara", "kafka", "schema"],
      relevant_to: ["cross_3"],
    },
    {
      content:
        "Nexara service dependency map: API Gateway → Auth Service (JWT validation) → Analytics Service (query execution on ClickHouse) → Cache Layer (Redis, 60-sec TTL for dashboard queries). Ingestion path: Client SDK → API Gateway → Kafka Producer → Kafka → ClickHouse Kafka Engine (streaming insert). Dimension sync: Postgres → Debezium → Kafka CDC topic → ClickHouse Dictionary reload (every 5 min).",
      content_type: "note",
      importance: 0.6,
      tags: ["nexara", "architecture", "dependencies"],
      relevant_to: ["cross_4"],
    },
    {
      content:
        "Nexara monitoring stack: Prometheus + Grafana for infrastructure metrics, Jaeger for distributed tracing, PagerDuty for alerting. Key SLOs: API p99 latency <200ms, dashboard query p99 <2sec, event ingestion lag <30sec, uptime 99.9%. Current status: API p99 at 180ms (meeting SLO), dashboard query p99 at 3.5sec (NOT meeting SLO — ClickHouse query optimization in progress).",
      content_type: "note",
      importance: 0.6,
      tags: ["nexara", "monitoring", "slo"],
      relevant_to: ["cross_5"],
    },
    {
      content:
        "Nexara Redis cache strategy: Two Redis instances — (1) session cache (port 6380, 256MB, LRU eviction) for JWT session data and rate limit counters, (2) query cache (port 6381, 1GB, TTL-based) for dashboard query results. Cache key pattern: `nexara:{tenant_id}:{query_hash}`. TTL: 60 sec for real-time widgets, 300 sec for historical charts. Cache hit rate: ~72% on dashboards (target: 85%).",
      content_type: "note",
      importance: 0.5,
      tags: ["nexara", "redis", "cache"],
      relevant_to: ["cross_6"],
    },

    // === TECHNIQUE APPLICATION (5 memories) ===
    {
      content:
        "Technique: ClickHouse query optimization for Nexara dashboards — use PREWHERE instead of WHERE for selective filters on large tables (reduces data read by skipping granules early). For time-range queries, always put the date column first in PREWHERE to leverage the MergeTree primary key index. Tested: PREWHERE reduced p99 from 4.2s to 1.8s on the hourly aggregates dashboard.",
      content_type: "text",
      importance: 0.7,
      tags: ["nexara", "technique", "clickhouse", "optimization"],
      relevant_to: ["technique_1"],
    },
    {
      content:
        "Technique: Kafka consumer rebalancing storms — when deploying new Nexara consumer versions, use cooperative-sticky assignor instead of default range assignor. This prevents full stop-the-world rebalances. Combined with incremental deployment (rolling restart, 1 consumer at a time with 30s delay), rebalance impact dropped from 45s full pause to <2s per consumer switchover.",
      content_type: "text",
      importance: 0.6,
      tags: ["nexara", "technique", "kafka", "deployment"],
      relevant_to: ["technique_2"],
    },
    {
      content:
        "Technique: Debugging ClickHouse memory issues — when queries fail with MEMORY_LIMIT_EXCEEDED, check system.query_log for peak_memory_usage. Common fixes: (1) add LIMIT early in subqueries, (2) use GROUP BY with memory-efficient algorithms (e.g., groupArray with maxSize), (3) increase max_memory_usage_for_user setting temporarily for complex analytical queries. For Nexara, the funnel analysis query needed approach #2 — groupArray was unbounded.",
      content_type: "text",
      importance: 0.6,
      tags: ["nexara", "technique", "clickhouse", "debugging"],
      relevant_to: ["technique_3"],
    },
    {
      content:
        "Technique: Zero-downtime schema migration in ClickHouse — unlike Postgres, ClickHouse ALTER TABLE is lightweight and non-blocking for adding columns. But renaming or changing column types requires creating a new table and using INSERT INTO ... SELECT. For Nexara, we add new columns with DEFAULT expressions, backfill asynchronously with ALTER TABLE UPDATE (mutation), then update materialized views. Mutations run in background and don't block inserts.",
      content_type: "text",
      importance: 0.6,
      tags: ["nexara", "technique", "clickhouse", "migration"],
      relevant_to: ["technique_4"],
    },
    {
      content:
        "Technique: Reducing Kafka end-to-end latency for Nexara real-time pipeline — key settings: linger.ms=5 (batch for 5ms max), batch.size=65536, compression.type=lz4 (faster than gzip, better than none for network). On consumer side: fetch.min.bytes=1, max.poll.records=500. Combined effect: e2e latency from producer send to ClickHouse insert dropped from 800ms to 120ms average.",
      content_type: "text",
      importance: 0.6,
      tags: ["nexara", "technique", "kafka", "performance"],
      relevant_to: ["technique_5"],
    },
  ],

  questions: [
    // === FACTUAL RECALL ===
    {
      id: "factual_1",
      category: "factual_recall",
      question: "What port does the Nexara ClickHouse cluster use for native TLS connections?",
      required_facts: ["9440", "native TLS"],
      forbidden_facts: ["9000", "default ClickHouse port"],
      ground_truth: "The Nexara ClickHouse cluster uses port 9440 for native TLS connections, and port 8443 for HTTP connections.",
    },
    {
      id: "factual_2",
      category: "factual_recall",
      question: "What version of ClickHouse is Nexara running and when did the v2.0-beta start?",
      required_facts: ["24.3 LTS", "2025-01"],
      forbidden_facts: ["24.1", "24.2", "2024-12"],
      ground_truth: "Nexara runs ClickHouse 24.3 LTS. The v2.0-beta (ClickHouse migration and real-time dashboard) started in January 2025.",
    },
    {
      id: "factual_3",
      category: "factual_recall",
      question: "What JWT signing algorithm does Nexara use and what are the token TTLs?",
      required_facts: ["RS256", "15 minutes", "7 days"],
      forbidden_facts: ["HS256", "HS384", "1 hour", "30 days"],
      ground_truth: "Nexara uses RS256 for JWT signing. Access tokens have a 15-minute TTL, refresh tokens have a 7-day TTL.",
    },

    // === DECISION CONTINUITY ===
    {
      id: "decision_1",
      category: "decision_continuity",
      question: "Why did Nexara choose ClickHouse over TimescaleDB for analytics?",
      required_facts: ["10x faster aggregation", "columnar storage", "materialized views", "ad-hoc dimensional analysis"],
      forbidden_facts: ["TimescaleDB was too expensive", "TimescaleDB lacks features"],
      ground_truth: "ClickHouse was chosen over TimescaleDB for 10x faster aggregation on wide tables, columnar storage for efficient dashboard scans, native materialized view support, and because Nexara needs ad-hoc dimensional analysis rather than pure time-series. TimescaleDB was strong on time-series but not the right fit.",
    },
    {
      id: "decision_2",
      category: "decision_continuity",
      question: "Should we consider switching from Kafka to RabbitMQ for simpler operations?",
      required_facts: ["replay capability", "event ordering", "50k events/sec"],
      forbidden_facts: ["RabbitMQ is better", "Kafka is overkill"],
      ground_truth: "Kafka was deliberately chosen over RabbitMQ because Nexara needs replay capability for reprocessing when schemas evolve, guaranteed event ordering per partition, and throughput to handle 50k events/sec. RabbitMQ lacks replay and can't handle this throughput.",
    },
    {
      id: "decision_3",
      category: "decision_continuity",
      question: "Why does Nexara still use Postgres alongside ClickHouse?",
      required_facts: ["ACID transactions", "user accounts", "DataVault pattern", "Debezium"],
      forbidden_facts: ["planning to remove Postgres", "Postgres is temporary"],
      ground_truth: "Postgres is kept for operational data (user accounts, permissions, tenant config, billing) that needs ACID transactions and complex joins. ClickHouse is append-optimized and lacks efficient UPDATE/DELETE. The DataVault pattern separates hot analytics data (ClickHouse) from warm operational data (Postgres), synced via CDC with Debezium.",
    },

    // === CONTEXT AWARENESS ===
    {
      id: "context_1",
      category: "context_awareness",
      question: "What is the current status of the Nexara v2.0 dashboard migration?",
      required_facts: ["12 of 15 widgets", "80%", "funnel analysis", "retention cohort"],
      forbidden_facts: ["migration is complete", "all widgets done"],
      ground_truth: "The query layer is 80% complete with 12 of 15 dashboard widgets migrated from Postgres to ClickHouse. Remaining: funnel analysis widget, retention cohort widget, and custom SQL editor. Blocker: ClickHouse window function limitation for retention calculation.",
    },
    {
      id: "context_2",
      category: "context_awareness",
      question: "What was the most recent production incident and what was done about it?",
      required_facts: ["Kafka consumer lag", "2M messages", "MergeTree compaction", "2-4 AM"],
      forbidden_facts: ["data loss", "still unresolved"],
      ground_truth: "On 2025-02-10, Kafka consumer lag spiked to 2M messages because ClickHouse MergeTree compaction consumed all disk I/O during peak hours. Fix: scheduled compaction to 2-4 AM UTC, added monitoring. 45 min of delayed updates, no data loss. Pending: implement backpressure signaling.",
    },
    {
      id: "context_3",
      category: "context_awareness",
      question: "What are the biggest risks to delivering Nexara v2.0 on time?",
      required_facts: ["frontend team blocked", "sprint 5", "enterprise customers", "Q2 2025"],
      forbidden_facts: ["no risks", "on track for early delivery"],
      ground_truth: "Key risks: Frontend team is blocked waiting for query layer API contracts (estimated unblock sprint 5, 2025-03-01). Enterprise customers (Acme Corp, Globex) threatening churn if real-time isn't delivered by Q2 2025. Dashboard query p99 is 3.5s, not meeting the 2s SLO yet.",
    },

    // === CROSS-REFERENCE ===
    {
      id: "cross_1",
      category: "cross_reference",
      question: "Trace the data flow from a client event to appearing on the Nexara dashboard.",
      required_facts: ["Client SDK", "API Gateway", "Kafka", "ClickHouse Kafka Engine", "Redis cache", "60-sec TTL"],
      forbidden_facts: ["direct database insert", "batch processing"],
      ground_truth: "Client SDK → API Gateway → Kafka Producer → Kafka (nexara.events.raw topic) → ClickHouse Kafka Engine (streaming insert) → materialized views aggregate → dashboard query hits Analytics Service → Redis cache (60-sec TTL) → displayed to user.",
    },
    {
      id: "cross_2",
      category: "cross_reference",
      question: "How do Postgres dimension tables get into ClickHouse for dashboard joins?",
      required_facts: ["Debezium", "CDC", "Kafka CDC topic", "Dictionary", "5 min"],
      forbidden_facts: ["direct replication", "manual sync", "ETL batch job"],
      ground_truth: "Postgres → Debezium (CDC) → Kafka CDC topic (nexara.cdc.postgres) → ClickHouse Dictionary reload (every 5 minutes). This keeps dimension tables (users, products, campaigns) in sync for joins in dashboard queries.",
    },
    {
      id: "cross_3",
      category: "cross_reference",
      question: "What caching layers exist between ClickHouse and the end user, and what are their configs?",
      required_facts: ["Redis query cache", "port 6381", "60 sec", "300 sec", "72% hit rate"],
      forbidden_facts: ["no caching", "Memcached"],
      ground_truth: "Redis query cache on port 6381 (1GB, TTL-based). TTL: 60 sec for real-time widgets, 300 sec for historical charts. Cache key: nexara:{tenant_id}:{query_hash}. Current hit rate: 72% (target 85%). There's also a session cache on port 6380 for JWT/rate limit data.",
    },

    // === TECHNIQUE APPLICATION ===
    {
      id: "technique_1",
      category: "technique_application",
      question: "The Nexara dashboard queries are slow (p99 >4s). What optimization technique should we apply?",
      required_facts: ["PREWHERE", "date column first", "skip granules", "1.8s"],
      forbidden_facts: ["add more replicas", "increase memory"],
      ground_truth: "Use PREWHERE instead of WHERE for selective filters — it skips granules early, reducing data read. Put the date column first in PREWHERE to leverage MergeTree primary key index. This technique reduced p99 from 4.2s to 1.8s on hourly aggregates.",
    },
    {
      id: "technique_2",
      category: "technique_application",
      question: "We're seeing long pauses during Kafka consumer deployments. How do we fix this?",
      required_facts: ["cooperative-sticky", "rolling restart", "30s delay", "<2s"],
      forbidden_facts: ["stop all consumers", "increase timeout"],
      ground_truth: "Switch to cooperative-sticky assignor instead of default range assignor. Combine with incremental deployment (rolling restart, 1 consumer at a time, 30s delay). This reduces rebalance impact from 45s full pause to <2s per consumer switchover.",
    },
    {
      id: "technique_3",
      category: "technique_application",
      question: "A ClickHouse query is failing with MEMORY_LIMIT_EXCEEDED. How should we debug and fix it?",
      required_facts: ["system.query_log", "peak_memory_usage", "groupArray with maxSize", "LIMIT in subqueries"],
      forbidden_facts: ["restart the server", "increase cluster size"],
      ground_truth: "Check system.query_log for peak_memory_usage. Common fixes: (1) add LIMIT early in subqueries, (2) use groupArray with maxSize to bound memory, (3) temporarily increase max_memory_usage_for_user. For Nexara's funnel analysis, the issue was unbounded groupArray.",
    },
  ],
};
