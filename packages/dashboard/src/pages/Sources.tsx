import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { TIER_COLORS } from "../constants/colors";

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
      <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 24 }}>
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
          accent="var(--cyan)"
        />
        <StatCard
          label="Active"
          value={stats.active_memories}
          accent="var(--cyan)"
        />
        <StatCard
          label="Entities"
          value={stats.total_entities}
          accent="var(--emerald)"
        />
        <StatCard
          label="Tags"
          value={stats.total_tags}
          accent="var(--amber)"
        />
      </div>

      {/* By Knowledge Tier */}
      {stats.by_tier && Object.keys(stats.by_tier).length > 0 && (
        <div
          style={{
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            borderRadius: 12,
            padding: 20,
            marginBottom: 16,
          }}
        >
          <h2 style={{ marginBottom: 16 }}>By Knowledge Tier</h2>
          <TierChart data={stats.by_tier} />
        </div>
      )}

      {/* By Content Type */}
      <div
        style={{
          background: "var(--bg-surface)",
          border: "1px solid var(--border-subtle)",
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
          background: "var(--bg-surface)",
          border: "1px solid var(--border-subtle)",
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
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
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
            color: "var(--text-muted)",
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
        background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
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
          color: "var(--text-primary-alt)",
        }}
      >
        {value.toLocaleString()}
      </div>
      <div style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 2 }}>
        {label}
      </div>
    </div>
  );
}

function BarChart({ data }: { data: Record<string, number> }) {
  const entries = Object.entries(data).sort(([, a], [, b]) => b - a);
  if (entries.length === 0)
    return <p style={{ color: "var(--text-muted)", fontSize: 13 }}>None yet.</p>;

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

const TIER_DESCRIPTIONS: Record<string, string> = {
  working: "Scratch — expires 24h",
  episodic: "Conversations & events",
  semantic: "Permanent facts",
  procedural: "Techniques & how-to",
  reference: "Documents & library",
};

const TIER_ORDER = ["episodic", "semantic", "procedural", "reference", "working"];

function TierChart({ data }: { data: Record<string, number> }) {
  const entries = TIER_ORDER
    .filter((t) => data[t] != null)
    .map((t) => [t, data[t]] as [string, number]);
  if (entries.length === 0)
    return <p style={{ color: "var(--text-muted)", fontSize: 13 }}>None yet.</p>;

  const max = Math.max(...entries.map(([, v]) => v));

  return (
    <div>
      {entries.map(([tier, count]) => (
        <div key={tier} className="bar-row">
          <span className="bar-label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: TIER_COLORS[tier] ?? "var(--text-muted)",
                flexShrink: 0,
              }}
            />
            {tier}
          </span>
          <div className="bar-track">
            <div
              className="bar-fill"
              style={{
                width: `${(count / max) * 100}%`,
                background: `linear-gradient(90deg, ${TIER_COLORS[tier] ?? "var(--cyan)"}, transparent)`,
              }}
            />
          </div>
          <span className="bar-value" title={TIER_DESCRIPTIONS[tier]}>
            {count}
          </span>
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
          color: "var(--text-primary-alt)",
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{label}</div>
    </div>
  );
}
