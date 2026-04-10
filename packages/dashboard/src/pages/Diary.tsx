import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type DiaryEntry } from "../api/client";
import { timeAgo } from "../utils/format";

const TOPIC_COLORS: Record<string, string> = {
  general: "var(--text-muted)",
  reflection: "var(--cyan)",
  learning: "var(--emerald)",
  decision: "var(--amber)",
  discovery: "var(--purple)",
  planning: "var(--sky)",
  error: "var(--red)",
};

export function Diary() {
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [topicFilter, setTopicFilter] = useState<string | null>(null);

  const { data: agentsData, isLoading: agentsLoading } = useQuery({
    queryKey: ["diary-agents"],
    queryFn: () => api.getDiaryAgents(),
  });

  const { data: entriesData, isLoading: entriesLoading } = useQuery({
    queryKey: ["diary-entries", selectedAgent, topicFilter],
    queryFn: () => api.getDiaryEntries(selectedAgent!, {
      topic: topicFilter ?? undefined,
      limit: 50,
    }),
    enabled: !!selectedAgent,
  });

  const agents = agentsData?.agents ?? [];
  const entries = entriesData?.entries ?? [];

  // Collect unique topics from entries
  const topics = [...new Set(entries.map((e) => e.topic))].sort();

  if (agentsLoading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <span>Loading diary...</span>
      </div>
    );
  }

  return (
    <div style={{ animation: "slideUp 0.3s ease-out both" }}>
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: "var(--text-primary-alt)", marginBottom: 4 }}>Diary</h1>
        <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>Agent session journals and reflections</p>
      </div>

      {/* Agent selector */}
      {agents.length === 0 ? (
        <div style={{ textAlign: "center", padding: 40, color: "var(--text-muted)" }}>
          No diary entries yet. Agents write diary entries after sessions.
        </div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
            {agents.map((a) => (
              <button
                key={a.agent}
                onClick={() => { setSelectedAgent(a.agent); setTopicFilter(null); }}
                style={{
                  background: selectedAgent === a.agent ? "var(--cyan-bg)" : "var(--bg-surface)",
                  color: selectedAgent === a.agent ? "var(--cyan)" : "var(--text-body)",
                  border: `1px solid ${selectedAgent === a.agent ? "var(--cyan-border)" : "var(--border-subtle)"}`,
                  borderRadius: 8,
                  padding: "8px 16px",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                  transition: "all 0.15s",
                }}
              >
                {a.agent}
                <span style={{ fontSize: 11, color: "var(--text-muted)", marginLeft: 8, fontWeight: 400 }}>
                  {a.entries} entries
                </span>
              </button>
            ))}
          </div>

          {/* Topic filter */}
          {selectedAgent && topics.length > 1 && (
            <div style={{ display: "flex", gap: 4, marginBottom: 20 }}>
              <button
                onClick={() => setTopicFilter(null)}
                style={{
                  background: !topicFilter ? "var(--cyan-bg)" : "transparent",
                  color: !topicFilter ? "var(--cyan)" : "var(--text-muted)",
                  border: `1px solid ${!topicFilter ? "var(--cyan-border)" : "transparent"}`,
                  borderRadius: 20,
                  padding: "5px 14px",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                all
              </button>
              {topics.map((t) => (
                <button
                  key={t}
                  onClick={() => setTopicFilter(t)}
                  style={{
                    background: topicFilter === t ? "var(--cyan-bg)" : "transparent",
                    color: topicFilter === t ? (TOPIC_COLORS[t] ?? "var(--cyan)") : "var(--text-muted)",
                    border: `1px solid ${topicFilter === t ? "var(--cyan-border)" : "transparent"}`,
                    borderRadius: 20,
                    padding: "5px 14px",
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  {t}
                </button>
              ))}
            </div>
          )}

          {/* Entries */}
          {selectedAgent && entriesLoading && (
            <div className="loading">
              <div className="spinner" />
              <span>Loading entries...</span>
            </div>
          )}

          {selectedAgent && !entriesLoading && entries.length === 0 && (
            <div style={{ textAlign: "center", padding: 40, color: "var(--text-muted)" }}>
              No entries{topicFilter ? ` for topic "${topicFilter}"` : ""}.
            </div>
          )}

          {selectedAgent && entries.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {entries.map((e: DiaryEntry) => (
                <div
                  key={e.id}
                  style={{
                    background: "var(--bg-surface)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: 10,
                    padding: "14px 18px",
                    borderLeft: `3px solid ${TOPIC_COLORS[e.topic] ?? "var(--border-subtle)"}`,
                  }}
                >
                  {/* Entry header */}
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                    <span style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: TOPIC_COLORS[e.topic] ?? "var(--text-muted)",
                      textTransform: "capitalize",
                    }}>
                      {e.topic}
                    </span>
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      {timeAgo(e.created_at)}
                    </span>
                    <span style={{ fontSize: 10, color: "var(--text-muted)", opacity: 0.5, fontFamily: "var(--font-mono)" }}>
                      {e.id}
                    </span>
                  </div>

                  {/* Entry content */}
                  <div style={{
                    fontSize: 13,
                    color: "var(--text-body)",
                    lineHeight: 1.7,
                    whiteSpace: "pre-wrap",
                  }}>
                    {e.entry}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
