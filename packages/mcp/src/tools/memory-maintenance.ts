import { z } from "zod";
import { MemoryStore, MemorySearch, MemoryLinkStore, EntityStore, getEmbeddingProvider, getArchiveCandidates, archiveStaleMemories, adjustImportance, findClusters, consolidateCluster, generateBasicSummary, validateSummary, autoConsolidate, applyCommunityAwareFiltering, runHealthChecks, getSearchMisses, reembedMissing, reembedAll, backfillEntities, recalibrateImportance, tuneWeights, getMemoryLineage, getDecisionTimeline, densifyEntityGraph, buildCoRetrievalLinks, suggestTagMerges, applyTagMerge, getSetting, getQualityDistribution, recomputeEntityProfiles, recomputeQualityScores, promoteMemoryTiers } from "@exocortex/core";
import type { ToolRegistrationContext } from "./types.js";

export function registerMemoryMaintenanceTools(ctx: ToolRegistrationContext): void {
  const { server, db, startTime } = ctx;

  // memory_decay_preview
  server.tool(
    "memory_decay_preview",
    "Preview which memories would be archived by the decay process. Dry-run only, no changes made.",
    {},
    async () => {
      try {
        const candidates = getArchiveCandidates(db);

        if (candidates.length === 0) {
          return { content: [{ type: "text", text: "No archive candidates found. All memories are healthy." }] };
        }

        const lines = candidates.map((c) => {
          const preview = c.content.substring(0, 80) + (c.content.length > 80 ? "..." : "");
          return `- [${c.id}] ${preview} (reason: ${c.reason}, importance: ${c.importance}, accesses: ${c.access_count}, created: ${c.created_at})`;
        });

        return {
          content: [{ type: "text", text: `Archive candidates (${candidates.length}, dry-run):\n\n${lines.join("\n")}` }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // memory_consolidate
  server.tool(
    "memory_consolidate",
    "Find clusters of similar memories and consolidate them into summaries. When consolidating (dry_run: false), provide a 'summary' you wrote — otherwise a basic auto-summary is used as fallback.",
    {
      dry_run: z.boolean().optional().describe("Preview clusters without consolidating (default true — safe preview mode)"),
      min_similarity: z.number().min(0).max(1).optional().describe("Minimum cosine similarity for clustering (default 0.75)"),
      min_cluster_size: z.number().min(2).optional().describe("Minimum cluster size (default 3)"),
      time_bucket: z.enum(["week", "month"]).optional().describe("Constrain clustering to same time window (week or month)"),
      community_aware: z.boolean().optional().describe("Use entity graph communities to split clusters at community boundaries and protect bridge memories (default false)"),
      cluster_index: z.number().min(0).optional().describe("When consolidating, only process this cluster (0-indexed from dry_run results). Required when providing a summary."),
      summary: z.string().optional().describe("Your synthesized summary for the cluster. Must preserve dates, versions, proper nouns, and file paths from originals. If omitted, a basic auto-summary is generated."),
    },
    async (args) => {
      try {
        // Always find raw clusters first (without community filtering)
        const rawClusters = findClusters(db, {
          minSimilarity: args.min_similarity,
          minClusterSize: args.min_cluster_size,
          timeBucket: args.time_bucket,
        });

        if (rawClusters.length === 0) {
          return { content: [{ type: "text", text: "No clusters found eligible for consolidation." }] };
        }

        // Apply community-aware filtering if requested, falling back to raw if it eliminates everything
        let clusters = rawClusters;
        let caResult: ReturnType<typeof applyCommunityAwareFiltering> | undefined;
        if (args.community_aware) {
          caResult = applyCommunityAwareFiltering(db, rawClusters, args.min_cluster_size ?? 2);
          if (caResult.clusters.length > 0) {
            clusters = caResult.clusters;
          }
          // If community filtering eliminated all clusters, fall back to raw clusters
        }

        if (args.dry_run !== false) {
          // If community-aware, report bridge/split info in the dry-run output
          let bridgeInfo = "";
          if (args.community_aware && caResult) {
            bridgeInfo = `\n\nCommunity-aware: ${caResult.clustersSplit} cluster(s) split at community boundaries, ${caResult.bridgeMemoryIds.length} bridge memory(ies) protected (importance boosted to 0.8+)`;
            if (caResult.clusters.length === 0) {
              bridgeInfo += ` — all sub-clusters fell below minClusterSize, using ${rawClusters.length} raw clusters`;
            }
          }

          const lines = clusters.map((c, i) => {
            return `${i + 1}. [${i}] "${c.topic}" — ${c.memberIds.length} memories (${c.memberIds.join(", ")}), avg similarity: ${c.avgSimilarity.toFixed(2)}`;
          });
          return {
            content: [{
              type: "text",
              text: `Found ${clusters.length} clusters (dry run):\n\n${lines.join("\n")}${bridgeInfo}\n\nTo consolidate: call with dry_run: false, cluster_index: N, and summary: "your synthesis". Or omit summary for auto-generated fallback.`,
            }],
          };
        }

        let embeddingProvider;
        try {
          embeddingProvider = await getEmbeddingProvider();
        } catch {
          // Proceed without embedding
        }

        // Determine which clusters to process
        const toProcess = args.cluster_index !== undefined
          ? [clusters[args.cluster_index]].filter(Boolean)
          : clusters;

        if (toProcess.length === 0) {
          return { content: [{ type: "text", text: `Invalid cluster_index: ${args.cluster_index} (${clusters.length} clusters available)` }], isError: true };
        }

        const results: string[] = [];
        const skipped: string[] = [];
        for (let i = 0; i < toProcess.length; i++) {
          const cluster = toProcess[i];

          // Use agent-provided summary for targeted consolidation, auto-generate for batch
          const summaryContent = (args.summary && toProcess.length === 1)
            ? args.summary
            : generateBasicSummary(db, cluster.memberIds);

          if (!summaryContent) {
            skipped.push(`Cluster "${cluster.topic}": empty summary`);
            continue;
          }

          // Validate summary quality
          const sourceContents = db
            .prepare(
              `SELECT content FROM memories WHERE id IN (${cluster.memberIds.map(() => "?").join(",")})`
            )
            .all(...cluster.memberIds) as Array<{ content: string }>;
          const validation = validateSummary(summaryContent, sourceContents.map((r) => r.content));
          if (!validation.valid) {
            skipped.push(`Cluster "${cluster.topic}": ${validation.reasons.join("; ")}`);
            continue;
          }

          const summaryId = await consolidateCluster(db, cluster, summaryContent, embeddingProvider);
          results.push(`Consolidated ${cluster.memberIds.length} memories → ${summaryId} ("${cluster.topic}")`);
        }

        let text = results.length > 0
          ? `Consolidated ${results.length} cluster(s):\n\n${results.join("\n")}`
          : "No clusters consolidated.";
        if (skipped.length > 0) {
          text += `\n\nSkipped ${skipped.length} cluster(s) (failed quality validation):\n${skipped.join("\n")}`;
        }

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // memory_maintenance
  server.tool(
    "memory_maintenance",
    "Run maintenance: adjust importance scores based on access patterns and archive stale memories.",
    {
      reembed: z.boolean().optional().describe("Re-embed memories with missing embeddings"),
      backfill_entities: z.boolean().optional().describe("Process memories without entity links and extract relationships"),
      recalibrate: z.boolean().optional().describe("Normalize importance distribution via percentile-rank mapping"),
      densify_graph: z.boolean().optional().describe("Create co_occurs relationships between entities sharing memories"),
      build_co_retrieval_links: z.boolean().optional().describe("Build memory links from co-retrieval patterns"),
      tune_weights: z.boolean().optional().describe("Auto-adjust scoring weights based on usefulness feedback data"),
      reembed_all: z.boolean().optional().describe("Re-embed ALL memories (model migration). Use with limit to test first."),
      reembed_all_limit: z.number().optional().describe("Max memories to re-embed when using reembed_all (default 100)"),
      recompute_profiles: z.boolean().optional().describe("Recompute entity profiles for entities with ≥3 active memories"),
      recompute_quality: z.boolean().optional().describe("Recompute quality_score for all active memories"),
      auto_consolidate: z.boolean().optional().describe("Run auto-consolidation to merge similar memory clusters"),
      promote_tiers: z.boolean().optional().describe("Auto-promote memories between tiers (episodic→semantic if useful, episodic→procedural if technique-tagged, working→episodic if accessed)"),
    },
    async (args) => {
      try {
        const importanceResult = adjustImportance(db);
        const archiveResult = archiveStaleMemories(db);

        const parts: string[] = [];

        parts.push(`Importance adjustments: ${importanceResult.boosted} boosted, ${importanceResult.decayed} decayed`);
        if (importanceResult.details.length > 0) {
          const details = importanceResult.details.slice(0, 10).map(
            (d) => `  ${d.id}: ${d.action} ${d.old_importance} → ${d.new_importance}`
          );
          parts.push(details.join("\n"));
          if (importanceResult.details.length > 10) {
            parts.push(`  ... and ${importanceResult.details.length - 10} more`);
          }
        }

        parts.push(`\nArchival: ${archiveResult.archived} memories archived`);
        if (archiveResult.candidates.length > 0) {
          const details = archiveResult.candidates.slice(0, 10).map((c) => {
            const preview = c.content.substring(0, 60) + (c.content.length > 60 ? "..." : "");
            return `  ${c.id}: "${preview}" (${c.reason})`;
          });
          parts.push(details.join("\n"));
          if (archiveResult.candidates.length > 10) {
            parts.push(`  ... and ${archiveResult.candidates.length - 10} more`);
          }
        }

        try {
          const clusters = findClusters(db);
          if (clusters.length > 0) {
            parts.push(`\nConsolidation: Found ${clusters.length} cluster(s) eligible for consolidation (run memory_consolidate to merge)`);
          }
        } catch {
          // Non-critical
        }

        try {
          const health = runHealthChecks(db);
          const issues = health.checks.filter((c) => c.status !== "ok");
          if (issues.length > 0) {
            parts.push(`\nHealth: ${health.overall.toUpperCase()} (${issues.length} issue(s))`);
            const suggestions: Record<string, string> = {
              "Embedding gap": "Re-store or update memories to trigger embedding generation",
              "Tag sparsity": "Add tags to memories using memory_update, or enable auto_tagging",
              "Entity orphans": "Clean up unused entities or link them to memories",
              "Retrieval desert": "Use memory_search more actively to surface stored knowledge",
              "Importance collapse": "Manually boost key memories with memory_update importance:0.7+",
              "Consolidation backlog": "Run memory_consolidate dry_run:false to merge similar memories",
              "Growth stall": "Store new memories — the system works best with regular input",
              "Stale access": "Query your memories more often to keep the system active",
            };
            for (const check of issues) {
              const icon = check.status === "warn" ? "[!]" : "[!!]";
              parts.push(`  ${icon} ${check.name}: ${check.message}`);
              const suggestion = suggestions[check.name];
              if (suggestion) {
                parts.push(`      → ${suggestion}`);
              }
            }
          } else {
            parts.push(`\nHealth: OK — all checks passed`);
          }
        } catch {
          // Non-critical
        }

        try {
          const qd = getQualityDistribution(db);
          parts.push(`\nQuality distribution (${qd.total} memories): avg=${qd.avg}, median=${qd.median}, P10=${qd.p10}, P90=${qd.p90}, high(≥0.5)=${qd.highQuality}, low(<0.2)=${qd.lowQuality}`);
        } catch {
          // Non-critical
        }

        try {
          const misses = getSearchMisses(db, 10, 7);
          if (misses.length > 0) {
            parts.push(`\nSearch friction (last 7 days):`);
            for (const m of misses) {
              const scoreStr = m.avg_max_score !== null ? `, avg max score: ${m.avg_max_score.toFixed(3)}` : "";
              parts.push(`  "${m.query}" — ${m.count} miss(es)${scoreStr}, last: ${m.last_seen}`);
            }
          }
        } catch {
          // Non-critical
        }

        if (args.reembed) {
          try {
            const provider = await getEmbeddingProvider();
            const reembedResult = await reembedMissing(db, provider);
            parts.push(`\nRe-embedding: ${reembedResult.processed} processed, ${reembedResult.failed} failed`);
          } catch (err) {
            parts.push(`\nRe-embedding: error — ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (args.backfill_entities) {
          try {
            const backfillResult = backfillEntities(db);
            parts.push(`\nEntity backfill: ${backfillResult.memoriesProcessed} memories processed, ${backfillResult.entitiesCreated} entities created, ${backfillResult.entitiesLinked} links, ${backfillResult.relationshipsCreated} relationships`);
          } catch (err) {
            parts.push(`\nEntity backfill: error — ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (args.recalibrate) {
          try {
            const recalResult = recalibrateImportance(db);
            parts.push(`\nRecalibration: ${recalResult.adjusted} adjusted, mean ${recalResult.oldMean} → ${recalResult.newMean}, stddev ${recalResult.oldStdDev} → ${recalResult.newStdDev}`);
            parts.push(`  Distribution: min=${recalResult.distribution.min}, p25=${recalResult.distribution.p25}, median=${recalResult.distribution.median}, p75=${recalResult.distribution.p75}, max=${recalResult.distribution.max}`);
          } catch (err) {
            parts.push(`\nRecalibration: error — ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (args.densify_graph) {
          try {
            const densifyResult = densifyEntityGraph(db);
            parts.push(`\nGraph densification: ${densifyResult.pairsAnalyzed} pairs analyzed, ${densifyResult.relationshipsCreated} relationships created`);
          } catch (err) {
            parts.push(`\nGraph densification: error — ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (args.build_co_retrieval_links) {
          try {
            const coRetResult = buildCoRetrievalLinks(db);
            parts.push(`\nCo-retrieval links: ${coRetResult.pairsAnalyzed} pairs analyzed, ${coRetResult.linksCreated} created, ${coRetResult.linksStrengthened} strengthened`);
          } catch (err) {
            parts.push(`\nCo-retrieval links: error — ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (args.tune_weights) {
          try {
            const tuneResult = tuneWeights(db);
            if (tuneResult.adjusted) {
              const adj = Object.entries(tuneResult.adjustments)
                .map(([k, v]) => `${k}: ${v.old} → ${v.new}`)
                .join(", ");
              parts.push(`\nWeight tuning: adjusted (${tuneResult.usefulCount} useful, ${tuneResult.notUsefulCount} not useful)\n  ${adj}`);
            } else {
              parts.push(`\nWeight tuning: ${tuneResult.reason}`);
            }
          } catch (err) {
            parts.push(`\nWeight tuning: error — ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (args.reembed_all) {
          try {
            const provider = await getEmbeddingProvider();
            const modelName = getSetting(db, "embedding.model") ?? "unknown";
            const reembedAllResult = await reembedAll(db, provider, {
              limit: args.reembed_all_limit ?? 100,
              modelName,
            });
            parts.push(`\nRe-embed all: ${reembedAllResult.processed} processed, ${reembedAllResult.failed} failed, ${reembedAllResult.total} total`);
          } catch (err) {
            parts.push(`\nRe-embed all: error — ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (args.recompute_profiles) {
          try {
            const profileResult = recomputeEntityProfiles(db);
            parts.push(`\nEntity profiles: ${profileResult.computed} computed, ${profileResult.skipped} skipped${profileResult.errors > 0 ? `, ${profileResult.errors} errors` : ""}`);
          } catch (err) {
            parts.push(`\nEntity profiles: error — ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (args.recompute_quality !== false) {
          try {
            const qualityResult = recomputeQualityScores(db);
            parts.push(`\nQuality scores: ${qualityResult.updated} updated out of ${qualityResult.total} active memories`);
          } catch (err) {
            parts.push(`\nQuality scores: error — ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (args.auto_consolidate) {
          try {
            const provider = await getEmbeddingProvider();
            const consolidateResult = await autoConsolidate(db, provider);
            parts.push(`\nAuto-consolidation: ${consolidateResult.clustersFound} clusters found, ${consolidateResult.clustersConsolidated} consolidated, ${consolidateResult.memoriesMerged} memories merged`);
          } catch (err) {
            parts.push(`\nAuto-consolidation: error — ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (args.promote_tiers) {
          try {
            const tierResult = promoteMemoryTiers(db);
            const total = tierResult.episodicToSemantic + tierResult.episodicToProcedural + tierResult.workingToEpisodic;
            if (total > 0) {
              parts.push(`\nTier promotions: ${total} total (${tierResult.episodicToSemantic} episodic→semantic, ${tierResult.episodicToProcedural} episodic→procedural, ${tierResult.workingToEpisodic} working→episodic)`);
            } else {
              parts.push(`\nTier promotions: no memories eligible for promotion`);
            }
          } catch (err) {
            parts.push(`\nTier promotions: error — ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        try {
          const danglingRows = db.prepare(`
            SELECT e.id, e.name, e.type, COUNT(me.memory_id) as memory_count
            FROM entities e
            LEFT JOIN memory_entities me ON e.id = me.entity_id
            LEFT JOIN memories m ON me.memory_id = m.id AND m.is_active = 1
            GROUP BY e.id
            HAVING COUNT(CASE WHEN m.is_active = 1 THEN 1 END) <= 1
            ORDER BY COUNT(CASE WHEN m.is_active = 1 THEN 1 END) ASC, e.name ASC
            LIMIT 10
          `).all() as unknown as Array<{ id: string; name: string; type: string; memory_count: number }>;

          if (danglingRows.length > 0) {
            parts.push(`\nDangling entities (${danglingRows.length} with 0-1 linked memories):`);
            for (const row of danglingRows) {
              parts.push(`  "${row.name}" [${row.type}] — ${row.memory_count} memory(ies)`);
            }
          }
        } catch {
          // Non-critical
        }

        try {
          const entityStore = new EntityStore(db);
          const pruneResult = entityStore.pruneOrphans(2);
          if (pruneResult.pruned > 0) {
            const nameList = pruneResult.names.slice(0, 10).join(", ");
            const suffix = pruneResult.names.length > 10 ? ` (+${pruneResult.names.length - 10} more)` : "";
            parts.push(`\nPruned ${pruneResult.pruned} orphan entities: ${nameList}${suffix}`);
          }
        } catch {
          // Non-critical
        }

        return { content: [{ type: "text", text: `Maintenance complete:\n\n${parts.join("\n")}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // memory_tag_cleanup
  server.tool(
    "memory_tag_cleanup",
    "Find and merge near-duplicate tags. Preview mode shows suggestions; apply mode merges them.",
    {
      min_similarity: z.number().min(0).max(1).optional().describe("Minimum string similarity for suggestions (default 0.8)"),
      limit: z.number().optional().describe("Max suggestions to return (default 20)"),
      apply: z.boolean().optional().describe("If true, apply the top suggestion or specified from/to pair"),
      from_tag: z.string().optional().describe("Specific tag to merge FROM (use with apply:true)"),
      to_tag: z.string().optional().describe("Specific tag to merge TO (use with apply:true)"),
    },
    async (args) => {
      try {
        if (args.apply) {
          if (args.from_tag && args.to_tag) {
            const result = applyTagMerge(db, args.from_tag, args.to_tag);
            return {
              content: [{
                type: "text",
                text: `Merged tag "${args.from_tag}" → "${args.to_tag}": ${result.updated} memory tag(s) updated. Alias added to settings.`,
              }],
            };
          }

          const suggestions = suggestTagMerges(db, {
            minSimilarity: args.min_similarity,
            limit: 1,
          });
          if (suggestions.length === 0) {
            return { content: [{ type: "text", text: "No merge suggestions found at this similarity threshold." }] };
          }
          const top = suggestions[0];
          const result = applyTagMerge(db, top.from, top.to);
          return {
            content: [{
              type: "text",
              text: `Merged tag "${top.from}" (${top.fromCount}) → "${top.to}" (${top.toCount}): ${result.updated} memory tag(s) updated (similarity: ${top.similarity}).`,
            }],
          };
        }

        const suggestions = suggestTagMerges(db, {
          minSimilarity: args.min_similarity,
          limit: args.limit,
        });

        if (suggestions.length === 0) {
          return { content: [{ type: "text", text: "No near-duplicate tags found at this similarity threshold." }] };
        }

        const lines = [`Found ${suggestions.length} merge suggestion(s):\n`];
        for (const s of suggestions) {
          lines.push(
            `- "${s.from}" (${s.fromCount}) → "${s.to}" (${s.toCount}) — similarity: ${s.similarity}, co-occurrence: ${s.coOccurrence}`
          );
        }
        lines.push(`\nTo merge, call with apply:true or specify from_tag and to_tag.`);

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // memory_timeline
  server.tool(
    "memory_timeline",
    "Query decision history, memory lineage, topic evolution, or temporal hierarchy. Use 'decisions' for decision-tagged memories chronologically, 'lineage' to trace a memory's supersession chain, 'evolution' to see how knowledge about a topic changed over time, or 'hierarchy' to view epoch -> theme -> episode organization.",
    {
      mode: z.enum(["decisions", "lineage", "evolution", "hierarchy"]).describe("'decisions' for decision timeline, 'lineage' for supersession chain, 'evolution' for topic knowledge evolution, 'hierarchy' for epoch/theme/episode tree"),
      memory_id: z.string().optional().describe("Memory ID (required for lineage mode)"),
      topic: z.string().optional().describe("Topic to trace evolution for (required for evolution mode)"),
      month: z.string().optional().describe("Month filter YYYY-MM (for hierarchy mode)"),
      after: z.string().optional().describe("Only after this date (YYYY-MM-DD)"),
      before: z.string().optional().describe("Only before this date (YYYY-MM-DD)"),
      limit: z.number().optional().describe("Max results (default 50)"),
      tags: z.array(z.string()).optional().describe("Additional tag filters (for decisions mode)"),
    },
    async (args) => {
      try {
        if (args.mode === "hierarchy") {
          const { getTemporalHierarchy } = await import("@exocortex/core");
          const hierarchy = getTemporalHierarchy(db, {
            month: args.month,
            after: args.after,
            before: args.before,
            maxEpisodes: args.limit ?? 20,
          });

          if (hierarchy.epochs.length === 0 && hierarchy.orphan_themes.length === 0) {
            return { content: [{ type: "text", text: "No epochs or narratives found for the given time range." }] };
          }

          const lines: string[] = [];
          const range = hierarchy.time_range
            ? `${hierarchy.time_range.start} to ${hierarchy.time_range.end}`
            : "unknown";
          lines.push(`Temporal Hierarchy (${range}):\n`);

          for (const epoch of hierarchy.epochs) {
            const preview = epoch.content.length > 120 ? epoch.content.substring(0, 117) + "..." : epoch.content;
            lines.push(`EPOCH [${epoch.month}] [${epoch.id}] ${preview}`);

            for (const theme of epoch.themes) {
              const tPreview = theme.content.length > 100 ? theme.content.substring(0, 97) + "..." : theme.content;
              const linkIcon = theme.linked ? " ~" : "";
              lines.push(`  THEME [${theme.id}] ${tPreview}${linkIcon}`);

              for (const ep of theme.episodes) {
                const ePreview = ep.content.length > 80 ? ep.content.substring(0, 77) + "..." : ep.content;
                const epLink = ep.linked ? " ~" : "";
                const tagStr = ep.tags.length > 0 ? ` [${ep.tags.slice(0, 3).join(", ")}]` : "";
                lines.push(`    - [${ep.id}] ${ePreview}${tagStr}${epLink} (${ep.importance})`);
              }
            }
            lines.push("");
          }

          if (hierarchy.orphan_themes.length > 0) {
            lines.push("ORPHAN THEMES (no matching epoch):");
            for (const theme of hierarchy.orphan_themes) {
              const tPreview = theme.content.length > 100 ? theme.content.substring(0, 97) + "..." : theme.content;
              lines.push(`  THEME [${theme.id}] ${tPreview}`);
              for (const ep of theme.episodes) {
                const ePreview = ep.content.length > 80 ? ep.content.substring(0, 77) + "..." : ep.content;
                lines.push(`    - [${ep.id}] ${ePreview} (${ep.importance})`);
              }
            }
          }

          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        if (args.mode === "lineage") {
          if (!args.memory_id) {
            return { content: [{ type: "text", text: "memory_id is required for lineage mode." }] };
          }

          const lineage = getMemoryLineage(db, args.memory_id);
          if (lineage.length === 0) {
            return { content: [{ type: "text", text: `Memory ${args.memory_id} not found.` }] };
          }

          const lines = lineage.map((entry) => {
            const marker = entry.direction === "current" ? ">>>" : entry.direction === "predecessor" ? " < " : " > ";
            const preview = entry.content.length > 120 ? entry.content.substring(0, 117) + "..." : entry.content;
            return `${marker} [${entry.id}] ${preview} (importance: ${entry.importance}, ${entry.created_at})`;
          });

          return {
            content: [{ type: "text", text: `Lineage for ${args.memory_id} (${lineage.length} entries):\n\n${lines.join("\n")}` }],
          };
        }

        if (args.mode === "evolution") {
          if (!args.topic) {
            return { content: [{ type: "text", text: "topic is required for evolution mode." }] };
          }

          const search = new MemorySearch(db);
          const results = await search.search({
            query: args.topic,
            limit: args.limit ?? 30,
            after: args.after,
            before: args.before,
          });

          if (results.length === 0) {
            return { content: [{ type: "text", text: `No memories found about "${args.topic}".` }] };
          }

          results.sort((a, b) => a.memory.created_at.localeCompare(b.memory.created_at));

          const linkStore = new MemoryLinkStore(db);
          const lines = results.map((r) => {
            const m = r.memory;
            const preview = m.content.length > 200 ? m.content.substring(0, 197) + "..." : m.content;
            const tagStr = m.tags?.length ? ` [${m.tags.join(", ")}]` : "";

            const supersessionParts: string[] = [];
            const predecessor = db
              .prepare("SELECT id FROM memories WHERE superseded_by = ?")
              .get(m.id) as { id: string } | undefined;
            if (predecessor) supersessionParts.push(`supersedes: ${predecessor.id}`);
            if (m.superseded_by) supersessionParts.push(`superseded_by: ${m.superseded_by}`);

            const memLinks = linkStore.getLinks(m.id);
            const linkParts = memLinks
              .filter((l) => results.some((r2) => r2.memory.id === (l.source_id === m.id ? l.target_id : l.source_id)))
              .slice(0, 3)
              .map((l) => {
                const otherId = l.source_id === m.id ? l.target_id : l.source_id;
                return `${l.link_type}→${otherId.substring(0, 8)}`;
              });

            const metaParts: string[] = [`score: ${r.score.toFixed(3)}`];
            if (supersessionParts.length > 0) metaParts.push(supersessionParts.join(", "));
            if (linkParts.length > 0) metaParts.push(`links: ${linkParts.join(", ")}`);

            return `[${m.created_at}] [${m.id}] ${preview}${tagStr}\n  (${metaParts.join(" | ")})`;
          });

          return {
            content: [{ type: "text", text: `Knowledge evolution for "${args.topic}" (${results.length} memories, chronological):\n\n${lines.join("\n\n")}` }],
          };
        }

        // decisions mode
        const timeline = getDecisionTimeline(db, {
          after: args.after,
          before: args.before,
          limit: args.limit,
          tags: args.tags,
        });

        if (timeline.length === 0) {
          return { content: [{ type: "text", text: "No decision-tagged memories found." }] };
        }

        const lines = timeline.map((entry) => {
          const preview = entry.content.length > 150 ? entry.content.substring(0, 147) + "..." : entry.content;
          const tagStr = entry.tags.length > 0 ? ` [${entry.tags.join(", ")}]` : "";
          const links: string[] = [];
          if (entry.supersedes) links.push(`supersedes: ${entry.supersedes}`);
          if (entry.superseded_by) links.push(`superseded_by: ${entry.superseded_by}`);
          const linkStr = links.length > 0 ? ` (${links.join(", ")})` : "";
          return `- [${entry.id}] ${preview}${tagStr}${linkStr} (${entry.created_at})`;
        });

        return {
          content: [{ type: "text", text: `Decision timeline (${timeline.length} entries):\n\n${lines.join("\n")}` }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // memory_ping
  server.tool(
    "memory_ping",
    "Health check — returns memory counts, entity/tag stats, date range, and server uptime.",
    {},
    async () => {
      try {
        const store = new MemoryStore(db);
        const stats = await store.getStats();
        const uptimeMs = Date.now() - startTime;
        const uptimeSec = Math.floor(uptimeMs / 1000);
        const uptimeMin = Math.floor(uptimeSec / 60);
        const uptimeHr = Math.floor(uptimeMin / 60);

        let uptimeStr: string;
        if (uptimeHr > 0) {
          uptimeStr = `${uptimeHr}h ${uptimeMin % 60}m`;
        } else if (uptimeMin > 0) {
          uptimeStr = `${uptimeMin}m ${uptimeSec % 60}s`;
        } else {
          uptimeStr = `${uptimeSec}s`;
        }

        const lines = [
          `Status: OK`,
          `Memories: ${stats.active_memories} active / ${stats.total_memories} total`,
          `Entities: ${stats.total_entities}`,
          `Tags: ${stats.total_tags}`,
          `Oldest: ${stats.oldest_memory ?? "none"}`,
          `Newest: ${stats.newest_memory ?? "none"}`,
          `Uptime: ${uptimeStr}`,
        ];

        try {
          const health = runHealthChecks(db);
          const statusIcon = { ok: "OK", warn: "WARN", critical: "CRITICAL" };
          lines.push("");
          lines.push(`Health: ${statusIcon[health.overall]}`);
          for (const check of health.checks) {
            const prefix = check.status === "ok" ? "  " : check.status === "warn" ? "  [!] " : "  [!!] ";
            lines.push(`${prefix}${check.name}: ${check.message}`);
          }
        } catch {
          // Non-critical
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );
}
