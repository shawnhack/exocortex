import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

export function Analytics() {
  const [producerBy, setProducerBy] = useState<"model" | "agent">("model");
  const [trendGranularity, setTrendGranularity] = useState<"month" | "week">(
    "month"
  );

  const { data: summary, isLoading } = useQuery({
    queryKey: ["analytics-summary"],
    queryFn: () => api.getAnalyticsSummary(),
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
