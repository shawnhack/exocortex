import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { HierarchyEpoch, HierarchyTheme } from "../api/client";

function getMonthOptions(): string[] {
  const months: string[] = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
    );
  }
  return months;
}

export function Timeline() {
  const [month, setMonth] = useState<string>("");
  const months = getMonthOptions();

  const { data, isLoading } = useQuery({
    queryKey: ["hierarchy", month],
    queryFn: () =>
      api.getHierarchy(month ? { month } : { maxEpisodes: 15 }),
  });

  if (isLoading)
    return (
      <div className="loading">
        <div className="spinner" />
        <span>Loading...</span>
      </div>
    );

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 24,
        }}
      >
        <div>
          <h1>Timeline</h1>
          <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>
            Epoch &rarr; Theme &rarr; Episode hierarchy
          </p>
        </div>
        <select
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          style={{
            background: "var(--bg-overlay-medium)",
            border: "1px solid var(--border-subtle)",
            color: "var(--text-primary-alt)",
            padding: "6px 12px",
            borderRadius: 6,
            fontSize: 13,
            fontFamily: "var(--font-mono)",
          }}
        >
          <option value="">All time</option>
          {months.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      {data && data.epochs.length === 0 && data.orphan_themes.length === 0 && (
        <div style={{ color: "var(--text-muted)", padding: 40, textAlign: "center" }}>
          No epochs or narratives found
          {month ? ` for ${month}` : ""}.
        </div>
      )}

      {data?.epochs.map((epoch) => (
        <EpochCard key={epoch.id} epoch={epoch} />
      ))}

      {data && data.orphan_themes.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <h2
            style={{
              fontSize: 14,
              color: "var(--text-muted)",
              fontWeight: 500,
              marginBottom: 12,
            }}
          >
            Themes without epoch
          </h2>
          {data.orphan_themes.map((theme) => (
            <ThemeCard key={theme.id} theme={theme} />
          ))}
        </div>
      )}
    </div>
  );
}

function EpochCard({ epoch }: { epoch: HierarchyEpoch }) {
  const [expanded, setExpanded] = useState(true);
  const preview =
    epoch.content.length > 200
      ? epoch.content.substring(0, 197) + "..."
      : epoch.content;

  return (
    <div
      style={{
        marginBottom: 20,
        border: "1px solid var(--border-mid)",
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          width: "100%",
          background: "var(--cyan-bg-subtle)",
          border: "none",
          padding: "14px 18px",
          cursor: "pointer",
          display: "flex",
          alignItems: "flex-start",
          gap: 12,
          textAlign: "left",
        }}
      >
        <span
          style={{
            color: "var(--cyan)",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            flexShrink: 0,
            marginTop: 2,
          }}
        >
          {expanded ? "v" : ">"}
        </span>
        <div style={{ flex: 1 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 4,
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                color: "var(--cyan)",
                background: "var(--cyan-bg-active)",
                padding: "2px 8px",
                borderRadius: 4,
              }}
            >
              EPOCH {epoch.month}
            </span>
            <span
              style={{
                fontSize: 11,
                color: "var(--text-muted)",
                fontFamily: "var(--font-mono)",
              }}
            >
              {epoch.themes.length} themes
            </span>
          </div>
          <div style={{ color: "var(--text-body-light)", fontSize: 13, lineHeight: 1.5 }}>
            {preview}
          </div>
        </div>
      </button>

      {expanded && (
        <div style={{ padding: "0 18px 14px", paddingLeft: 42 }}>
          {epoch.themes.map((theme) => (
            <ThemeCard key={theme.id} theme={theme} />
          ))}
          {epoch.themes.length === 0 && (
            <div
              style={{ color: "var(--text-muted)", fontSize: 12, padding: "8px 0" }}
            >
              No themes in this epoch
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ThemeCard({ theme }: { theme: HierarchyTheme }) {
  const [expanded, setExpanded] = useState(false);
  const preview =
    theme.content.length > 150
      ? theme.content.substring(0, 147) + "..."
      : theme.content;

  return (
    <div
      style={{
        marginTop: 8,
        border: "1px solid var(--border-subtle)",
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          width: "100%",
          background: "var(--emerald-bg-subtle)",
          border: "none",
          padding: "10px 14px",
          cursor: "pointer",
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
          textAlign: "left",
        }}
      >
        <span
          style={{
            color: "var(--emerald)",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            flexShrink: 0,
            marginTop: 2,
          }}
        >
          {expanded ? "v" : ">"}
        </span>
        <div style={{ flex: 1 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 3,
            }}
          >
            <span
              style={{
                fontSize: 10,
                fontFamily: "var(--font-mono)",
                color: "var(--emerald)",
                background: "var(--emerald-bg-active)",
                padding: "1px 6px",
                borderRadius: 3,
              }}
            >
              THEME
            </span>
            {theme.linked && (
              <span style={{ fontSize: 11, color: "var(--text-muted)" }} title="Explicitly linked">
                ~
              </span>
            )}
            <span
              style={{
                fontSize: 11,
                color: "var(--text-muted)",
                fontFamily: "var(--font-mono)",
              }}
            >
              {theme.episodes.length} episodes
            </span>
          </div>
          <div style={{ color: "var(--text-body-dim)", fontSize: 12, lineHeight: 1.5 }}>
            {preview}
          </div>
        </div>
      </button>

      {expanded && theme.episodes.length > 0 && (
        <div style={{ padding: "4px 14px 10px", paddingLeft: 38 }}>
          {theme.episodes.map((ep) => (
            <div
              key={ep.id}
              style={{
                padding: "6px 0",
                borderBottom: "1px solid var(--border-inner)",
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
              }}
            >
              <Link
                to={`/memory/${ep.id}`}
                style={{
                  color: "var(--text-secondary-alt)",
                  fontSize: 12,
                  textDecoration: "none",
                  lineHeight: 1.5,
                  flex: 1,
                }}
              >
                {ep.content.length > 100
                  ? ep.content.substring(0, 97) + "..."
                  : ep.content}
              </Link>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  flexShrink: 0,
                }}
              >
                {ep.linked && (
                  <span
                    style={{ fontSize: 11, color: "var(--text-muted)" }}
                    title="Explicitly linked"
                  >
                    ~
                  </span>
                )}
                <span
                  style={{
                    fontSize: 10,
                    fontFamily: "var(--font-mono)",
                    color: "var(--text-muted)",
                  }}
                >
                  {ep.importance.toFixed(1)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
