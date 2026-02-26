import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { QueryOutcome } from "../api/client";
import { useToast } from "../components/Toast";

export function Analytics() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [producerBy, setProducerBy] = useState<"model" | "agent">("model");
  const [trendGranularity, setTrendGranularity] = useState<"month" | "week">(
    "month"
  );

  const { data: summary, isLoading } = useQuery({
    queryKey: ["analytics-summary"],
    queryFn: () => api.getAnalyticsSummary(),
  });

  const { data: qualityDist } = useQuery({
    queryKey: ["analytics-quality-distribution"],
    queryFn: () => api.getQualityDistribution(),
    staleTime: 5 * 60 * 1000,
  });

  const { data: distribution } = useQuery({
    queryKey: ["analytics-distribution"],
    queryFn: () => api.getAccessDistribution(),
  });

  const { data: tags } = useQuery({
    queryKey: ["analytics-tags"],
    queryFn: () => api.getTagEffectiveness(),
  });

  const { data: producers } = useQuery({
    queryKey: ["analytics-producers", producerBy],
    queryFn: () => api.getProducerQuality(producerBy),
  });

  const { data: trend } = useQuery({
    queryKey: ["analytics-trend", trendGranularity],
    queryFn: () => api.getQualityTrend(trendGranularity),
  });

  const { data: decayPreview } = useQuery({
    queryKey: ["analytics-decay-preview"],
    queryFn: () => api.getDecayPreview(),
    staleTime: 5 * 60 * 1000,
  });

  const { data: tagHealth } = useQuery({
    queryKey: ["analytics-tag-health"],
    queryFn: () => api.getTagHealth(),
    staleTime: 5 * 60 * 1000,
  });

  const { data: knowledgeGaps } = useQuery({
    queryKey: ["analytics-knowledge-gaps"],
    queryFn: () => api.getKnowledgeGaps(),
    staleTime: 5 * 60 * 1000,
  });

  const { data: regressionLatest } = useQuery({
    queryKey: ["regression-latest"],
    queryFn: () => api.getRegressionLatest(),
    staleTime: 5 * 60 * 1000,
  });

  const { data: queryOutcomes } = useQuery({
    queryKey: ["analytics-query-outcomes"],
    queryFn: () => api.getQueryOutcomes(),
    staleTime: 5 * 60 * 1000,
  });

  const consolidateMutation = useMutation({
    mutationFn: () => api.triggerAutoConsolidate(),
    onSuccess: (data) => {
      toast(`Consolidated ${data.clustersConsolidated} clusters (${data.memoriesMerged} memories)`, "success");
      queryClient.invalidateQueries({ queryKey: ["analytics-consolidation-preview"] });
      queryClient.invalidateQueries({ queryKey: ["analytics-summary"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
    },
    onError: (err) => toast((err as Error).message, "error"),
  });

  const { data: consolidationPreview } = useQuery({
    queryKey: ["analytics-consolidation-preview"],
    queryFn: () => api.getConsolidationPreview(),
    staleTime: 10 * 60 * 1000,
  });

  if (isLoading)
    return (
      <div className="loading">
        <div className="spinner" />
        <span>Loading...</span>
      </div>
    );

  const maxDistCount = distribution
    ? Math.max(...distribution.map((b) => b.count), 1)
    : 1;

  return (
    <div>
      <h1>Analytics</h1>
      <p style={{ color: "#8080a0", fontSize: 13, marginBottom: 24 }}>
        Memory quality and usage insights
      </p>

      {/* Quality distribution */}
      {qualityDist && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: 14,
            marginBottom: 14,
          }}
        >
          <StatCard label="Avg Quality" value={qualityDist.avg.toFixed(3)} accent="#a78bfa" />
          <StatCard label="Median Quality" value={qualityDist.median.toFixed(3)} accent="#a78bfa" />
          <StatCard label="P10" value={qualityDist.p10.toFixed(3)} accent="#f87171" />
          <StatCard label="P90" value={qualityDist.p90.toFixed(3)} accent="#34d399" />
          <StatCard label="High Quality" value={qualityDist.highQuality} accent="#22d3ee" />
          <StatCard label="Low Quality" value={qualityDist.lowQuality} accent="#f59e0b" />
        </div>
      )}

      {/* Stat cards */}
      {summary && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: 14,
            marginBottom: 32,
          }}
        >
          <StatCard
            label="Never Accessed"
            value={`${summary.neverAccessedPct}%`}
            accent="#f59e0b"
          />
          <StatCard
            label="Useful"
            value={`${summary.usefulPct}%`}
            accent="#22d3ee"
          />
          <StatCard
            label="Median Accesses"
            value={summary.medianAccessCount}
            accent="#34d399"
          />
        </div>
      )}

      {/* Access distribution */}
      {distribution && (
        <Section title="Access Distribution">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {distribution.map((b) => (
              <div
                key={b.label}
                style={{ display: "flex", alignItems: "center", gap: 12 }}
              >
                <span
                  style={{
                    width: 60,
                    textAlign: "right",
                    fontSize: 13,
                    color: "#a0a0be",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {b.label}
                </span>
                <div
                  style={{
                    flex: 1,
                    height: 22,
                    background: "rgba(34, 211, 238, 0.06)",
                    borderRadius: 4,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${(b.count / maxDistCount) * 100}%`,
                      height: "100%",
                      background:
                        "linear-gradient(90deg, rgba(34, 211, 238, 0.4), rgba(34, 211, 238, 0.2))",
                      borderRadius: 4,
                      minWidth: b.count > 0 ? 2 : 0,
                    }}
                  />
                </div>
                <span
                  style={{
                    width: 50,
                    fontSize: 13,
                    color: "#e8e8f4",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {b.count}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Tag effectiveness */}
      {tags && tags.length > 0 && (
        <Section title="Tag Effectiveness">
          <Table
            headers={["Tag", "Memories", "Avg Useful"]}
            rows={tags.map((t) => [
              t.tag,
              String(t.memoryCount),
              t.avgUsefulCount.toFixed(2),
            ])}
          />
        </Section>
      )}

      {/* Producer quality */}
      {producers && producers.length > 0 && (
        <Section
          title="Producer Quality"
          actions={
            <Toggle
              options={["model", "agent"]}
              active={producerBy}
              onChange={(v) => setProducerBy(v as "model" | "agent")}
            />
          }
        >
          <Table
            headers={[producerBy === "model" ? "Model" : "Agent", "Memories", "Avg Useful"]}
            rows={producers.map((p) => [
              p.producer,
              String(p.memoryCount),
              p.avgUsefulCount.toFixed(2),
            ])}
          />
        </Section>
      )}

      {/* Quality trend */}
      {trend && trend.length > 0 && (
        <Section
          title="Quality Trend"
          actions={
            <Toggle
              options={["month", "week"]}
              active={trendGranularity}
              onChange={(v) =>
                setTrendGranularity(v as "month" | "week")
              }
            />
          }
        >
          <Table
            headers={["Period", "Created", "Avg Useful", "Never Accessed %"]}
            rows={trend.map((t) => [
              t.period,
              String(t.created),
              t.avgUseful.toFixed(2),
              `${t.neverAccessedPct}%`,
            ])}
          />
        </Section>
      )}

      {/* Decay preview */}
      {decayPreview && decayPreview.candidates.length > 0 && (
        <Section title={`Decay Candidates (${decayPreview.total})`}>
          <Table
            headers={["Content", "Importance", "Accesses", "Reason", "Created"]}
            rows={decayPreview.candidates.slice(0, 20).map((c) => [
              c.content,
              c.importance.toFixed(2),
              String(c.access_count),
              c.reason,
              c.created_at.slice(0, 10),
            ])}
          />
        </Section>
      )}

      {/* Tag health */}
      {tagHealth && (
        <Section title="Tag Health">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 14,
              marginBottom: 14,
            }}
          >
            <StatCard label="Total Tags" value={tagHealth.totalTags} accent="#22d3ee" />
            <StatCard label="Alias Merges" value={tagHealth.mergeCount} accent="#a78bfa" />
          </div>
          {tagHealth.suggestions.length > 0 && (
            <Table
              headers={["From", "To", "Similarity", "From Count", "To Count"]}
              rows={tagHealth.suggestions.map((s) => [
                s.from,
                s.to,
                s.similarity.toFixed(2),
                String(s.fromCount),
                String(s.toCount),
              ])}
            />
          )}
        </Section>
      )}

      {/* Knowledge Gaps */}
      {knowledgeGaps && knowledgeGaps.length > 0 && (
        <Section title="Knowledge Gaps (14d)">
          <div
            style={{
              border: "1px solid #16163a",
              borderRadius: 8,
              overflow: "hidden",
            }}
          >
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 13,
              }}
            >
              <thead>
                <tr>
                  {["Query", "Occurrences", "Avg Max Score", "Last Seen", "Severity"].map((h) => (
                    <th
                      key={h}
                      style={{
                        textAlign: "left",
                        padding: "10px 14px",
                        color: "#8080a0",
                        fontWeight: 500,
                        fontSize: 12,
                        borderBottom: "1px solid #16163a",
                        background: "rgba(8, 8, 26, 0.4)",
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {knowledgeGaps.map((g, i) => (
                  <tr key={i}>
                    <td style={{ padding: "8px 14px", color: "#e8e8f4", borderBottom: i < knowledgeGaps.length - 1 ? "1px solid #0d0d24" : "none" }}>{g.query}</td>
                    <td style={{ padding: "8px 14px", color: "#a0a0be", fontFamily: "var(--font-mono)", borderBottom: i < knowledgeGaps.length - 1 ? "1px solid #0d0d24" : "none" }}>{g.count}</td>
                    <td style={{ padding: "8px 14px", color: "#a0a0be", fontFamily: "var(--font-mono)", borderBottom: i < knowledgeGaps.length - 1 ? "1px solid #0d0d24" : "none" }}>{g.avg_max_score !== null ? g.avg_max_score.toFixed(4) : "\u2014"}</td>
                    <td style={{ padding: "8px 14px", color: "#a0a0be", fontFamily: "var(--font-mono)", borderBottom: i < knowledgeGaps.length - 1 ? "1px solid #0d0d24" : "none" }}>{g.last_seen.slice(0, 10)}</td>
                    <td style={{ padding: "8px 14px", borderBottom: i < knowledgeGaps.length - 1 ? "1px solid #0d0d24" : "none" }}>
                      <span style={{
                        padding: "2px 10px",
                        borderRadius: 12,
                        fontSize: 11,
                        fontWeight: 600,
                        background: g.severity === "critical" ? "rgba(248, 113, 113, 0.15)" : g.severity === "warning" ? "rgba(245, 158, 11, 0.15)" : "rgba(128, 128, 160, 0.15)",
                        color: g.severity === "critical" ? "#f87171" : g.severity === "warning" ? "#f59e0b" : "#8080a0",
                      }}>
                        {g.severity}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* Query Effectiveness */}
      {queryOutcomes && queryOutcomes.length > 0 && (
        <Section title="Query Effectiveness">
          <div
            style={{
              border: "1px solid #16163a",
              borderRadius: 8,
              overflow: "hidden",
            }}
          >
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 13,
              }}
            >
              <thead>
                <tr>
                  {["Query", "Searches", "Avg Results", "Feedback", "Success %"].map((h) => (
                    <th
                      key={h}
                      style={{
                        textAlign: "left",
                        padding: "10px 14px",
                        color: "#8080a0",
                        fontWeight: 500,
                        fontSize: 12,
                        borderBottom: "1px solid #16163a",
                        background: "rgba(8, 8, 26, 0.4)",
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {queryOutcomes.map((q: QueryOutcome, i: number) => (
                  <tr key={i}>
                    <td style={{ padding: "8px 14px", color: "#e8e8f4", maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", borderBottom: i < queryOutcomes.length - 1 ? "1px solid #0d0d24" : "none" }}>{q.query}</td>
                    <td style={{ padding: "8px 14px", color: "#a0a0be", fontFamily: "var(--font-mono)", borderBottom: i < queryOutcomes.length - 1 ? "1px solid #0d0d24" : "none" }}>{q.search_count}</td>
                    <td style={{ padding: "8px 14px", color: "#a0a0be", fontFamily: "var(--font-mono)", borderBottom: i < queryOutcomes.length - 1 ? "1px solid #0d0d24" : "none" }}>{q.result_count_avg}</td>
                    <td style={{ padding: "8px 14px", color: "#a0a0be", fontFamily: "var(--font-mono)", borderBottom: i < queryOutcomes.length - 1 ? "1px solid #0d0d24" : "none" }}>{q.feedback_count}</td>
                    <td style={{ padding: "8px 14px", borderBottom: i < queryOutcomes.length - 1 ? "1px solid #0d0d24" : "none" }}>
                      <span style={{
                        color: q.feedback_ratio > 50 ? "#34d399" : q.feedback_ratio >= 10 ? "#f59e0b" : "#f87171",
                        fontFamily: "var(--font-mono)",
                        fontWeight: 500,
                      }}>
                        {q.feedback_ratio}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* Retrieval Regression */}
      {regressionLatest && (
        <Section title="Retrieval Regression">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: 14,
              marginBottom: 14,
            }}
          >
            <StatCard
              label="Golden Queries"
              value={regressionLatest.golden_count}
              accent="#22d3ee"
            />
            <StatCard
              label="Last Run Alerts"
              value={regressionLatest.results.filter((r) => r.alert).length}
              accent={regressionLatest.results.some((r) => r.alert) ? "#f87171" : "#34d399"}
            />
            <StatCard
              label="Avg Overlap@10"
              value={
                regressionLatest.results.length > 0
                  ? (regressionLatest.results.reduce((s, r) => s + r.overlap_at_10, 0) / regressionLatest.results.length).toFixed(2)
                  : "\u2014"
              }
              accent="#a78bfa"
            />
          </div>
          {regressionLatest.results.length > 0 ? (
            <div
              style={{
                border: "1px solid #16163a",
                borderRadius: 8,
                overflow: "hidden",
              }}
            >
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 13,
                }}
              >
                <thead>
                  <tr>
                    {["Query", "Overlap@10", "Avg Rank Shift", "Exact Order", "Alert"].map((h) => (
                      <th
                        key={h}
                        style={{
                          textAlign: "left",
                          padding: "10px 14px",
                          color: "#8080a0",
                          fontWeight: 500,
                          fontSize: 12,
                          borderBottom: "1px solid #16163a",
                          background: "rgba(8, 8, 26, 0.4)",
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {regressionLatest.results.map((r, i) => (
                    <tr key={i}>
                      <td style={{ padding: "8px 14px", color: "#e8e8f4", borderBottom: i < regressionLatest.results.length - 1 ? "1px solid #0d0d24" : "none" }}>{r.query}</td>
                      <td style={{ padding: "8px 14px", color: "#a0a0be", fontFamily: "var(--font-mono)", borderBottom: i < regressionLatest.results.length - 1 ? "1px solid #0d0d24" : "none" }}>{r.overlap_at_10.toFixed(2)}</td>
                      <td style={{ padding: "8px 14px", color: "#a0a0be", fontFamily: "var(--font-mono)", borderBottom: i < regressionLatest.results.length - 1 ? "1px solid #0d0d24" : "none" }}>{r.avg_rank_shift.toFixed(2)}</td>
                      <td style={{ padding: "8px 14px", borderBottom: i < regressionLatest.results.length - 1 ? "1px solid #0d0d24" : "none" }}>
                        <span style={{ color: r.exact_order ? "#34d399" : "#f87171" }}>{r.exact_order ? "\u2713" : "\u2717"}</span>
                      </td>
                      <td style={{ padding: "8px 14px", borderBottom: i < regressionLatest.results.length - 1 ? "1px solid #0d0d24" : "none" }}>
                        <span style={{ color: r.alert ? "#f87171" : "#34d399", fontWeight: r.alert ? 600 : 400 }}>{r.alert ? "ALERT" : "OK"}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ color: "#8080a0", fontSize: 13 }}>No regression runs yet</div>
          )}
        </Section>
      )}

      {/* Consolidation preview */}
      {consolidationPreview && consolidationPreview.clusters.length > 0 && (
        <Section
          title={`Consolidation Candidates (${consolidationPreview.clusters.length})`}
          actions={
            <button
              onClick={() => consolidateMutation.mutate()}
              disabled={consolidateMutation.isPending}
              style={{
                padding: "4px 12px",
                fontSize: 12,
                border: "1px solid rgba(34, 211, 238, 0.3)",
                borderRadius: 6,
                cursor: consolidateMutation.isPending ? "wait" : "pointer",
                background: "rgba(34, 211, 238, 0.15)",
                color: "#22d3ee",
                fontFamily: "var(--font-mono)",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                opacity: consolidateMutation.isPending ? 0.6 : 1,
              }}
            >
              {consolidateMutation.isPending && <span className="spinner" style={{ width: 12, height: 12 }} />}
              {consolidateMutation.isPending ? "Running..." : "Run Now"}
            </button>
          }
        >
          <Table
            headers={["Topic", "Members", "Avg Similarity"]}
            rows={consolidationPreview.clusters.map((cl) => [
              cl.topic,
              String(cl.memberIds.length),
              cl.avgSimilarity.toFixed(3),
            ])}
          />
        </Section>
      )}
    </div>
  );
}

// --- Shared components ---

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent: string;
}) {
  return (
    <div
      style={{
        background: "rgba(8, 8, 26, 0.6)",
        border: "1px solid #16163a",
        borderRadius: 10,
        padding: "16px 20px",
      }}
    >
      <div style={{ fontSize: 12, color: "#8080a0", marginBottom: 6 }}>
        {label}
      </div>
      <div
        style={{
          fontSize: 26,
          fontWeight: 700,
          color: accent,
          fontFamily: "var(--font-mono)",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function Section({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <h2 style={{ fontSize: 16, fontWeight: 600, color: "#e8e8f4", margin: 0 }}>
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </div>
  );
}

function Toggle({
  options,
  active,
  onChange,
}: {
  options: string[];
  active: string;
  onChange: (v: string) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 2,
        background: "rgba(8, 8, 26, 0.6)",
        borderRadius: 6,
        padding: 2,
        border: "1px solid #16163a",
      }}
    >
      {options.map((opt) => (
        <button
          key={opt}
          onClick={() => onChange(opt)}
          style={{
            padding: "4px 12px",
            fontSize: 12,
            border: "none",
            borderRadius: 4,
            cursor: "pointer",
            background:
              active === opt ? "rgba(34, 211, 238, 0.15)" : "transparent",
            color: active === opt ? "#22d3ee" : "#8080a0",
            fontFamily: "var(--font-mono)",
          }}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

function Table({
  headers,
  rows,
}: {
  headers: string[];
  rows: string[][];
}) {
  return (
    <div
      style={{
        border: "1px solid #16163a",
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 13,
        }}
      >
        <thead>
          <tr>
            {headers.map((h) => (
              <th
                key={h}
                style={{
                  textAlign: "left",
                  padding: "10px 14px",
                  color: "#8080a0",
                  fontWeight: 500,
                  fontSize: 12,
                  borderBottom: "1px solid #16163a",
                  background: "rgba(8, 8, 26, 0.4)",
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td
                  key={j}
                  style={{
                    padding: "8px 14px",
                    color: j === 0 ? "#e8e8f4" : "#a0a0be",
                    fontFamily: j > 0 ? "var(--font-mono)" : undefined,
                    borderBottom:
                      i < rows.length - 1 ? "1px solid #0d0d24" : "none",
                  }}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
