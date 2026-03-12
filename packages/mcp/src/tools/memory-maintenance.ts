import { z } from "zod";
import { MemoryStore, MemorySearch, MemoryLinkStore, EntityStore, getEmbeddingProvider, getArchiveCandidates, archiveStaleMemories, adjustImportance, findClusters, consolidateCluster, generateBasicSummary, validateSummary, autoConsolidate, applyCommunityAwareFiltering, runHealthChecks, getSearchMisses, reembedMissing, reembedAll, backfillEntities, recalibrateImportance, tuneWeights, getMemoryLineage, getDecisionTimeline, densifyEntityGraph, buildCoRetrievalLinks, suggestTagMerges, applyTagMerge, getSetting, getQualityDistribution, recomputeEntityProfiles, recomputeQualityScores, promoteMemoryTiers } from "@exocortex/core";
import type { ToolRegistrationContext } from "./types.js";

export function registerMemoryMaintenanceTools(ctx: ToolRegistrationContext): void {
  const { server, db, startTime } = ctx;

  // memory_maintenance
  server.tool(
    "memory_maintenance",
    "Run maintenance tasks: importance adjustment, archival, health checks, and optional operations via boolean flags.",
    {
      reembed: z.boolean().optional().describe("Re-embed memories with missing embeddings"),
      backfill_entities: z.boolean().optional().describe("Extract entities from unprocessed memories"),
      recalibrate: z.boolean().optional().describe("Normalize importance via percentile-rank mapping"),
      densify_graph: z.boolean().optional().describe("Create co_occurs relationships between entities"),
      build_co_retrieval_links: z.boolean().optional().describe("Build memory links from co-retrieval patterns"),
      tune_weights: z.boolean().optional().describe("Auto-adjust scoring weights from feedback data"),
      reembed_all: z.boolean().optional().describe("Re-embed ALL memories (model migration)"),
      reembed_all_limit: z.number().optional().describe("Max memories for reembed_all (default 100)"),
      recompute_profiles: z.boolean().optional().describe("Recompute entity profiles (entities with 3+ memories)"),
      recompute_quality: z.boolean().optional().describe("Recompute quality_score for all active memories"),
      auto_consolidate: z.boolean().optional().describe("Auto-merge similar memory clusters"),
      promote_tiers: z.boolean().optional().describe("Auto-promote memories between knowledge tiers"),
      decay_preview: z.boolean().optional().describe("Preview archive candidates (dry-run, no changes)"),
      consolidate: z.boolean().optional().describe("Find and consolidate similar memory clusters"),
      consolidate_min_similarity: z.number().min(0).max(1).optional().describe("Min cosine similarity for clustering (default 0.75)"),
      consolidate_min_cluster_size: z.number().min(2).optional().describe("Min cluster size (default 3)"),
      consolidate_time_bucket: z.enum(["week", "month"]).optional().describe("Constrain clustering to same time window"),
      consolidate_community_aware: z.boolean().optional().describe("Split clusters at community boundaries"),
      consolidate_cluster_index: z.number().min(0).optional().describe("Only process this cluster (0-indexed)"),
      consolidate_dry_run: z.boolean().optional().describe("Preview clusters without merging (default true)"),
      consolidate_summary: z.string().optional().describe("Summary override for targeted consolidation"),
      tag_cleanup: z.boolean().optional().describe("Find and merge near-duplicate tags"),
      tag_cleanup_min_similarity: z.number().min(0).max(1).optional().describe("Min string similarity for tag suggestions (default 0.8)"),
      tag_cleanup_limit: z.number().optional().describe("Max tag suggestions to return (default 20)"),
      tag_cleanup_apply: z.boolean().optional().describe("Apply top suggestion or specified from/to pair"),
      tag_cleanup_from: z.string().optional().describe("Specific tag to merge FROM (with tag_cleanup_apply)"),
      tag_cleanup_to: z.string().optional().describe("Specific tag to merge TO (with tag_cleanup_apply)"),
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
            parts.push(`\nConsolidation: Found ${clusters.length} cluster(s) eligible for consolidation`);
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
              "Consolidation backlog": "Run memory_maintenance with consolidate:true to merge similar memories",
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

        // decay_preview flag
        if (args.decay_preview) {
          try {
            const candidates = getArchiveCandidates(db);
            if (candidates.length === 0) {
              parts.push(`\nDecay preview: no archive candidates found`);
            } else {
              const lines = candidates.map((c) => {
                const preview = c.content.substring(0, 80) + (c.content.length > 80 ? "..." : "");
                return `  [${c.id}] ${preview} (reason: ${c.reason}, importance: ${c.importance}, accesses: ${c.access_count}, created: ${c.created_at})`;
              });
              parts.push(`\nDecay preview (${candidates.length} archive candidates, dry-run):\n${lines.join("\n")}`);
            }
          } catch (err) {
            parts.push(`\nDecay preview: error — ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // consolidate flag
        if (args.consolidate) {
          try {
            // Find raw clusters
            const rawClusters = findClusters(db, {
              minSimilarity: args.consolidate_min_similarity,
              minClusterSize: args.consolidate_min_cluster_size,
              timeBucket: args.consolidate_time_bucket,
            });

            if (rawClusters.length === 0) {
              parts.push(`\nConsolidate: no clusters found eligible for consolidation`);
            } else {
              // Apply community-aware filtering if requested
              let clusters = rawClusters;
              let caResult: ReturnType<typeof applyCommunityAwareFiltering> | undefined;
              if (args.consolidate_community_aware) {
                caResult = applyCommunityAwareFiltering(db, rawClusters, args.consolidate_min_cluster_size ?? 2);
                if (caResult.clusters.length > 0) {
                  clusters = caResult.clusters;
                }
              }

              if (args.consolidate_dry_run !== false) {
                // Dry-run: preview clusters
                let bridgeInfo = "";
                if (args.consolidate_community_aware && caResult) {
                  bridgeInfo = `\n  Community-aware: ${caResult.clustersSplit} cluster(s) split, ${caResult.bridgeMemoryIds.length} bridge memory(ies) protected`;
                  if (caResult.clusters.length === 0) {
                    bridgeInfo += ` — all sub-clusters fell below minClusterSize, using ${rawClusters.length} raw clusters`;
                  }
                }

                const lines = clusters.map((c, i) => {
                  return `  ${i + 1}. [${i}] "${c.topic}" — ${c.memberIds.length} memories (${c.memberIds.join(", ")}), avg similarity: ${c.avgSimilarity.toFixed(2)}`;
                });
                parts.push(`\nConsolidate (dry run, ${clusters.length} clusters):\n${lines.join("\n")}${bridgeInfo}\n  To merge: set consolidate_dry_run:false, consolidate_cluster_index:N, and consolidate_summary:"your synthesis"`);
              } else {
                // Actually consolidate
                let embeddingProvider;
                try {
                  embeddingProvider = await getEmbeddingProvider();
                } catch {
                  // Proceed without embedding
                }

                const toProcess = args.consolidate_cluster_index !== undefined
                  ? [clusters[args.consolidate_cluster_index]].filter(Boolean)
                  : clusters;

                if (toProcess.length === 0) {
                  parts.push(`\nConsolidate: invalid cluster_index ${args.consolidate_cluster_index} (${clusters.length} available)`);
                } else {
                  const results: string[] = [];
                  const skipped: string[] = [];
                  for (const cluster of toProcess) {
                    const summaryContent = (args.consolidate_summary && toProcess.length === 1)
                      ? args.consolidate_summary
                      : generateBasicSummary(db, cluster.memberIds);

                    if (!summaryContent) {
                      skipped.push(`Cluster "${cluster.topic}": empty summary`);
                      continue;
                    }

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
                    ? `\nConsolidate: ${results.length} cluster(s) merged:\n  ${results.join("\n  ")}`
                    : `\nConsolidate: no clusters merged`;
                  if (skipped.length > 0) {
                    text += `\n  Skipped ${skipped.length} (quality validation):\n  ${skipped.join("\n  ")}`;
                  }
                  parts.push(text);
                }
              }
            }
          } catch (err) {
            parts.push(`\nConsolidate: error — ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // tag_cleanup flag
        if (args.tag_cleanup) {
          try {
            if (args.tag_cleanup_apply) {
              if (args.tag_cleanup_from && args.tag_cleanup_to) {
                const result = applyTagMerge(db, args.tag_cleanup_from, args.tag_cleanup_to);
                parts.push(`\nTag cleanup: merged "${args.tag_cleanup_from}" → "${args.tag_cleanup_to}": ${result.updated} tag(s) updated`);
              } else {
                const suggestions = suggestTagMerges(db, {
                  minSimilarity: args.tag_cleanup_min_similarity,
                  limit: 1,
                });
                if (suggestions.length === 0) {
                  parts.push(`\nTag cleanup: no merge suggestions at this similarity threshold`);
                } else {
                  const top = suggestions[0];
                  const result = applyTagMerge(db, top.from, top.to);
                  parts.push(`\nTag cleanup: merged "${top.from}" (${top.fromCount}) → "${top.to}" (${top.toCount}): ${result.updated} tag(s) updated (similarity: ${top.similarity})`);
                }
              }
            } else {
              const suggestions = suggestTagMerges(db, {
                minSimilarity: args.tag_cleanup_min_similarity,
                limit: args.tag_cleanup_limit,
              });

              if (suggestions.length === 0) {
                parts.push(`\nTag cleanup: no near-duplicate tags found`);
              } else {
                const lines = suggestions.map(
                  (s) => `  "${s.from}" (${s.fromCount}) → "${s.to}" (${s.toCount}) — similarity: ${s.similarity}, co-occurrence: ${s.coOccurrence}`
                );
                parts.push(`\nTag cleanup (${suggestions.length} suggestions):\n${lines.join("\n")}\n  To merge: set tag_cleanup_apply:true or specify tag_cleanup_from and tag_cleanup_to`);
              }
            }
          } catch (err) {
            parts.push(`\nTag cleanup: error — ${err instanceof Error ? err.message : String(err)}`);
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

  // memory_timeline
  server.tool(
    "memory_timeline",
    "Query decision history, memory lineage, topic evolution, or temporal hierarchy.",
    {
      mode: z.enum(["decisions", "lineage", "evolution", "hierarchy"]).describe("Timeline mode to query"),
      memory_id: z.string().optional().describe("Memory ID (required for lineage mode)"),
      topic: z.string().optional().describe("Topic to trace (required for evolution mode)"),
      month: z.string().optional().describe("Month filter YYYY-MM (hierarchy mode)"),
      after: z.string().optional().describe("Only after this date (YYYY-MM-DD)"),
      before: z.string().optional().describe("Only before this date (YYYY-MM-DD)"),
      limit: z.number().optional().describe("Max results (default 50)"),
      tags: z.array(z.string()).optional().describe("Tag filters (decisions mode)"),
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
    "Health check — returns memory counts, entity/tag stats, and uptime.",
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
