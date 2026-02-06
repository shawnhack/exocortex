import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

export function Dashboard() {
  const { data: stats, isLoading } = useQuery({
    queryKey: ["stats"],
    queryFn: () => api.getStats(),
  });

  const { data: temporal } = useQuery({
    queryKey: ["temporal-stats"],
    queryFn: () => api.getTemporalStats(),
  });

  if (isLoading)
    return (
      <div className="loading">
        <div className="spinner" />
        <span>Loading...</span>
      </div>
    );

  if (!stats) return null;

  return (
    <div>
      <h1>Dashboard</h1>
      <p style={{ color: "#8080a0", fontSize: 13, marginBottom: 24 }}>
        Memory storage overview
      </p>

      {/* Stat cards grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 14,
          marginBottom: 32,
        }}
      >
        <StatCard
          label="Total Memories"
          value={stats.total_memories}
          accent="#8b5cf6"
        />
        <StatCard
          label="Active"
          value={stats.active_memories}
          accent="#22d3ee"
        />
        <StatCard
          label="Entities"
          value={stats.total_entities}
          accent="#34d399"
        />
        <StatCard
          label="Tags"
          value={stats.total_tags}
          accent="#fbbf24"
        />
      </div>

      {/* By Content Type */}
      <div
        style={{
          background: "#0c0c1d",
          border: "1px solid #16163a",
          borderRadius: 12,
          padding: 20,
          marginBottom: 16,
        }}
      >
        <h2 style={{ marginBottom: 16 }}>By Content Type</h2>
        <BarChart data={stats.by_content_type} />
      </div>

      {/* By Source */}
      <div
        style={{
          background: "#0c0c1d",
          border: "1px solid #16163a",
          borderRadius: 12,
          padding: 20,
          marginBottom: 16,
        }}
      >
        <h2 style={{ marginBottom: 16 }}>By Source</h2>
        <BarChart data={stats.by_source} />
      </div>

      {/* Temporal stats */}
      {temporal && (
        <div
          style={{
            background: "#0c0c1d",
            border: "1px solid #16163a",
            borderRadius: 12,
            padding: 20,
            marginBottom: 16,
          }}
        >
          <h2 style={{ marginBottom: 16 }}>Temporal</h2>
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
            <TemporalStat label="Days Active" value={String(temporal.total_days)} />
            <TemporalStat label="Avg / Day" value={temporal.avg_per_day.toFixed(1)} />
            <TemporalStat label="Current Streak" value={`${temporal.streak_current}d`} />
            <TemporalStat label="Longest Streak" value={`${temporal.streak_longest}d`} />
          </div>
        </div>
      )}

      {/* Date range */}
      {stats.oldest_memory && (
        <p
          style={{
            color: "#8080a0",
            fontSize: 12,
            fontFamily: "var(--font-mono)",
            marginTop: 16,
          }}
        >
          {stats.oldest_memory} &rarr; {stats.newest_memory}
        </p>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent: string;
}) {
  return (
    <div
      style={{
        background: "#0c0c1d",
        border: "1px solid #16163a",
        borderRadius: 12,
        padding: 20,
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Subtle gradient accent */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 2,
          background: `linear-gradient(90deg, ${accent}, transparent)`,
          opacity: 0.6,
        }}
      />
      <div
        style={{
          fontSize: 32,
          fontWeight: 700,
          fontFamily: "var(--font-mono)",
          color: "#e8e8f4",
        }}
      >
        {value.toLocaleString()}
      </div>
      <div style={{ color: "#8080a0", fontSize: 13, marginTop: 2 }}>
        {label}
      </div>
    </div>
  );
}

function BarChart({ data }: { data: Record<string, number> }) {
  const entries = Object.entries(data).sort(([, a], [, b]) => b - a);
  if (entries.length === 0)
    return <p style={{ color: "#8080a0", fontSize: 13 }}>None yet.</p>;

  const max = Math.max(...entries.map(([, v]) => v));

  return (
    <div>
      {entries.map(([key, count]) => (
        <div key={key} className="bar-row">
          <span className="bar-label">{key}</span>
          <div className="bar-track">
            <div
              className="bar-fill"
              style={{ width: `${(count / max) * 100}%` }}
            />
          </div>
          <span className="bar-value">{count}</span>
        </div>
      ))}
    </div>
  );
}

function TemporalStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        style={{
          fontSize: 20,
          fontWeight: 600,
          fontFamily: "var(--font-mono)",
          color: "#e8e8f4",
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 12, color: "#8080a0" }}>{label}</div>
    </div>
  );
}
